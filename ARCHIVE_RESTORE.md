# Archive Restore Runbook — HDD → PostgreSQL

How to re-ingest the Polygon/Benzinga archive on `/Volumes/Archive` back into PostgreSQL.
**Last verified: 2026-06-09.**

> ⚠️ **READ BEFORE RUNNING.** The per-stream ETL loaders below are part of the OLTP-backfill
> pipeline that Pavan **PARKED** on 2026-06-05 pending a concrete architecture plan
> (see memory `plan_oltp_backfill.md` + `plan_olap_spark_parquet.md`). This file documents
> *how* to restore; it does **not** authorize a full backfill run. Do a single-day / single-symbol
> test first, confirm the OLTP↔OLAP boundary, then run at scale. **Do not bulk-load `trades`
> into Postgres** — see note at bottom.

---

## Prerequisites

1. **Archive volume mounted** — `/Volumes/Archive` (the DAS). All loaders read from here.
2. **PostgreSQL running** — `pg_isready` ok; `DATABASE_URL` set in `.env` (loaders read it via dotenv).
3. **Schema applied** — `node-pg-migrate up` (migrations create the target tables below).
4. Run all commands from repo root (`cd .../tradingview-mcp`) so dotenv finds `.env`.

Quick health check:
```bash
ls /Volumes/Archive/polygon-flatfiles/us_stocks_sip   # volume mounted?
pg_isready                                             # postgres up?
psql "$DATABASE_URL" -c "\dt intraday_bars_1m"         # schema present?
```

---

## What restores where

| Archive stream (on `/Volumes/Archive`) | Loader | Target table | Status |
|---|---|---|---|
| `polygon-flatfiles/.../minute_aggs_v1/*.csv.gz` | `scripts/ingest-polygon-minute.mjs --root <path>` | `intraday_bars_1m` | ✅ exists (pass `--root`) |
| same (aggregated to daily) | `scripts/etl/build-daily-features-from-hdd.mjs` | `daily_intraday_features` | ✅ exists (reads HDD) |
| `benzinga-news/*.jsonl.gz` | `scripts/etl/load-benzinga-news.mjs` | `benzinga_news` | ✅ exists |
| `polygon-rest/corporate_actions/{splits,dividends}/*.json.gz` | `scripts/etl/load-corporate-actions.mjs` | `corporate_actions` | ✅ exists |
| `polygon-rest/financials/*.json.gz` | `scripts/etl/load-polygon-financials.mjs` | `polygon_financials` | ✅ exists |
| `polygon-flatfiles/.../day_aggs_v1/*.csv.gz` | — | (none) | ❌ no loader (see Gaps) |
| `polygon-flatfiles/.../trades_v1/*.csv.gz` | — | (none) | ❌ DO NOT load to PG (DuckDB) |
| `polygon-rest/tickers/details/*.json.gz` | — | (none) | ❌ no loader (see Gaps) |

All loaders are **idempotent** (ON CONFLICT … DO NOTHING/UPDATE) — safe to re-run; they skip/overwrite existing rows.

---

## Commands

**1. Minute bars → `intraday_bars_1m`** (uses Postgres `COPY`, ~25–40s/day)
```bash
# Point --root at the ARCHIVE (default is ~/polygon-data, which is NOT the archive):
node scripts/ingest-polygon-minute.mjs \
  --root /Volumes/Archive/polygon-flatfiles/us_stocks_sip/minute_aggs_v1 \
  --from 2026-06-01 --to 2026-06-08          # test a small range FIRST
# full restore: --from 2016-06-01 --to <today>   (444M+ rows, ~70GB/yr — confirm OLTP retention first)
node scripts/ingest-polygon-minute.mjs --root <archive> --resume   # skip days already loaded
```

**2. Daily features → `daily_intraday_features`** (reads HDD directly; ~5–6h full with 4 workers)
```bash
FROM=2026-06-01 TO=2026-06-08 node scripts/etl/build-daily-features-from-hdd.mjs   # test range
ONLY=AAPL,NVDA node scripts/etl/build-daily-features-from-hdd.mjs                   # single symbols
DRY=1 node scripts/etl/build-daily-features-from-hdd.mjs                            # dry run
```

**3. News / corporate actions / financials**
```bash
node scripts/etl/load-benzinga-news.mjs        # benzinga-news/*.jsonl.gz  → benzinga_news
node scripts/etl/load-corporate-actions.mjs    # splits+dividends          → corporate_actions
node scripts/etl/load-polygon-financials.mjs   # financials/*.json.gz      → polygon_financials
```

**4. Orchestrated (all of the above)** — `scripts/etl/run-all-backfills.sh` (PARKED — review before running).

---

## Verify after a restore
```bash
psql "$DATABASE_URL" -c "SELECT count(*), min(ts_event), max(ts_event) FROM intraday_bars_1m;"
psql "$DATABASE_URL" -c "SELECT count(*), min(price_date), max(price_date) FROM daily_intraday_features;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM benzinga_news;"
psql "$DATABASE_URL" -c "SELECT action_type, count(*) FROM corporate_actions GROUP BY 1;"
```

---

## Integrity manifest (verify the archive itself)

Before trusting a restore — or after physically moving the DAS to the Mac Studio — verify the
files haven't bit-rotted:
```bash
bash scripts/build-archive-manifest.sh           # build SHA-256 manifest (resumable, ~hours for 2.8TB)
bash scripts/build-archive-manifest.sh --verify  # re-hash, report any MISMATCH vs manifest
```
Manifest lives at `/Volumes/Archive/manifests/archive_manifest.tsv` (travels with the drive).

---

## Gaps / TODO (no loader yet)

- **`day_aggs_v1` (daily OHLCV)** — no Postgres loader and no daily-bars table. Either add a
  COPY-based loader (mirror `ingest-polygon-minute.mjs`) into a new `daily_bars` table, OR derive
  daily bars from `intraday_bars_1m` / `daily_intraday_features` and skip a separate table.
- **`tickers/details`** — no loader. Would need a `ticker_details` table; the JSON is one object
  per `{SYM}.json.gz` (name, market_cap, cik, figi, sector, etc.).
- **`trades_v1` (2.82 TB)** — **intentionally not loaded into Postgres.** Too large for OLTP; this
  is the target of the Parquet + DuckDB lake in `plan_olap_spark_parquet.md`. Query the `.csv.gz`
  directly with DuckDB, or convert to Parquet, rather than ingesting to PG.
