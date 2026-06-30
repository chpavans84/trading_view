"""Phase-1 portfolio backtest engine — event-driven, realistic fills/costs, on the corrected lake.

Tests strategies on split-adjusted, survivorship-free 10yr data with point-in-time signals (decide
on day-d close, FILL at d+1 open + slippage), portfolio constraints, gap-aware stops, and full
metrics (CAGR, Sharpe, maxDD, profit factor, per-regime, vs SPY). Directly answers the retrospective:
- momentum vs mean-reversion vs 52w-high entries
- mechanical hard-stops vs trail-only exits  (live data: trail was the ONLY profitable bucket)

Run:  python -m lake.sim
"""
import duckdb
import numpy as np
import pandas as pd
from .common import GOLD, SILVER

START_CAPITAL   = 100_000.0
MAX_POSITIONS   = 20
REBALANCE_EVERY = 5          # trading days
SLIPPAGE_BPS    = 5          # per side (5bps = 0.05%)
COMMISSION      = 0.0        # Alpaca = $0

REGIMES = [('COVID20','2020-02-01','2020-12-31'), ('2021bull','2021-01-01','2021-12-31'),
           ('2022bear','2022-01-01','2022-12-31'), ('AIbull','2023-01-01','2024-12-31'),
           ('recent','2025-01-01','2026-12-31')]


def load():
    con = duckdb.connect(); con.execute("SET TimeZone='America/New_York'")
    # signals (as-of close) + that day's tradeable flag; prices for fills/exits
    feat = con.execute(f"""
        SELECT symbol, d, ret_20d, dist_52whigh, rs_spy_20, close
        FROM read_parquet('{GOLD}/features_daily/**/*.parquet')
        WHERE ret_20d IS NOT NULL AND dist_52whigh IS NOT NULL
          AND close >= 5            -- price floor: exclude penny stocks (reversion-artifact blowups)
    """).df()
    px = con.execute(f"""
        SELECT symbol, d, open, high, low, close
        FROM read_parquet('{SILVER}/market_bars_daily_adj/**/*.parquet')
        WHERE symbol IN (SELECT DISTINCT symbol FROM read_parquet('{GOLD}/features_daily/**/*.parquet'))
    """).df()
    spy = con.execute(f"""
        SELECT d, close FROM read_parquet('{SILVER}/market_bars_daily_adj/**/*.parquet')
        WHERE symbol='SPY' ORDER BY d
    """).df()
    return feat, px, spy


def score(df, strat):
    if strat == 'momentum':   return df['ret_20d']          # the bot's broken approach
    if strat == 'reversion':  return -df['ret_20d']         # short-horizon mean reversion
    if strat == 'high52w':    return df['dist_52whigh']     # near 52-week high (validated)
    if strat == 'blend':      return df['dist_52whigh'].rank(pct=True) - df['ret_20d'].rank(pct=True) + df['rs_spy_20'].rank(pct=True)
    raise ValueError(strat)


