# Data Platform Architecture — OLTP + OLAP (ELT Medallion)

**Status:** DESIGN AGREED 2026-06-09. Build deferred to Mac Studio + 40 TB NAS (July 2026),
except the read-only T1 OLTP dump which is safe to start anytime.
Supersedes the transform-in-flight (ETL) sketch in `plan_olap_spark_parquet`.

---

## 1. Core principle — ELT, not ETL

**Load raw first, transform inside the lake.** Bronze is the durable source of truth; Silver and
Gold are disposable views that can be dropped and recomputed from Bronze at any time. We never
transform data in-flight during ingestion — we land it, then transform with SQL (DuckDB / Spark).

---

## 2. Tiers

```
 SOURCE (external, immutable)            T1 · BRONZE              T2 · SILVER                T3 · GOLD
 ───────────────────────────            ───────────             ───────────                ─────────
 Polygon CSV.gz / REST / news   ──┐     (raw OLTP only,         (conformed to Polygon      (analytics-ready
 already on /Volumes/Archive      │      complete mirror)        schema; market data        marts: features,
 (the raw vendor landing zone)    │                             + OLTP unified)            backtests, regime,
                                  │                                                         ML training)
                                  └──────────────┐                  ▲                          ▲
                                                 ▼                  │                          │
 PostgreSQL "tradingbot" ───────────▶  bronze/oltp/<table>/        │ transform (SQL)          │ build (SQL)
   (live OLTP, hot 90d)                  dt=YYYY-MM-DD/             │                          │
                                         append-only, ALL tables ──┘                          │
                                                                                              │
 Polygon raw archive ─────────────────────────────────▶ silver/* (re-pack ns→ts, →Parquet) ──┘
```

| Tier | Contents | Built how | Mutable? |
|---|---|---|---|
| **Raw archive** (exists) | Polygon CSV.gz, REST JSON.gz, Benzinga JSONL.gz | already downloaded (daily launchd) | append-only |
| **T1 · Bronze** | **Complete mirror of ALL OLTP tables**, date-partitioned | one-time full dump + daily delta | append-only, never rewritten |
| **T2 · Silver** | Market data in **Polygon schema** (Polygon ∪ OLTP-derived) + proprietary signals in canonical schema | SQL transform from Bronze + raw archive | drop & recompute |
| **T3 · Gold** | features, backtest sets, regime tables, ML training sets | SQL build from Silver | drop & recompute |

---

## 3. T1 · Bronze — the OLTP mirror (the piece we build first)

**Rule: nothing is dropped. Every OLTP table is captured. Incremental, not full-dump-daily.**

```
bronze/oltp/<table>/dt=YYYY-MM-DD/data.parquet
```
- **One-time backfill:** for each table, dump all history, partitioned by its natural event date.
- **Daily:** append *only yesterday's* partition. Never re-dump prior days (that's the rejected
  full-dump-daily anti-pattern → would balloon to PB scale).
- **Idempotent:** re-running a date rewrites only that `dt=` partition.

Partition key = each table's event-date column:

| Table | dt = | Table | dt = |
|---|---|---|---|
| trades | `opened_at::date` | uw_flow_alerts | `alerted_at::date` |
| bot_decisions | `scanned_at::date` | uw_insider_trades | `ingested_at::date` |
| bot_advance_* | `*_at::date` | uw_top_movers | `captured_at::date` |
| conviction_scores | `scored_at::date` | uw_congressional_trades | `ingested_at::date` |
| signal_returns | `scored_at::date` | uw_greek_exposure / options_volume | `ingested_at::date` |
| prediction_errors | `recorded_at::date` | benzinga_news (OLTP copy) | `published_at::date` |
| stock_predictions | `created_at::date` | daily_picks | `created_at::date` |
| intraday_bars_1m / databento_ohlcv_1m | `ts_event::date` | backtest_* / static loads | one-time, by row date |

**Why a complete mirror:** once Postgres is trimmed to the hot 90-day window, T1 is the *only*
durable record of everything the project ever produced. It is the lineage / disaster-recovery copy
and the input to all downstream transforms.

### Storage footprint (measured 2026-06-09)
- One-time full backfill of current OLTP (~56 GB heap) → **~15–18 GB Parquet**
- Daily deltas (~14 MB/day heap; 85% is uw_flow_alerts + conviction_scores) → **~8 GB over 10 yr**
- **Total T1 ≈ 25–30 GB / 10 years.** (Conditional: enabling daily minute-bar ingest adds ~120 GB/decade.)

---

## 4. T2 · Silver — conform to Polygon schema

Two cases, because not everything has a Polygon equivalent:

