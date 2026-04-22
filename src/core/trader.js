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

// ─── Time-of-Day Filter ───────────────────────────────────────────────────────

export function isBadTradingTime() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const t  = et.getHours() * 60 + et.getMinutes();

  if (t >= 9 * 60 + 30 && t < 10 * 60)
    return { bad: true,  reason: 'Opening volatility window (9:30–10:00 AM ET) — wide spreads and reversals' };
  if (t >= 12 * 60 && t < 14 * 60)
    return { bad: true,  reason: 'Lunch chop (12:00–2:00 PM ET) — low volume, choppy price action' };
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

export async function placeTrade({
  symbol,
  side = 'buy',
  dollars,
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
        stop_loss_pct   = Math.min(8,  Math.max(1.5, +(1.5 * atr_pct).toFixed(1)));
        take_profit_pct = Math.min(20, Math.max(3,   +(3.0 * atr_pct).toFixed(1)));
      }
    } catch (_) {}
  }

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

  return {
    order_id:        order.id,
    symbol,
    side,
    qty,
    estimated_price:  price,
    dollars_invested: +(qty * price).toFixed(2),
    stop_loss:        stopPrice,
    take_profit:      targetPrice,
    stop_loss_pct,
    take_profit_pct,
    atr_pct,
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
