/**
 * Alpaca trading engine.
 * Paper trading by default (ALPACA_BASE_URL=https://paper-api.alpaca.markets)
 * Switch to live by changing the URL — everything else stays the same.
 */

const BASE_URL   = process.env.ALPACA_BASE_URL   || 'https://paper-api.alpaca.markets';
const API_KEY    = process.env.ALPACA_API_KEY;
const SECRET_KEY = process.env.ALPACA_SECRET_KEY;

const HEADERS = {
  'APCA-API-KEY-ID':     API_KEY,
  'APCA-API-SECRET-KEY': SECRET_KEY,
  'Content-Type':        'application/json',
};

async function alpaca(method, path, body) {
  const r = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Alpaca ${method} ${path}: ${data.message || r.status}`);
  return data;
}

// ─── Account ──────────────────────────────────────────────────────────────────

export async function getAccount() {
  const a = await alpaca('GET', '/v2/account');
  return {
    account_number:  a.account_number,
    status:          a.status,
    portfolio_value: parseFloat(a.portfolio_value),
    buying_power:    parseFloat(a.buying_power),
    cash:            parseFloat(a.cash),
    paper:           a.account_number?.startsWith('PA'),
  };
}

// ─── Positions ────────────────────────────────────────────────────────────────

export async function getPositions() {
  const positions = await alpaca('GET', '/v2/positions');
  return positions.map(p => ({
    symbol:       p.symbol,
    qty:          parseFloat(p.qty),
    avg_price:    parseFloat(p.avg_entry_price),
    current_price: parseFloat(p.current_price),
    market_value: parseFloat(p.market_value),
    unrealized_pl: parseFloat(p.unrealized_pl),
    unrealized_pl_pct: parseFloat(p.unrealized_plpc) * 100,
    side:         p.side,
  }));
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export async function getOrders({ status = 'open' } = {}) {
  return alpaca('GET', `/v2/orders?status=${status}&limit=20`);
}

export async function cancelOrder(orderId) {
  await alpaca('DELETE', `/v2/orders/${orderId}`);
  return { cancelled: orderId };
}

export async function cancelAllOrders() {
  await alpaca('DELETE', '/v2/orders');
  return { cancelled: 'all' };
}

// ─── Daily P&L Targets ───────────────────────────────────────────────────────

export const DAILY_PROFIT_TARGET = 150;  // stop trading when we hit $150 profit
export const DAILY_LOSS_LIMIT    = 200;  // stop trading when we lose $200

export async function getDailyPnL() {
  try {
    const r = await fetch(
      `${BASE_URL}/v2/account/portfolio/history?period=1D&timeframe=5Min&intraday_reporting=market_hours`,
      { headers: HEADERS }
    );
    if (!r.ok) return { pnl: 0, pnl_pct: 0, available: false };
    const d = await r.json();

    const pnlArr    = (d.profit_loss     || []).filter(v => v != null);
    const pnlPctArr = (d.profit_loss_pct || []).filter(v => v != null);
    const pnl       = pnlArr.length     > 0 ? pnlArr[pnlArr.length - 1]         : 0;
    const pnl_pct   = pnlPctArr.length  > 0 ? pnlPctArr[pnlPctArr.length - 1] * 100 : 0;

    return {
      pnl:                  +pnl.toFixed(2),
      pnl_pct:              +pnl_pct.toFixed(3),
      available:            true,
      daily_target:         DAILY_PROFIT_TARGET,
      daily_loss_limit:     -DAILY_LOSS_LIMIT,
      target_reached:       pnl >= DAILY_PROFIT_TARGET,
      loss_limit_reached:   pnl <= -DAILY_LOSS_LIMIT,
      remaining_to_target:  +Math.max(0, DAILY_PROFIT_TARGET - pnl).toFixed(2),
    };
  } catch (e) {
    return { pnl: 0, pnl_pct: 0, available: false, error: e.message };
  }
}

// ─── Time-of-Day Filter ───────────────────────────────────────────────────────

export function isBadTradingTime() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const t  = et.getHours() * 60 + et.getMinutes();

  if (t >= 9 * 60 + 30 && t < 9 * 60 + 45)
    return { bad: true,  reason: 'Opening gap chaos (9:30–9:45 AM ET) — extreme spreads and reversals' };
  if (t >= 11 * 60 + 30 && t < 14 * 60)
    return { bad: true,  reason: 'Midday chop (11:30 AM–2:00 PM ET) — low volume, no clean trends' };
  if (t >= 15 * 60 + 30)
    return { bad: true,  reason: 'Closing volatility (3:30 PM ET+) — erratic end-of-day moves' };
  if (t < 9 * 60 + 30 || t >= 16 * 60)
    return { bad: true,  reason: 'Market closed' };
  return { bad: false, reason: null };
}

// ─── ATR-based Stop/Target Sizing ─────────────────────────────────────────────

async function fetchATR(symbol) {
  const r = await fetch(
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=30d`,
    { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const q = d?.chart?.result?.[0]?.indicators?.quote?.[0];
  if (!q) return null;

  const highs  = q.high?.filter(v => v != null)  || [];
  const lows   = q.low?.filter(v => v != null)   || [];
  const closes = q.close?.filter(v => v != null)  || [];
  if (highs.length < 14) return null;

  const bars = Math.min(14, highs.length);
  const trValues = [];
  for (let i = highs.length - bars; i < highs.length; i++) {
    trValues.push(highs[i] - lows[i]);
  }
  const atr = trValues.reduce((a, b) => a + b, 0) / trValues.length;
  const price = closes[closes.length - 1];
  return price > 0 ? +((atr / price) * 100).toFixed(2) : null;
}

// ─── Quote ────────────────────────────────────────────────────────────────────

export async function getLatestPrice(symbol) {
  const r = await fetch(
    `https://data.alpaca.markets/v2/stocks/${symbol}/quotes/latest`,
    { headers: HEADERS }
  );
  const d = await r.json();
  const q = d?.quote;
  if (!q) throw new Error(`No quote for ${symbol}`);
  const mid = ((q.ap || 0) + (q.bp || 0)) / 2;
  return { symbol, ask: q.ap, bid: q.bp, mid: +mid.toFixed(4) };
}

// ─── Place Trade (bracket order: entry + stop loss + take profit) ─────────────

const MIN_ATR_PCT          = 1.0;   // skip stocks that don't move enough intraday
const TARGET_PROFIT_DOLLARS = 150;  // size position to earn this per winning trade
const MIN_POSITION_DOLLARS  = 1500;
const MAX_POSITION_DOLLARS  = 5000;

export async function placeTrade({
  symbol,
  side = 'buy',
  dollars = null,           // explicit override — if null, auto-sized from ATR
  stop_loss_pct   = 3,
  take_profit_pct = 7,
  use_atr = true,
  note = '',
}) {
  // Get current price
  const quote = await getLatestPrice(symbol);
  const price = side === 'buy' ? quote.ask : quote.bid;
  if (!price || price <= 0) throw new Error(`Invalid price for ${symbol}: ${price}`);

  // ATR-based dynamic stop/target sizing
  let atr_pct = null;
  if (use_atr) {
    try {
      atr_pct = await fetchATR(symbol);
      if (atr_pct) {
        if (atr_pct < MIN_ATR_PCT)
          throw new Error(`${symbol} ATR ${atr_pct}% is below minimum ${MIN_ATR_PCT}% — stock doesn't move enough for $${TARGET_PROFIT_DOLLARS} intraday target`);
        stop_loss_pct   = Math.min(8,  Math.max(1.5, +(1.5 * atr_pct).toFixed(1)));
        take_profit_pct = Math.min(20, Math.max(3,   +(3.0 * atr_pct).toFixed(1)));
        // Auto-size position to target $150 profit if take-profit is hit
        if (dollars == null) {
          const auto = Math.round(TARGET_PROFIT_DOLLARS / (take_profit_pct / 100));
          dollars = Math.min(MAX_POSITION_DOLLARS, Math.max(MIN_POSITION_DOLLARS, auto));
        }
      }
    } catch (e) {
      if (e.message.includes('ATR') && e.message.includes('minimum')) throw e;
    }
  }

  // Fallback if ATR unavailable and no override
  if (dollars == null) dollars = MIN_POSITION_DOLLARS;

  // Calculate quantity (whole shares only for simplicity)
  const qty = Math.floor(dollars / price);
  if (qty < 1) throw new Error(`$${dollars} is not enough to buy 1 share of ${symbol} at $${price}`);

  // Bracket order prices
  const stopPrice   = side === 'buy'
    ? +(price * (1 - stop_loss_pct  / 100)).toFixed(2)
    : +(price * (1 + stop_loss_pct  / 100)).toFixed(2);
  const targetPrice = side === 'buy'
    ? +(price * (1 + take_profit_pct / 100)).toFixed(2)
    : +(price * (1 - take_profit_pct / 100)).toFixed(2);

  // Place bracket order
  const order = await alpaca('POST', '/v2/orders', {
    symbol,
    qty,
    side,
    type:         'market',
    time_in_force: 'day',
    order_class:  'bracket',
    stop_loss:    { stop_price: stopPrice },
    take_profit:  { limit_price: targetPrice },
    client_order_id: `bot_${symbol}_${Date.now()}`,
  });

  const dollars_invested  = +(qty * price).toFixed(2);
  const estimated_profit  = +(dollars_invested * take_profit_pct / 100).toFixed(2);
  const estimated_risk    = +(dollars_invested * stop_loss_pct   / 100).toFixed(2);

  return {
    order_id:        order.id,
    symbol,
    side,
    qty,
    estimated_price:  price,
    dollars_invested,
    stop_loss:        stopPrice,
    take_profit:      targetPrice,
    stop_loss_pct,
    take_profit_pct,
    atr_pct,
    estimated_profit,
    estimated_risk,
    risk_reward:      +(estimated_profit / estimated_risk).toFixed(1),
    note,
    status: order.status,
  };
}

// ─── Close Position ───────────────────────────────────────────────────────────

export async function closePosition(symbol) {
  const r = await alpaca('DELETE', `/v2/positions/${symbol}`);
  return {
    symbol,
    qty:  parseFloat(r.qty),
    side: r.side,
    status: r.status,
  };
}

// ─── Market Hours ─────────────────────────────────────────────────────────────

export async function getMarketStatus() {
  const clock = await alpaca('GET', '/v2/clock');
  return {
    is_open:      clock.is_open,
    next_open:    clock.next_open,
    next_close:   clock.next_close,
    timestamp:    clock.timestamp,
  };
}