```
 MARKET DATA  → Polygon schema (the canonical target)
   silver/market_bars   ← Polygon minute/day aggs  ∪  OLTP intraday_bars_1m  (+ source col)
   silver/trades        ← Polygon trades
   silver/reference     ← Polygon tickers/details, splits, dividends, financials
   silver/news          ← Benzinga (archive + OLTP copy, deduped)

 PROPRIETARY SIGNALS → internal canonical schema (NO Polygon equivalent), keyed (symbol, ts)
   silver/signals/conviction, /decisions, /uw_flow, /uw_insider, /predictions, /pnl ...
   → JOIN-compatible with silver/market_bars on (symbol, timestamp)
```
- **Polygon** lands near-native — only a mechanical `ns→timestamp` + type cast + → Parquet. No
  business logic. ("T2-native, just re-packed.")
- **OLTP** is the side that needs real transformation to reach Polygon's shape.

---

## 5. T3 · Gold — analytics marts

Rebuilt from Silver, all recomputable:
`gold/features_daily` (= the daily_intraday_features logic over full history), `gold/backtest_*`,
`gold/regime_*` (joins macro/VIX — unblocks `plan_regime_backtest`), `gold/ml_training_set`,
`gold/signal_decay`.

---

## 6. Live bot path is untouched

The live bot reads **PostgreSQL only** (hot 90 days) for sub-100 ms decisions and never touches the
lake. `daily_intraday_features` stays in OLTP as served hot features (read live by
`model-v2-scorer.js`); its full-history twin lives in T3/Gold for training/backtests.

---

## 7. Daily flow

```
 09:00 SGT  launchd: rclone pulls yesterday's Polygon + news → raw archive   (LIVE today)
 17:00 ET   T1: append yesterday's OLTP partitions (all tables)              (to build)
            T2: re-pack new Polygon + transform new OLTP → Silver
            T3: refresh affected Gold marts
            verify row counts + Telegram summary
```

---

## 8. Hardware tiering

**Current machine = Mac Studio M3 Ultra (28 cores, 96 GB) — migration done 2026-06-08.** Nothing is
"deferred to Mac Studio" anymore; this IS it.

