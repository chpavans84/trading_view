/**
 * src/sim/bot-sim/strategies/_shared.mjs — helpers shared by sim strategies.
 */

/** ET minutes-since-midnight for a Date (handles the UTC→ET conversion). */
export function etMinutes(d) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  return +p.find(x => x.type === 'hour').value * 60 + +p.find(x => x.type === 'minute').value;
}

/** Session VWAP from the day's bars up to now. */
export function vwapOf(bars) {
  let pv = 0, vol = 0;
  for (const b of bars) { pv += ((b.h + b.l + b.c) / 3) * b.v; vol += b.v; }
  return vol > 0 ? pv / vol : (bars.length ? bars[bars.length - 1].c : null);
}

/** Standard exit params from a policy's exits block (used by swing strategies). */
export function swingExits(policy, fillPx, fillT) {
  const x = policy.exits;
  return {
    stopPx: x.hard_sl_pct ? +(fillPx * (1 - x.hard_sl_pct)).toFixed(4) : null,
    trailPct: x.trail_pct || 0,
    peak: fillPx,
    trailing: false,
    timeStopT: fillT + (x.time_stop_days ?? 3) * 24 * 3600e3,
    eodExit: !!x.eod_exit,
  };
}