def run(feat, px, spy, strat='high52w', hard_stop=None, trail=None, time_stop=None, label='', max_missing=5):
    dates = sorted(px['d'].unique())
    px_by_day  = {d: g.set_index('symbol') for d, g in px.groupby('d')}
    sig_by_day = {d: g.set_index('symbol') for d, g in feat.groupby('d')}
    di = {d: i for i, d in enumerate(dates)}

    cash = START_CAPITAL
    positions = {}            # sym -> {qty, entry, peak, entry_date, last_px, missing}
    pending = []
    equity_curve = []
    trades = []

    def mark(day_px):         # equity incl. positions not trading today (use last known px)
        v = cash
        for s, p in positions.items():
            v += p['qty'] * (day_px.at[s,'close'] if s in day_px.index else p['last_px'])
        return v

    def close_out(sym, price, reason, d):
        nonlocal cash
        p = positions.pop(sym)
        ex = price * (1 - SLIPPAGE_BPS/1e4)
        cash += p['qty']*ex - COMMISSION
        trades.append({'sym':sym,'entry':p['entry'],'exit':ex,'ret':ex/p['entry']-1,
                       'days':di[d]-di[p['entry_date']],'reason':reason})

    for i, d in enumerate(dates):
        day_px = px_by_day.get(d)
        if day_px is None:
            continue

        # update last price + missing-day counter for held names
        for s, p in positions.items():
            if s in day_px.index:
                p['last_px'] = day_px.at[s,'close']; p['missing'] = 0
            else:
                p['missing'] += 1

        # 1. fills at today's OPEN — equity-based equal sizing (no leverage)
        if pending:
            per = mark(day_px) / MAX_POSITIONS
            for sym in pending:
                if sym in positions or sym not in day_px.index:
                    continue
                o = day_px.at[sym,'open']
                if not np.isfinite(o) or o <= 0:
                    continue
                fill = o*(1+SLIPPAGE_BPS/1e4)
                qty = int(min(per, cash*0.98) // fill)
                if qty < 1 or qty*fill > cash:
                    continue
                cash -= qty*fill + COMMISSION
                positions[sym] = {'qty':qty,'entry':fill,'peak':fill,'entry_date':d,
                                  'last_px':day_px.at[sym,'close'],'missing':0}
            pending = []

        # 2a. force-liquidate delisted/long-missing names at last known price (FIX: was evaporating)
        for sym in [s for s,p in positions.items() if p['missing'] >= max_missing]:
            close_out(sym, positions[sym]['last_px'], 'delisted', d)

        # 2b. stop / trail / time exits (gap-aware), only for names trading today
        for sym in [s for s in list(positions) if s in day_px.index]:
            p = positions[sym]; row = day_px.loc[sym]
            hi, lo, cl, op = row['high'], row['low'], row['close'], row['open']
            p['peak'] = max(p['peak'], hi)
            ex = reason = None
            if hard_stop is not None and lo <= p['entry']*(1-hard_stop):
                ex = min(op, p['entry']*(1-hard_stop)); reason = 'hard_stop'
            elif trail is not None and lo <= p['peak']*(1-trail):
                ex = min(op, p['peak']*(1-trail)); reason = 'trail'
            elif time_stop is not None and (di[d]-di[p['entry_date']]) >= time_stop:
                ex = cl; reason = 'time'
            if ex is not None:
                close_out(sym, ex, reason, d)

        # 3. rebalance (decide on close, fill next open)
        if i % REBALANCE_EVERY == 0 and d in sig_by_day:
            sig = sig_by_day[d]
            sig = sig[np.isfinite(sig['ret_20d']) & np.isfinite(sig['dist_52whigh'])].copy()
            sig['sc'] = score(sig, strat)
            target = set(sig.sort_values('sc', ascending=False).head(MAX_POSITIONS).index)
            for sym in [s for s in list(positions) if s not in target and s in day_px.index]:
                close_out(sym, day_px.at[sym,'close'], 'rebalance', d)
            pending = [s for s in target if s not in positions]

        equity_curve.append((d, mark(day_px)))

    return _metrics(equity_curve, trades, spy, strat, label, hard_stop, trail, time_stop)


def _metrics(eq, trades, spy, strat, label, hard_stop, trail, time_stop):
    e = pd.DataFrame(eq, columns=['d','equity']).set_index('d')
    e['ret'] = e['equity'].pct_change().fillna(0)
    yrs = (e.index[-1]-e.index[0]).days/365.25
    total = e['equity'].iloc[-1]/START_CAPITAL - 1
    cagr  = (1+total)**(1/yrs)-1 if yrs>0 else 0
    sharpe = e['ret'].mean()/e['ret'].std()*np.sqrt(252) if e['ret'].std()>0 else 0
    maxdd = ((e['equity']/e['equity'].cummax())-1).min()
    tr = pd.DataFrame(trades)
    wr = (tr['ret']>0).mean()*100 if len(tr) else 0
    pf = (tr.loc[tr.ret>0,'ret'].sum()/abs(tr.loc[tr.ret<=0,'ret'].sum())) if len(tr) and (tr.ret<=0).any() else float('inf')
    # SPY benchmark over same window
    sp = spy.set_index('d'); sp = sp[(sp.index>=e.index[0])&(sp.index<=e.index[-1])]
    spy_ret = sp['close'].iloc[-1]/sp['close'].iloc[0]-1 if len(sp)>1 else 0
    name = label or f"{strat}|hs={hard_stop}|tr={trail}|ts={time_stop}"
    print(f"  {name:34s} ret={total*100:7.1f}%  CAGR={cagr*100:6.1f}%  Sharpe={sharpe:5.2f}  "
          f"maxDD={maxdd*100:6.1f}%  trades={len(tr):4d}  win={wr:4.1f}%  PF={pf:4.2f}  (SPY {spy_ret*100:+.0f}%)")
    return {'name':name,'total':total,'cagr':cagr,'sharpe':sharpe,'maxdd':maxdd,
            'trades':len(tr),'win':wr,'pf':pf,'spy':spy_ret,'equity':e}


def main():
    print("loading lake …", flush=True)
    feat, px, spy = load()
    print(f"  features {len(feat):,} rows · prices {len(px):,} rows · {feat.symbol.nunique()} symbols "
          f"· {feat.d.min()}..{feat.d.max()}\n")
    print("ENTRY strategy comparison (rebalance-only exits):")
    for s in ['momentum','reversion','high52w','blend']:
        run(feat, px, spy, strat=s, label=f"entry={s}")
    print("\nEXIT comparison on best entry (high52w) — the retrospective question:")
    run(feat, px, spy, strat='high52w', hard_stop=0.08, time_stop=20, label='high52w + MECHANICAL stops')
    run(feat, px, spy, strat='high52w', trail=0.15,                  label='high52w + TRAIL-only')


if __name__ == '__main__':
    main()
