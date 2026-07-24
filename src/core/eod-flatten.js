/**
 * End-of-Day position flatten — 3:50 PM ET.
 *
 * ORIGIN: a day-trading guardrail ("no overnight exposure"). It cancelled every open
 * order and closed every open position in the Alpaca account, unconditionally.
 *
 * ROOT-CAUSE FIX (2026-07-14). That blanket sweep silently destroyed the ONLY strategy
 * with a proven edge. Bot 4 runs `insider_director_cluster`, whose backtest (insider
 * ≥$100K, 1,656 trades) prescribes a 20-DAY hold with a wide 15% stop and no trail.
 * eodFlatten closed it the same afternoon it opened — every single day. Evidence: FISV
 * was bought at 09:31 ET and sold at 15:50 ET on Jul-6/9/10/13, round-tripped 15 times
 * for a net −$19.81, while the swing thesis never once got to express itself.
 *
 * Worse, the flatten closed at the BROKER without writing to Postgres, so the row was
 * later swept up as a phantom and booked at entry price → $0.00 P&L. The DB ledger
 * showed flat while the account actually bled (141 round-trips, −$293.86 since Jun-20).
 *
 * Three defects, fixed here:
 *   1. UNSCOPED  — it enumerated raw broker positions with no idea which ones a bot
 *      intends to HOLD. Now: any position backing an open swing trade is protected.
 *   2. UNGATED   — a bare module-scope `setInterval` with no BOT_CRON_OWNER check, so
 *      `trading-staging` registered it too and could double-fire on the same account.
 *      Every other scheduled job in this codebase is gated. Now this one is too.
 *   3. BLANKET CANCEL — `cancelAllOrders()` is account-wide, so it also killed the
 *      protective legs of positions it then declined to close. Now cancellation is
 *      per-symbol, handled inside closePosition(), and only for symbols being flattened.
 *
 * A position is PROTECTED when it backs an open `bot_advance_trades` row whose
 * time_stop_days >= SWING_MIN_TIME_STOP_DAYS — i.e. the bot is deliberately holding it
 * overnight and its own executor owns the exit (hard stop / trail / time stop).
 * Everything else (manual day trades, intraday rules, untracked positions) still flattens.
 */

import { query } from './db.js';

// A trade meant to survive >= 2 days is a SWING hold: flattening it at 3:50 PM is a bug,
// not a guardrail. Intraday rules (time_stop_days 0/1) genuinely do want the EOD exit.
export const SWING_MIN_TIME_STOP_DAYS = 2;

/**
 * Symbols the EOD flatten must NOT touch: those backing an open swing trade.
 * Fails CLOSED on a DB error — if we cannot prove a position is safe to flatten, we
 * skip flattening rather than risk liquidating a 20-day hold on a transient blip.
 *
 * @returns {Promise<{ symbols: Set<string>, ok: boolean }>}
 */
export async function getProtectedSymbols() {
  try {
    const { rows } = await query(
      `SELECT DISTINCT UPPER(symbol) AS symbol
         FROM bot_advance_trades
        WHERE status IN ('open', 'pending')
          AND COALESCE(time_stop_days, 0) >= $1`,
      [SWING_MIN_TIME_STOP_DAYS]
    );
    return { symbols: new Set(rows.map(r => r.symbol)), ok: true };
  } catch (e) {
    console.error('[EOD] could not load protected swing symbols:', e.message);
    return { symbols: new Set(), ok: false };
  }
}

/**
 * Split broker positions into what to flatten vs what to leave alone. Pure — unit-tested.
 *
 * @param {Array<{symbol:string}>} positions   raw broker positions
 * @param {Set<string>} protectedSymbols       symbols backing an open swing trade
 * @returns {{ flatten: Array<object>, protected: Array<object> }}
 */
export function selectFlattenTargets(positions, protectedSymbols) {
  const held = protectedSymbols instanceof Set ? protectedSymbols : new Set(protectedSymbols || []);
  const out = { flatten: [], protected: [] };
  for (const pos of positions || []) {
    const sym = String(pos?.symbol || '').toUpperCase();
    if (!sym) continue;
    if (held.has(sym)) out.protected.push(pos);
    else out.flatten.push(pos);
  }
  return out;
}

