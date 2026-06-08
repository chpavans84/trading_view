# Data Lake Pipeline Plan — OLTP (Postgres) → OLAP (Iceberg/Parquet on Archive)

**Status:** PLAN / not yet implemented. Authored on the work branch.
**Goal:** Build a single-node analytical data lake for backtesting. Two feeds:
1. **Historic** — convert the Polygon flat files already on the Archive drive
   (`us_stocks_sip/{day_aggs, minute_aggs, trades}`, 2017+, ~2.9TB) into
   partitioned Parquet/Iceberg tables.
2. **Recurring EOD** — after market close, push the day's OLTP rows from
   Postgres `tradingbot` into the same lake.

Backtests then query the lake (deep history) instead of the small 3yr Postgres
`backtest_prices` window.

> ⚠️ This plan was drafted in a remote container that **cannot see** `/Volumes/Archive`,
> the live DB, or the real Polygon file layout. Phase 0 ("Verify on Studio") must
> confirm column formats, file layout, table sizes, and free space before any job runs.
> "No faith-based changes — backtest before ship."

---

## 1. Architecture decision (LOCKED)

**Stack: Spark (local mode) + Apache Iceberg + DuckDB. No HDFS, no YARN.**

Rationale: a single Mac Studio (M3 Ultra, 28-core, 96GB, arm64) with an external
Thunderbolt drive does not benefit from HDFS — it's a clustered block store that on
one node gives replication=1 plus daemon overhead, and is fragile layered over APFS on
a drive that can unmount. We get the Hadoop *ecosystem* (Spark + Parquet + Iceberg)
without the cluster-only storage/scheduler layers.

| Component | Role |
|-----------|------|
| **Spark 3.5 (local[*])** | Heavy one-time historic conversion + nightly EOD batch. `file:///Volumes/Archive/...`, no HDFS. |
| **Apache Iceberg** | Table format on Archive — ACID, `MERGE INTO` upserts, schema evolution, time-travel, partition mgmt, compaction. Catalog = **Hadoop catalog** (filesystem metadata, no Hive metastore service). |
| **DuckDB** | Fast serving layer the Node app / `backtest.js` queries. Reads Iceberg + Parquet directly, embeds via `duckdb` npm. |

Spark writes, DuckDB reads. Postgres stays the live OLTP system of record.

---

## 2. Install (macOS arm64 / Homebrew)

```bash
brew install openjdk@17                 # Spark 3.5 → Java 17
sudo ln -sfn /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk \
     /Library/Java/JavaVirtualMachines/openjdk-17.jdk
brew install apache-spark               # 3.5.x: spark-submit, spark-sql, pyspark, spark-shell
brew install duckdb
brew install awscli                     # Phase C only: sync missing Polygon flatfiles

# Node serving binding
npm i duckdb                            # or @duckdb/node-api
```

