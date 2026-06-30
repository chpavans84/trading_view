# Polygon Subscription Exit — Transition Plan (data-integrity first)

Status: PLAN (2026-06-10). Goal: cancel the Polygon subscription after this week **without losing any
data** and with forward market data sourced from OLTP. Audit: `scripts/integrity_audit.sh`.

---

## 1. What's at stake — the two data domains
- **Market data (prices/bars/trades):** the 10yr history exists ONLY from the Polygon flat-file archive.
  Current Silver sourcing: `market_bars_{daily,minute,trades}` ← **Polygon raw archive directly**
  (`lake/convert_raw.py`, `lake/silver.py`); `market_bars_daily_adj` ← that + Polygon splits.
  **Market data does NOT flow through OLTP or Bronze.**
- **Proprietary data (decisions, trades, conviction, UW signals):** OLTP → Bronze → `silver/signals/*`.

## 2. What is PERMANENT (cancelling Polygon loses none of it)
- Raw archive on /Volumes/Archive (minute 42GB, day 0.5GB, **trades 2.2TB/161B rows**, REST, news) —
  downloaded, owned forever, SHA-256-verified (0 mismatches).
- Silver lake (daily/daily_adj/minute/trades/signals) + Gold — already built FROM the archive.
- ⇒ The entire 2016–2026 historical lake is yours with no subscription. **Backtests are unaffected forever.**

## 3. What CHANGES going forward (post-cancellation)
| Data | Today | After cancel |
|---|---|---|
| Proprietary | OLTP → Bronze → Silver | unchanged ✅ |
| Daily market bars | Polygon archive → Silver | **OLTP `backtest_prices` (Yahoo, free, current to today, 25k syms) → Bronze → Silver** |
| Minute bars | Polygon archive → Silver | ⚠️ **no forward source** (OLTP minute is stale) — frozen at cancel unless a new minute source is added |
| Trades (tick) | Polygon archive → Silver | ⚠️ **no forward source** — frozen at cancel |
| Splits/divs/financials | Polygon REST | ⚠️ no forward source (have history; corp-actions go stale) |

**Decision needed:** is forward DAILY data enough, or do you need forward intraday/trades? (You keep ALL
10yr of historical minute/trades either way — only *new* days stop.)

## 4. Data-integrity audit (run + must be GREEN before cancelling) — `scripts/integrity_audit.sh`
QA checks, all read-only:
1. **Raw ↔ Silver day reconciliation** — every raw `.csv.gz` day has a Silver `d=` partition (no day lost
   in conversion), all 3 streams.
2. **Row reconciliation** — sample days: raw CSV row count == Silver parquet row count (no rows dropped).
3. **Gap scan** — every full year 2017–2025 has ≥240 trading days.
4. **Forward-source parity** — symbols in the recent Polygon day vs OLTP `backtest_prices` (what the
   forward switch would/wouldn't cover).
5. **REST completeness** — details/splits/dividends/financials present.
6. **SHA-256 manifest** — bit integrity (re-run `--verify` before AND after physically moving the DAS).

**RESULTS (2026-06-10): ✅ 13/13 PASS, 0 FAIL — "DATA INTEGRITY OK".**
- Raw↔Silver: day_aggs 2519/2519, minute 2519/2519, trades 2480/2480 — **0 days missing** in any stream.
- Row recon (samples): exact — e.g. trades 2023-06-26 raw=silver=67,038,964; minute 2021-06-24=1,589,872.
- Gaps: all full years ≥240 days. REST: 12,673 files each (details/splits/divs/financials). Manifest: 60,084 files.
- **Forward parity (the one decision):** recent day 2026-06-08 → Polygon **12,194** syms vs backtest_prices
  **8,297** → **4,072 Polygon symbols NOT in OLTP**. Switching forward daily to OLTP shrinks the universe
  to ~8,300 (the names the bot tracks). Historical 12k+ universe is retained; only *new* days for those
  4,072 stop. Decide if acceptable.

## 5. Transition steps (this week, in order)
1. **Final full Polygon sync** — you've paid; pull any missing days + a fresh REST snapshot to max out
   the historical archive. (`scripts/polygon-daily-incremental.sh` catch-up, or a full backfill pass.)
2. **Run `scripts/integrity_audit.sh` → require PASS, FAIL=0.** Do NOT cancel until green.
3. **Re-run `scripts/build-archive-manifest.sh --verify`** (0 mismatches) as the final integrity stamp.
4. **Repoint the daily batch** (`polygon-daily-incremental.sh`): drop the `rclone` Polygon flat-file pull
   + `polygon-rest-snapshot`; add a forward step that appends yesterday's OLTP `backtest_prices` rows →
   Bronze → Silver `market_bars_daily(_adj)`, applying OUR OWN split adjustment (Polygon splits history
   + corp-actions; don't trust Yahoo's flaky adjustment). Keep the OLTP proprietary append.
5. **Resolve the intraday-forward gap** (accept frozen minute/trades, or add a free minute source).
6. **Cancel Polygon.**

## 6. Forward architecture (post-Polygon)
```
 OLTP (bot, Yahoo-fed) ──daily──▶ Bronze ──▶ Silver: signals + market_bars_daily(_adj)
 Polygon historical archive (frozen at cancel) ──────────▶ Silver: minute/trades/daily (2016→cancel)
 → unified Silver = historical (Polygon, to cancel date) + forward (OLTP, after) — one continuous series
```

## 7. Risks & mitigations (no-data-loss focus)
- **Seam gap/overlap at cutover** → pick an explicit cutover date D: Polygon archive covers ≤ D, OLTP
  covers > D. Verify no missing day and no duplicate day at the boundary (extend integrity_audit to the
  seam once forward is wired).
- **Yahoo adjustment drift** → apply our own split adjustment in Silver (already have `build_adjusted`),
  never rely on `backtest_prices.adj_close`.
- **Universe shrink** → audit step 4 quantifies Polygon-only symbols; decide before cancel.
- **Accidental archive deletion** → archive is the irreplaceable asset post-cancel; keep the SHA manifest,
  and back up /Volumes/Archive (NAS, when it arrives) before any cleanup.

## 8. Rollback
Nothing is deleted in this transition (only the daily pull is repointed). If forward-from-OLTP proves
insufficient, re-enabling the Polygon pull is a one-line revert in the daily script (while subscription
is active). After cancellation, rollback = re-subscribe.