/**
 * Is this the 3:50 PM ET weekday minute? Pure — takes the ET wall-clock date so tests
 * don't depend on the ambient timezone.
 */
export function shouldFlattenAt(etDate) {
  const day = etDate.getDay();
  if (day === 0 || day === 6) return false;             // weekends: market closed
  return etDate.getHours() === 15 && etDate.getMinutes() === 50;
}

/** Is the flatten switched on at all? Opt-out via EOD_FLATTEN_ENABLED=false. */
export function isFlattenEnabled(env = process.env) {
  return String(env.EOD_FLATTEN_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Run one flatten pass. Dependencies are injected so this is testable without a broker.
 *
 * @param {object} deps
 * @param {() => Promise<Array>}           deps.getPositions
 * @param {(symbol:string) => Promise<any>} deps.closePosition
 * @param {(subject:string, body:string) => Promise<any>} [deps.sendEmailAlert]
 * @param {() => Promise<{pnl:number, pnl_pct:number}>}   [deps.getDailyPnL]
 * @param {() => Promise<{symbols:Set<string>, ok:boolean}>} [deps.getProtectedSymbols]
 */
export async function runFlatten(deps) {
  const {
    getPositions,
    closePosition,
    sendEmailAlert = async () => {},
    getDailyPnL = null,
    getProtectedSymbols: loadProtected = getProtectedSymbols,
  } = deps;

  const { symbols: protectedSymbols, ok } = await loadProtected();
  if (!ok) {
    // Fail CLOSED: we could not determine which positions are swing holds. Liquidating
    // a 20-day insider hold by mistake is far more costly than carrying day-trade
    // exposure one extra night.
    const msg = '[EOD] ABORTED — could not load protected swing symbols (DB unavailable). No positions flattened.';
    console.error(msg);
    await sendEmailAlert('⚠ EOD Flatten skipped', msg).catch(() => {});
    return { flattened: [], protected: [], aborted: true };
  }

  const positions = await getPositions().catch(() => []);
  const { flatten, protected: kept } = selectFlattenTargets(positions, protectedSymbols);

  const results = [];
  for (const pos of flatten) {
    try {
      // closePosition() cancels that symbol's own resting orders first. We deliberately
      // do NOT call the account-wide cancelAllOrders() — it would strip protective legs
      // off the swing positions we are choosing to keep.
      await closePosition(pos.symbol);
      results.push(`✅ Closed ${pos.symbol} (${pos.qty} shares, P&L: $${Number(pos.unrealized_pl ?? 0).toFixed(2)})`);
    } catch (e) {
      results.push(`⚠️ ${pos.symbol}: ${e.message}`);
    }
  }

  const keptLines = kept.map(p => `🔒 Held ${p.symbol} (${p.qty} shares) — open swing trade, bot owns the exit`);
  console.log(`[EOD] flattened ${flatten.length}, protected ${kept.length} swing position(s)`);

  let pnlLine = '';
  if (getDailyPnL) {
    try {
      const pnl = await getDailyPnL();
      pnlLine = `\n💰 *Today's P&L: ${pnl.pnl >= 0 ? '+' : ''}$${pnl.pnl?.toFixed(2)} (${pnl.pnl_pct?.toFixed(2)}%)*`;
    } catch { /* P&L is cosmetic — never block the flatten on it */ }
  }

  const body = [...results, ...keptLines].join('\n') || 'No open positions.';
  await sendEmailAlert(
    'EOD Flatten — 3:50 PM ET',
    `🔔 *EOD Flatten — 3:50 PM ET*\n\n${body}${pnlLine}\n\n_Day-trade orders cancelled. Swing holds retained._`
  ).catch(() => {});

  return { flattened: flatten.map(p => p.symbol), protected: kept.map(p => p.symbol), aborted: false };
}
