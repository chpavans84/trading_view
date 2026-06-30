/**
 * src/sim/feed.mjs — the no-lookahead data feed.
 *
 * THE structural guarantee of the whole sim: every method gates on the sim
 * clock. The engine can only obtain data through this object, so it physically
 * cannot see the future — not price, not features, not UW flow, not news.
 *
 *   clock T  →  minute bars   ts   ≤ T
 *              daily features  d    <  date(T)      (prior session close)
 *              regime          d    <  date(T)
 *              UW flow / news  known_at ≤ T  (and within a trailing window)
 *
 * Forward-return columns are not even loaded into the sim schema, so there is
 * no path by which they could leak.
 */
import { simQuery } from './db.mjs';

const ET = 'America/New_York';
const etDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: ET }).format(d); // YYYY-MM-DD

export class Feed {
  constructor() {
    this.clock = null;                 // Date (UTC instant)
    this._day = null;                  // session date string currently loaded
    this._barsByDay = new Map();       // symbol -> bars[] (current day, ASC)
    this._feat = new Map();            // symbol -> [{d, ...}] ASC
    this._regime = [];                 // [{d, regime, ...}] ASC
    this._uw = new Map();              // ticker -> [{known_at, bull, bear}] ASC
    this._news = new Map();            // symbol -> [{known_at, sentiment}] ASC
    this.sessions = [];                // [{date, minutes:[Date...]}]
  }

  async init({ from, to }) {
    // Universe
    const uni = (await simQuery(`SELECT symbol, in_sp500, in_ndx100 FROM sim.universe`)).rows;
    this.universe = uni.map(r => r.symbol);
    this.uniMeta = new Map(uni.map(r => [r.symbol, r]));

    // Daily features (all, small) → per symbol ASC
    for (const r of (await simQuery(
      `SELECT symbol, d, close, ret_5d, rvol, dist_sma50, dist_sma200, dist_52whigh, rs_spy_20, adv20, dist_20dhigh
         FROM sim.daily_features ORDER BY symbol, d`)).rows) {
      if (!this._feat.has(r.symbol)) this._feat.set(r.symbol, []);
      this._feat.get(r.symbol).push(r);
    }
    // Regime (all)
    this._regime = (await simQuery(`SELECT d, regime, spy_close, rvol20 FROM sim.regime ORDER BY d`)).rows;

    // Events (all) → per ticker ASC by known_at
    for (const r of (await simQuery(
      `SELECT ticker, known_at, bull_prem, bear_prem, premium FROM sim.events_uw ORDER BY ticker, known_at`)).rows) {
      if (!this._uw.has(r.ticker)) this._uw.set(r.ticker, []);
      this._uw.get(r.ticker).push({ t: +new Date(r.known_at), bull: +r.bull_prem, bear: +r.bear_prem });
    }
    for (const r of (await simQuery(
      `SELECT symbol, known_at, sentiment FROM sim.events_news ORDER BY symbol, known_at`)).rows) {
      if (!this._news.has(r.symbol)) this._news.set(r.symbol, []);
      this._news.get(r.symbol).push({ t: +new Date(r.known_at), sentiment: r.sentiment });
    }

    // Session calendar from the minute bars themselves (within window)
    const days = (await simQuery(
      `SELECT DISTINCT (ts AT TIME ZONE $3)::date::text AS d
         FROM sim.minute_bars
        WHERE ts >= $1 AND ts < ($2::date + 1)
        ORDER BY 1`, [from, to, ET])).rows.map(r => r.d);
    this.sessionDates = days;
    return { universe: this.universe.length, sessions: days.length };
  }

  async loadDay(dateStr) {
    if (this._day === dateStr) return;
    this._barsByDay = new Map();
    const rows = (await simQuery(
      `SELECT symbol, ts, open, high, low, close, volume
         FROM sim.minute_bars
        WHERE (ts AT TIME ZONE $2)::date = $1::date
        ORDER BY symbol, ts`, [dateStr, ET])).rows;
    for (const r of rows) {
      if (!this._barsByDay.has(r.symbol)) this._barsByDay.set(r.symbol, []);
      this._barsByDay.get(r.symbol).push({
        t: +new Date(r.ts), ts: r.ts,
        o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume,
      });
    }
    this._day = dateStr;
    // distinct minute timestamps for the day (the clock ticks)
    const set = new Set();
    for (const arr of this._barsByDay.values()) for (const b of arr) set.add(b.t);
    this.dayMinutes = [...set].sort((a, b) => a - b).map(t => new Date(t));
  }

  setClock(d) { this.clock = d; this._clockMs = +d; this._clockDate = etDate(d); }

  // ── price ──
  /** the bar whose start == clock (the "current" minute), or null */
  bar(symbol) {
    const arr = this._barsByDay.get(symbol);
    if (!arr) return null;
    // exact match on clock minute
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].t === this._clockMs) return arr[i]; if (arr[i].t < this._clockMs) break; }
    return null;
  }
  /** today's bars with start ≤ clock (intraday history) */
  intraday(symbol) {
    const arr = this._barsByDay.get(symbol);
    if (!arr) return [];
    const out = [];
    for (const b of arr) { if (b.t <= this._clockMs) out.push(b); else break; }
    return out;
  }
  /** the next bar strictly after clock (for next-open fills) */
  nextBar(symbol) {
    const arr = this._barsByDay.get(symbol);
    if (!arr) return null;
    for (const b of arr) if (b.t > this._clockMs) return b;
    return null;
  }

  // ── daily features as-of PRIOR session close (d < clock date) ──
  dailyFeat(symbol) {
    const arr = this._feat.get(symbol);
    if (!arr) return null;
    let hit = null;
    for (const r of arr) { if (r.d < this._clockDate) hit = r; else break; }
    return hit;
  }
  regimeNow() {
    let hit = null;
    for (const r of this._regime) { if (r.d < this._clockDate) hit = r; else break; }
    return hit;
  }

  // ── point-in-time events within a trailing window ──
  uwFlow(symbol, hours = 24) {
    const arr = this._uw.get(symbol);
    if (!arr) return { bull: 0, bear: 0, n: 0 };
    const lo = this._clockMs - hours * 3600e3;
    let bull = 0, bear = 0, n = 0;
    for (const e of arr) { if (e.t > this._clockMs) break; if (e.t > lo) { bull += e.bull; bear += e.bear; n++; } }
    return { bull, bear, n };
  }
  news(symbol, hours = 48) {
    const arr = this._news.get(symbol);
    if (!arr) return { n: 0, bullish: 0, bearish: 0 };
    const lo = this._clockMs - hours * 3600e3;
    let n = 0, bullish = 0, bearish = 0;
    for (const e of arr) {
      if (e.t > this._clockMs) break;
      if (e.t > lo) { n++; if (e.sentiment === 'bullish') bullish++; else if (e.sentiment === 'bearish') bearish++; }
    }
    return { n, bullish, bearish };
  }
}