Jars pulled at job time via `--packages` (no manual install):
- `org.apache.iceberg:iceberg-spark-runtime-3.5_2.12:1.5.x`
- `org.postgresql:postgresql:42.7.x` (Spark→OLTP JDBC)
- `org.apache.hadoop:hadoop-aws` + `com.amazonaws:aws-java-sdk-bundle` (Phase C S3 client only — NOT the daemons; match Spark's bundled Hadoop 3.3.x)

`~/spark-defaults` (or `--conf` flags) for the Iceberg Hadoop catalog:
```properties
spark.sql.extensions               org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions
spark.sql.catalog.lake             org.apache.iceberg.spark.SparkCatalog
spark.sql.catalog.lake.type        hadoop
spark.sql.catalog.lake.warehouse   file:///Volumes/Archive/lake/warehouse
spark.sql.shuffle.partitions       64
spark.driver.memory                32g
```

---

## 3. Lake layout on Archive

```
/Volumes/Archive/lake/
  raw/                                  # immutable source — never mutate
    polygon/us_stocks_sip/
      day_aggs_v1/    yyyy/mm/*.csv.gz
      minute_aggs_v1/ yyyy/mm/*.csv.gz
      trades_v1/      yyyy/mm/*.csv.gz
  warehouse/                            # Iceberg-managed Parquet (zstd)
    polygon.daily      (partition: years(ts))
    polygon.minute     (partition: months(ts); sort symbol,ts)
    polygon.trades     (partition: days(ts);   sort symbol,ts)
    oltp.trades        (partition: days(event_ts))
    oltp.conviction_scores
    oltp.bot_decisions
    oltp.daily_pnl
    oltp.uw_options_flow
  catalog/                              # iceberg hadoop-catalog metadata
  checkpoints/  _tmp/                   # job checkpoints + atomic staging
```

**Partitioning (the crux):**
- `polygon.daily` — ~20M rows total. Partition `years(ts)`, sort by symbol. Trivial.
- `polygon.minute` — large. Partition `months(ts)`, **sort (symbol, ts)** so per-symbol
  backtests get Parquet row-group pruning.
- `polygon.trades` — billions/yr. Partition `days(ts)`. Target 128–512MB files via
  `repartition`; run Iceberg `rewrite_data_files` compaction to fix small files.

**Timezone:** Polygon `window_start` is nanosecond-epoch **UTC**. Store a UTC `ts TIMESTAMP`
**and** a derived ET `trade_date DATE` for partition/predicate use. All backtests are ET-aware.

---

## 4. Schemas

### 4.1 Polygon flat files (VERIFY columns in Phase 0)
Canonical Polygon flatfile columns:
- **day_aggs_v1 / minute_aggs_v1:** `ticker, volume, open, close, high, low, window_start (ns UTC), transactions`
- **trades_v1:** `ticker, conditions, correction, exchange, id, participant_timestamp, price, sequence_number, sip_timestamp, size, tape, trf_id, trf_timestamp`

Iceberg DDL (aggs):
```sql
CREATE TABLE lake.polygon.daily (
  symbol STRING, ts TIMESTAMP, trade_date DATE,
  open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
  volume BIGINT, transactions BIGINT
) USING iceberg PARTITIONED BY (years(ts))
  TBLPROPERTIES ('write.parquet.compression-codec'='zstd');
-- polygon.minute: PARTITIONED BY (months(ts)), write.sort-order = symbol, ts
-- polygon.trades: PARTITIONED BY (days(ts)),   write.sort-order = symbol, ts
```

### 4.2 OLTP → Iceberg (real columns confirmed from db.js)
| OLTP table | Watermark column | Merge key | Notes |
|------------|------------------|-----------|-------|
| `trades` | `GREATEST(opened_at, COALESCE(closed_at, opened_at))` | `order_id` (or `id`) | **No `updated_at`** — must use GREATEST. JSONB cols (`conviction_breakdown`) → store as STRING/Iceberg struct. |
| `conviction_scores` | `scored_at` | `id` | append-only |
| `bot_decisions` | `scanned_at` | `id` | append-only; `factor_breakdown` JSONB→string |
| `daily_pnl` | `updated_at` | `date` (UNIQUE) | upsert via MERGE on date |

---

## 5. Pipeline A — historic backfill (Polygon CSV.gz → Iceberg)

One-time, idempotent (overwrite-by-partition keyed on date so re-runs are safe).
Order: **day_aggs → minute_aggs → trades** (smallest first = quick parity win).

```python
# jobs/backfill_polygon_aggs.py  — run: spark-submit --packages <iceberg,...> jobs/backfill_polygon_aggs.py daily 2017 2026
import sys
from pyspark.sql import SparkSession, functions as F
dataset, y0, y1 = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
src = f"file:///Volumes/Archive/lake/raw/polygon/us_stocks_sip/{dataset}_aggs_v1"
tbl = f"lake.polygon.{ 'daily' if dataset=='day' else dataset }"
spark = SparkSession.builder.appName(f"backfill-{dataset}").getOrCreate()
df = (spark.read.option("header", True).option("compression", "gzip").csv(f"{src}/*/*/*.csv.gz")
      .selectExpr("ticker AS symbol",
                  "timestamp_micros(CAST(window_start/1000 AS BIGINT)) AS ts",
                  "CAST(open AS DOUBLE) open","CAST(high AS DOUBLE) high",
                  "CAST(low AS DOUBLE) low","CAST(close AS DOUBLE) close",
                  "CAST(volume AS BIGINT) volume","CAST(transactions AS BIGINT) transactions")
      .withColumn("trade_date", F.to_date(F.from_utc_timestamp("ts", "America/New_York")))
      .filter(F.year("ts").between(y0, y1)))
(df.sortWithinPartitions("symbol", "ts")
   .writeTo(tbl).using("iceberg").option("overwrite-mode", "dynamic")
   .partitionedBy(F.years("ts")).createOrReplace())
```
Then validate: per-day source row counts vs lake counts → manifest table. `gzip` is not
splittable, so parallelism is per daily file (fine — files are small).

---

## 6. Pipeline B — EOD OLTP → OLAP (recurring batch)

Scheduled `spark-submit` after market close via the existing bot cron infra
(~16:30 ET). **Micro-batch, not streaming.** Watermark per table stored in the
existing `system_kv` table.

```python
# jobs/eod_oltp_to_lake.py
JDBC = "jdbc:postgresql://localhost:5432/tradingbot"
TABLES = {
  "trades":            ("GREATEST(opened_at, COALESCE(closed_at, opened_at))", "order_id"),
  "conviction_scores": ("scored_at",  "id"),
  "bot_decisions":     ("scanned_at", "id"),
  "daily_pnl":         ("updated_at", "date"),
}
for name, (wm_expr, key) in TABLES.items():
    last = read_kv(f"lake_wm.{name}")                       # from system_kv, default epoch
    q = f"(SELECT *, {wm_expr} AS _wm FROM {name} WHERE {wm_expr} > '{last}') t"
    src = spark.read.format("jdbc").option("url", JDBC).option("dbtable", q).load()
    if src.head(1):
        src.createOrReplaceTempView("delta")
        spark.sql(f"""MERGE INTO lake.oltp.{name} t USING delta s
                      ON t.{key} = s.{key}
                      WHEN MATCHED THEN UPDATE SET *
                      WHEN NOT MATCHED THEN INSERT *""")
        write_kv(f"lake_wm.{name}", src.agg(F.max("_wm")).first()[0])
```
JSONB columns arrive as strings over JDBC — keep as STRING in the lake (queryable in
DuckDB via `json_extract`). Append-only tables can skip MERGE and `appendPartition`.

---

## 7. Pipeline C — sync missing Polygon files (later)

```bash
aws s3 sync s3://flatfiles/us_stocks_sip/day_aggs_v1/ \
  /Volumes/Archive/lake/raw/polygon/us_stocks_sip/day_aggs_v1/ \
  --endpoint-url https://files.polygon.io
# repeat for minute_aggs_v1, trades_v1 (only the 3 datasets we have access to)
```
Then re-run Pipeline A for the new date range only.

---

## 8. Serving layer — DuckDB from Node

```sql
INSTALL iceberg; LOAD iceberg;
SELECT * FROM iceberg_scan('/Volumes/Archive/lake/warehouse/polygon/daily')
WHERE symbol = 'NVDA' AND trade_date BETWEEN DATE '2019-01-01' AND DATE '2024-12-31';
```
`backtest.js` gains a DuckDB path for deep history; keep the Postgres `backtest_prices`
path for the live app's small window.

---

## 9. Phased rollout (each phase gated by verification)

0. **Verify on Studio** — real Archive layout & Polygon columns; DB table sizes;
   **free space on Archive** (Parquet+zstd adds ~0.5–1TB on top of 2.9TB); Java/arch.
1. Install Java17 + Spark + DuckDB + jars; smoke test: local-mode read one day file → write one Parquet.
2. Iceberg Hadoop catalog; convert **daily** end-to-end; wire DuckDB; **parity-check a backtest vs Postgres.**
3. Convert **minute**; tune partition/sort/file-size/zstd.
4. Convert **trades** (small-file care + `rewrite_data_files` compaction).
5. EOD Pipeline B + cron + `system_kv` watermark + row-count monitoring (start: trades, conviction_scores, bot_decisions, daily_pnl).
6. Point `backtest.js` at lake; document in CLAUDE.md + memory file.

---

## 10. Risks & open questions

- **Single-copy raw data.** The lake is reproducible from `raw/`; `raw/` (2.9TB) is the
  only copy on one external drive. Back up `raw/` separately.
- **Drive unmount** mid-job → fail loudly; jobs are idempotent so just re-run.
- **Small-file problem** on trades/minute → `repartition` + Iceberg compaction.
- **JSONB over JDBC** → strings in lake; document the `json_extract` access pattern.
- **OPEN — parked `oltp-backfill` migration.** The migration runbook parks an
  `oltp-backfill` migration "for the pipeline-architecture session." This plan likely IS
  that session. Confirm what the parked migration intended before building Pipeline B —
  this EOD pipeline may supersede or feed it. Do NOT unpark it blindly.
- **`bot_decisions` columns** — code inserts `setup_type`/`thesis` not present in the
  db.js base DDL (added by a later ALTER). Pull live columns from `information_schema`
  at job build time rather than hardcoding.
