#!/usr/bin/env bash
# DuckDB query layer over the lake — makes Bronze (OLTP) + the Polygon archive queryable NOW,
# joinable in one place, with zero materialization (schema-on-read views).
#
#   bash scripts/lake.sh                       # interactive DuckDB shell with all views loaded
#   bash scripts/lake.sh "SELECT ..."          # run one query and exit
#   bash scripts/lake.sh -f query.sql          # run a .sql file
#
# Views created:
#   oltp_<table>      ← every Bronze OLTP table (auto-discovered, union_by_name → schema-flexible)
#   poly_day_aggs     ← Polygon daily bars (CSV.gz, ns→ts, Polygon schema)
#   poly_minute_aggs  ← Polygon minute bars (CSV.gz)   [lazy: scans on query]
#   news_archive      ← Benzinga news JSONL.gz
set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH"

BRONZE="${BRONZE_ROOT:-/Volumes/Archive/bronze/oltp}"
FF="/Volumes/Archive/polygon-flatfiles/us_stocks_sip"
NEWS="/Volumes/Archive/benzinga-news"
INIT="$(mktemp /tmp/lake_init.XXXX.sql)"
trap 'rm -f "$INIT"' EXIT

{
  echo "SET TimeZone='America/New_York';"
  # --- Bronze OLTP: one view per table dir (auto-discovered) ---
  for d in "$BRONZE"/*/; do
    name="$(basename "$d")"
    [ -d "$d" ] || continue
    # skip 0-row tables (dir exists but no parquet was written)
    find "$d" -name '*.parquet' -print -quit | grep -q . || continue
    echo "CREATE OR REPLACE VIEW oltp_${name} AS SELECT * FROM read_parquet('${d}**/*.parquet', union_by_name=true, hive_partitioning=true);"
  done
  # --- Polygon market data (raw CSV.gz, conformed at read time to Polygon schema) ---
  echo "CREATE OR REPLACE VIEW poly_day_aggs AS
        SELECT ticker AS symbol, CAST(to_timestamp(window_start/1e9) AS DATE) AS d,
               to_timestamp(window_start/1e9) AS ts_utc,
               open, high, low, close, volume, transactions
        FROM read_csv('${FF}/day_aggs_v1/*/*/*.csv.gz', header=true, union_by_name=true);"
  echo "CREATE OR REPLACE VIEW poly_minute_aggs AS
        SELECT ticker AS symbol, to_timestamp(window_start/1e9) AS ts_utc,
               open, high, low, close, volume, transactions
        FROM read_csv('${FF}/minute_aggs_v1/*/*/*.csv.gz', header=true, union_by_name=true);"
  echo "CREATE OR REPLACE VIEW news_archive AS
        SELECT * FROM read_json('${NEWS}/*/*/*.jsonl.gz', format='newline_delimited', union_by_name=true);"
} > "$INIT"

nviews=$(grep -c 'CREATE OR REPLACE VIEW' "$INIT")
echo "lake.sh: $nviews views ready (Bronze OLTP auto-discovered + Polygon archive)" >&2

if [ "$#" -eq 0 ]; then
  exec duckdb -init "$INIT"                              # interactive (init runs on startup)
elif [ "$1" = "-f" ]; then
  duckdb -c "$(cat "$INIT"); $(cat "$2")"               # views + file query in one batch
else
  duckdb -c "$(cat "$INIT"); $1"                        # views + query in one batch
fi
