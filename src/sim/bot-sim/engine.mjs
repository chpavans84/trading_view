/**
 * src/sim/bot-sim/engine.mjs — BOT_SIM replay engine.
 *
 * Fork of src/core/bot-advance/engine.js' control flow (scan → manage → execute),
 * re-pointed at the no-lookahead Feed and the simulated broker. Same shape as
 * production so promotion is a code move, not a rewrite.
 *
 * Per session minute (clock T):
 *   1. MANAGE open positions — gap-aware exit checks on bar[T], then trail update.
 *   2. EXECUTE — for qualified names (daily setup, prior-session features) that
 *      confirm intraday, fill at bar[T+1] open + slippage, open the position.
 * End of day → mark equity. (Nightly learning runs in the runner, not here.)
 */
import { simQuery } from '../db.mjs';
import { fillBuy, checkExit, updateTrail } from '../broker.mjs';
import { getStrategy } from './strategies/index.mjs';

export class SimEngine {
  constructor({ feed, runId, startCash = 100000, strategy = 'pullback' }) {
    this.feed = feed;
    this.runId = runId;
    this.cash = startCash;
    this.startCash = startCash;
    this.open = new Map();        // symbol -> position
    this.closedToday = 0;
    this.strategy = typeof strategy === 'string' ? getStrategy(strategy) : strategy;
  }

  async openPosition(symbol, fill, setup, regime, policyVersion, reasons, conf) {
    const ex = this.strategy.exitParams(this._policy, fill.fillPx, fill.fillT, conf);
    const pos = {
      symbol, qty: fill.qty, entryPx: fill.fillPx, refPx: fill.refPx,
      entryT: fill.fillT, entryTs: fill.fillTs, setup, regime,
      slippageBps: fill.slippageBps, policyVersion, ...ex,
    };
    this.open.set(symbol, pos);
    this.cash -= fill.qty * fill.fillPx;
    const { rows } = await simQuery(
      `INSERT INTO sim.trades(run_id,symbol,setup,regime,qty,entry_ts,entry_px,ref_px,slippage_bps,stop_px,policy_version,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open') RETURNING id`,
      [this.runId, symbol, setup, regime, fill.qty, fill.fillTs, fill.fillPx, fill.refPx, fill.slippageBps, pos.stopPx, policyVersion]);
    pos.tradeId = rows[0].id;
    await simQuery(
      `INSERT INTO sim.decisions(run_id,ts,symbol,action,setup,score,regime,reasons)
       VALUES ($1,$2,$3,'would_buy',$4,$5,$6,$7)`,
      [this.runId, this.feed.clock, symbol, setup, fill.refPx, regime, JSON.stringify(reasons || [])]);
  }

  async closePosition(pos, exitPx, exitTs, exitT, reason) {
    const pnl = (exitPx - pos.entryPx) * pos.qty;
    const pnlPct = (exitPx / pos.entryPx - 1) * 100;
    const holdMin = Math.round((exitT - pos.entryT) / 60000);
    this.cash += pos.qty * exitPx;
    this.open.delete(pos.symbol);
    this.closedToday++;
    await simQuery(
      `UPDATE sim.trades SET exit_ts=$1, exit_px=$2, exit_reason=$3, pnl=$4, pnl_pct=$5, hold_minutes=$6, status='closed' WHERE id=$7`,
      [exitTs, exitPx, reason, pnl, pnlPct, holdMin, pos.tradeId]);
  }

  /** one full session day */
  async runDay(dateStr, policy) {
    this._policy = policy;
    await this.feed.loadDay(dateStr);
    // Set the clock to the day's first minute BEFORE qualifying, so daily
    // features / regime resolve to the PRIOR session close (as-of today's open).
    this.feed.setClock(this.feed.dayMinutes[0]);
    const { regime, names } = this.strategy.qualifyNames(this.feed, policy);
    const regimeLabel = regime?.regime ?? null;
    this.closedToday = 0;
    const enteredToday = new Set();

    for (const clk of this.feed.dayMinutes) {
      this.feed.setClock(clk);
      const clkT = +clk;

      // 1. MANAGE — exits first (gap-aware), then trail update
      for (const pos of [...this.open.values()]) {
        const bar = this.feed.bar(pos.symbol);
        if (!bar || bar.t <= pos.entryT) continue;          // don't manage on/before fill bar
        const ex = checkExit(pos, bar, clkT);
        if (ex) { await this.closePosition(pos, ex.exitPx, bar.ts, bar.t, ex.reason); continue; }
        updateTrail(pos, bar);
      }

      // 2. EXECUTE — new entries while we have capacity
      if (regimeLabel && this.open.size < policy.sizing.max_positions
          && enteredToday.size < policy.sizing.max_new_per_day) {
        for (const sym of names) {
          if (this.open.has(sym) || enteredToday.has(sym)) continue;
          const conf = this.strategy.confirmEntry(this.feed, sym, policy);
          if (!conf.ok) continue;
          const refBar = this.feed.bar(sym);
          if (!refBar) continue;
          const fill = fillBuy(this.feed, sym, policy.sizing.dollars_per_trade, refBar);
          if (!fill) continue;
          await this.openPosition(sym, fill, this.strategy.name, regimeLabel, policy.version, conf.reasons, conf);
          enteredToday.add(sym);
          if (this.open.size >= policy.sizing.max_positions
              || enteredToday.size >= policy.sizing.max_new_per_day) break;
        }
      }
    }

    // intraday strategies: force-close eodExit positions at the day's last bar
    for (const pos of [...this.open.values()]) {
      if (!pos.eodExit) continue;
      const arr = this.feed._barsByDay.get(pos.symbol);
      const last = arr?.length ? arr[arr.length - 1] : null;
      if (!last || last.t <= pos.entryT) continue;     // opened on the last bar — let it carry (rare)
      await this.closePosition(pos, +(last.c * (1 - 0.0004)).toFixed(4), last.ts, last.t, 'eod');
    }

    // end-of-day equity mark (positions at last available bar close)
    let posVal = 0;
    for (const pos of this.open.values()) {
      const arr = this.feed._barsByDay.get(pos.symbol);
      const lastC = arr?.length ? arr[arr.length - 1].c : pos.entryPx;
      posVal += pos.qty * lastC;
    }
    const lastMin = this.feed.dayMinutes[this.feed.dayMinutes.length - 1];
    await simQuery(
      `INSERT INTO sim.equity(run_id,ts,cash,positions_value,equity) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (run_id,ts) DO UPDATE SET cash=EXCLUDED.cash, positions_value=EXCLUDED.positions_value, equity=EXCLUDED.equity`,
      [this.runId, lastMin, this.cash, posVal, this.cash + posVal]);

    return { date: dateStr, regime: regimeLabel, qualified: names.size, entered: enteredToday.size, closed: this.closedToday, openNow: this.open.size, equity: this.cash + posVal };
  }


  /** force-close everything at the last bar (end of sim) so P&L is complete */
  async liquidateAll() {
    for (const pos of [...this.open.values()]) {
      const arr = this.feed._barsByDay.get(pos.symbol);
      const last = arr?.length ? arr[arr.length - 1] : null;
      const px = last ? last.c : pos.entryPx;
      await this.closePosition(pos, px, last?.ts ?? pos.entryTs, last?.t ?? pos.entryT, 'sim_end');
    }
  }
}