| | Current (Mac Studio M3 Ultra + DAS) | Future (+ 40 TB NAS) |
|---|---|---|
| OLTP | Postgres (hot 90d after trim) | same |
| Engines | DuckDB + Python (`lake/`) + Jupyter | same (Spark only if DuckDB ever hits a wall — it won't) |
| Lake | Silver/Gold on /Volumes/Archive DAS (2.9TB) | hot Silver/Gold on NVMe, cold + raw on NAS |

Move the DAS physically → verify with `scripts/build-archive-manifest.sh --verify`.

---

## 9. Decisions locked (2026-06-09)

- ELT medallion (Bronze/Silver/Gold), not in-flight ETL.
- **T1 = complete OLTP mirror, nothing dropped**, per-business-day incremental partitions.
- Polygon = T2-native (canonical schema); only OLTP transforms up to it.
- `intraday_bars_1m` etc. **kept** (one-time dump to T1; not deleted from OLTP for now).
- Stack: **DuckDB-first** + Parquet (no Hadoop). **Spark is contingent** — add it ONLY if DuckDB
  demonstrably hits a wall on the Mac Studio (chiefly the one-time 2.8 TB trades CSV→Parquet job).
  DuckDB 1.5 is strong out-of-core (streams + spills), so a 64–256 GB Mac Studio likely never needs
  Spark. Same logic the plan applied to Hadoop. Raw Parquet first (Iceberg later if needed).
- T1 dumper (`scripts/dump-oltp-to-bronze.mjs`) uses DuckDB's Postgres scanner — written + tested 2026-06-09.
- **Languages:** T1 Bronze = **Node.js** (lives with the app, reuses `pg`/dotenv). T2 Silver + T3 Gold =
  **Python + DuckDB** (`lake/` package, isolated `.venv-lake`) — standard data-eng stack, lines up with
  Jupyter on the Mac Studio. Glue/scheduling = Bash. Data movement = DuckDB SQL throughout.

## 10. Decisions resolved (2026-06-09)

**#1 Financials schema → LONG/TIDY in Silver.**
`silver/reference/financials` = `(ticker, fiscal_period, statement, tag, value, unit, filed_date)`,
one row per line item. NOT wide columns, NOT a JSONB blob. Bronze keeps the raw Polygon JSON
(already in `polygon-rest/financials/`). Rationale: Polygon has hundreds of company-varying tags →
long format means a new tag = new rows, never a schema change (consistent with §12). Gold pivots
whatever tags a feature needs.

**#2 OLTP retention → PER-TABLE by access pattern (not a blanket window).**
- **Evict from OLTP entirely** (live in lake only): `intraday_bars_1m` (45 GB), `databento_ohlcv_1m`
  (4.5 GB), `backtest_prices/scores/returns` (~6 GB). ← reclaims ~60 GB, the real win.
- **Keep 100% in OLTP forever:** small proprietary tables (`trades`, `bot_decisions`,
  `bot_advance_*`, `stock_predictions`, `daily_picks`) — tiny, and edge/lessons logic reads full
  history.
- **Window ~180 d hot in OLTP, older to lake:** medium time-series (`uw_flow_alerts`,
  `conviction_scores`, `uw_top_movers`, `uw_insider_trades`, `signal_returns`, `prediction_errors`).
- `daily_intraday_features` stays hot (live-read by model-v2-scorer) + full history in Gold.
- Only execute eviction AFTER T1+T2 verified GREEN (#3).

**#3 Validation gate → 5-check GREEN/RED, halt-on-RED, partition-level rollback.**
Runs after every daily T1 append:
1. Row-count reconciliation — Bronze partition rows **==** source OLTP rows for that `dt` (EXACT).
2. Freshness — latest partition == yesterday.
3. Schema drift — any unhandled column TYPE change → RED (additive changes pass, see §12).
4. Sample checksum — hash N sample symbols' rows, Bronze vs OLTP, must match.
5. Backtest parity (periodic) — run a reference backtest on OLTP vs lake.
   **Tolerances:** row counts & sums EXACT; aggregate P&L / return metrics within **±0.5%**
   (float/ordering noise); trade direction & signal sign EXACT. Anything outside → RED.
RED ⇒ halt downstream (no Silver/Gold rebuild, no OLTP trim) + Telegram alert.
**Rollback (cheap by design):** Silver/Gold are disposable → drop affected partition, recompute from
Bronze. Bad Bronze partition → re-dump from OLTP (idempotent, within 90 d window). Never a
destructive in-place transform.

**#4 Polygon→Parquet → PHASED by size.**
- Small/medium streams (minute_aggs 42 GB, day_aggs, news, reference) → convert to Parquet
  opportunistically (cheap on current Mac or Mac Studio).
- `trades` (2.8 TB) → convert on Mac Studio (needs the RAM/CPU); until then query CSV.gz directly via
  DuckDB ad-hoc (tick-level use is rare). Most backtests live on minute/day bars → fast lake without
  waiting on the big job.

> Defaults chosen where Pavan said "resolve": #2 window = 180 d; #3 backtest tolerance = ±0.5% on
> aggregate metrics, exact on counts/sums/direction. Override anytime.

## 11. Build sequence

1. ✅ **T1 OLTP dumper** — `scripts/dump-oltp-to-bronze.mjs` WRITTEN + TESTED (2026-06-09).
   Introspection-driven (auto-discovers tables, auto-detects partition col), DuckDB Postgres scanner
   → `<root>/<table>/dt=YYYY-MM-DD/`, modes backfill|daily|snapshot, idempotent, row-count validation
   GREEN/RED, `_catalog.json` drift detection. Tested on small tables; FULL backfill (incl. 45 GB
   intraday_bars_1m) deferred to Mac Studio / weekend. Run: `BRONZE_ROOT=... MODE=backfill node scripts/dump-oltp-to-bronze.mjs`
2. ✅ **Full T1 backfill + daily append** — DONE 2026-06-09. **ALL 80 OLTP tables** in Bronze
   (9.8 GB, 535.9 M rows, 80/80 exact PG↔Parquet match incl. intraday_bars_1m 448.7 M). 0-row tables
   get a schema-only parquet. Daily append wired into `scripts/polygon-daily-incremental.sh`
   (09:00 launchd, `MODE=daily`); the 5 static/rebuilt heavy tables are skipped from the DAILY delta
   (no daily accrual) but ARE in the one-time backfill.
2c. ✅ **SQL interface** — persistent catalog at `/Volumes/Archive/lake.duckdb` (83 views:
    `market_bars_daily_adj`, `market_bars_daily`, `features_daily`, + `oltp_<table>` ×80). Connect any
    SQL tool: CLI `duckdb /Volumes/Archive/lake.duckdb`; browser UI `duckdb /Volumes/Archive/lake.duckdb -ui`
    (http://localhost:4213); DBeaver/DataGrip → DuckDB driver → that file (open READ-ONLY, DuckDB is
    single-writer); Python `duckdb.connect(path, read_only=True)`. Catalog holds only view defs; data
    stays in Parquet. Rebuild: `duckdb /Volumes/Archive/lake.duckdb < /tmp/lake_catalog.sql` (minute/trades
    views omitted to keep bind fast — add on demand). DuckDB is embedded (no host:port, unlike Postgres).
2b. ✅ **Query layer NOW** — `scripts/lake.sh` exposes Bronze OLTP (auto-discovered views,
    `oltp_<table>`) + Polygon archive (`poly_day_aggs`, `poly_minute_aggs`, `news_archive`) as
    schema-on-read DuckDB views. Interactive or one-shot (`bash scripts/lake.sh "SQL"`). Cross-source
    joins (Bronze signals × Polygon bars) work today — no materialization. This is the "query CSV via
    DuckDB meanwhile" path (decision #4) and a lightweight stand-in for Silver until Mac Studio.
3. ✅ **T2 Silver (Python) — MATERIALIZED 2026-06-09 on the Mac Studio M3 Ultra (28-core/96GB):**
   - `silver/market_bars_daily` 24.4M rows (all years, RAW) — ~19s
   - `silver/market_bars_daily_adj` 24.4M rows — **SPLIT-ADJUSTED canonical backtest source**
     (`lake/build_adjusted.py`; cumulative split factors from authoritative Polygon splits; verified
     continuous across NVDA/AAPL/TSLA splits). Use THIS for backtests, not raw or Yahoo backtest_prices.
   - `silver/market_bars_minute` **3.68B rows** (all years, 24,775 symbols) → 44GB — via `lake/convert_raw.py`
     (parallel, resumable; ~12M rows/s)
   - `silver/signals/<table>` all 74 proprietary tables (schema-flexible passthrough)
   - `silver/trades` (2.8TB→Parquet) 🔄 converting in background (`convert_raw trades --jobs 12`, ~hours)
4. ✅ **T3 Gold (Python) — MATERIALIZED:** `gold/signal_forward_returns`. Add more marts (regime,
   ML training) as needed — all fast on this box.
   Engine proof: DuckDB aggregated 148M trades (3.3GB gz) in 50s; built 24M-row daily Silver in 19s.
5. Trim OLTP to 90 days once T1+T2 verified.

> Existing parked ETL scripts (`scripts/etl/*`, `ingest-polygon-minute.mjs`) are reusable as Silver/Gold
> transform building blocks — see `ARCHIVE_RESTORE.md`. They do NOT need to run as-is; this ELT design
> reframes them. The OLTP→Bronze dump (step 1) is NEW and still to be written.

---

## 12. Schema evolution & auto-discovery (REQUIRED)

**Requirement (Pavan, 2026-06-09):** changing the OLTP schema or adding a table must propagate to the
lake automatically — no per-table/per-column hand-editing. The pipeline is **introspection-driven,
not code-driven.**

### T1 · Bronze — fully automatic
- **Table discovery:** dumper reads `information_schema.tables` each run; NO hardcoded table list.
  New OLTP table → dumped next run.
- **Partition column:** per-table, resolved by rule — config override → else first present of
  `closed_at, opened_at, scored_at, scanned_at, captured_at, alerted_at, ingested_at, created_at,
  recorded_at, *_date` → else single snapshot partition.
- **`SELECT *` → additive evolution:** new column appears in new partitions automatically; old
  partitions simply lack it.
- **Read-time merge:** DuckDB `union_by_name=true` / Spark `mergeSchema` → new column reads NULL for
  historical partitions. No rewrite of old data.

### T2 · Silver — registry + default passthrough
- Explicit conform rules only where reshaping is needed (market data → Polygon schema).
- Every other (proprietary) table gets a **default passthrough** → `silver/signals/<table>`
  (type-normalize + standardize symbol/ts keys). New OLTP table reaches Silver with zero new code;
  write a rule only if it needs special shaping.

### T3 · Gold — resilient, new marts are deliberate
- Existing marts keep working as long as their source columns exist (read schema-flexible Silver).
- A NEW mart is always a human decision (business logic).

### The catalog — `bronze/_catalog.json`
Records each table's last-seen schema + partition column + last-loaded date. **Every run diffs live
OLTP vs catalog** and acts + alerts (Telegram):
```
 new table       → auto-start dumping + register
 new column      → auto-included (SELECT *)
 dropped column  → old partitions keep it, new omit (NULL on read)
 TYPE change     → ⚠️ flag for manual Silver cast (the only non-auto case)
```

### Hard case — column TYPE change
Additive changes (table/column add, column drop) are free. An existing column changing TYPE makes
Parquet partitions disagree → not auto-resolvable. Bronze keeps it raw; catalog flags it; fix = a
one-line cast in Silver (or read-as-string). Alert loudly, never silently corrupt.

### Trigger
- Default: runtime introspection (every daily run re-discovers — zero maintenance).
- Optional: `node-pg-migrate` post-`up` hook refreshes the catalog the moment a schema change lands.

**Implication for the Step-1 dumper:** it MUST be written introspection-driven (info_schema +
catalog diff) from day one — not as a hardcoded per-table script.
