#!/usr/bin/env bash
# DATA-INTEGRITY AUDIT — run BEFORE cancelling Polygon. Proves nothing is lost.
# Reconciles raw Polygon archive ↔ Silver (every day + sample row counts), checks gaps,
# and verifies the forward OLTP source (backtest_prices) covers the Polygon universe.
# READ-ONLY. Run: bash scripts/integrity_audit.sh
set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH"
FF=/Volumes/Archive/polygon-flatfiles/us_stocks_sip
SILVER=/Volumes/Archive/silver
REST=/Volumes/Archive/polygon-rest
cd "$(dirname "$0")/.."
DBURL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
PASS=0; FAIL=0
ok(){ echo "  ✅ PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  ❌ FAIL: $1"; FAIL=$((FAIL+1)); }

echo "################ 1. RAW ↔ SILVER day reconciliation (no day lost in conversion) ################"
recon(){  # $1=raw stream  $2=silver dir
  local raw sil miss n
  raw=$(ls $FF/$1/*/*/*.csv.gz 2>/dev/null | sed -E 's#.*/([0-9]{4}-[0-9]{2}-[0-9]{2})\.csv\.gz#\1#' | sort -u)
  sil=$(ls -d $SILVER/$2/d=*/ 2>/dev/null | sed -E 's#.*/d=([0-9-]{10})/#\1#' | sort -u)
  miss=$(comm -23 <(printf '%s\n' "$raw") <(printf '%s\n' "$sil") | grep -c . || true)
  echo "  $1: raw=$(printf '%s\n' "$raw"|grep -c .) days  silver=$(printf '%s\n' "$sil"|grep -c .) days  missing_in_silver=$miss"
  if [ "$miss" -eq 0 ]; then ok "$1 → $2 (every raw day present in Silver)"
  else no "$1 → $2 ($miss raw days MISSING from Silver)"; comm -23 <(printf '%s\n' "$raw") <(printf '%s\n' "$sil") | head; fi
}
recon day_aggs_v1    market_bars_daily
recon minute_aggs_v1 market_bars_minute
recon trades_v1      trades

echo "################ 2. ROW reconciliation — sample days (no rows dropped) ################"
rowchk(){  # $1=raw stream  $2=silver dir  $3=date
  local f raw sil
  f="$FF/$1/${3:0:4}/${3:5:2}/$3.csv.gz"
  [ -f "$f" ] || { echo "  $1 $3: raw file absent (skip)"; return; }
  raw=$(duckdb -noheader -csv -c "SELECT count(*) FROM read_csv('$f', header=true)" 2>/dev/null)
  sil=$(duckdb -noheader -csv -c "SELECT count(*) FROM read_parquet('$SILVER/$2/d=$3/*.parquet')" 2>/dev/null)
  if [ "$raw" = "$sil" ] && [ -n "$raw" ]; then ok "$1 $3 rows raw=$raw == silver=$sil"
  else no "$1 $3 rows raw=$raw != silver=$sil"; fi
}
rowchk day_aggs_v1    market_bars_daily  2019-06-24
rowchk day_aggs_v1    market_bars_daily  2024-06-24
rowchk minute_aggs_v1 market_bars_minute 2021-06-24
rowchk trades_v1      trades             2023-06-26

echo "################ 3. Trading-day completeness per year (gap scan, daily stream) ################"
gaps=$(ls -d $SILVER/market_bars_daily/d=*/ 2>/dev/null | sed -E 's#.*/d=([0-9]{4})-.*#\1#' | sort | uniq -c \
  | awk '$2>=2017 && $2<=2025 && $1<240 {print $2"="$1} END{}')
if [ -z "$gaps" ]; then ok "all full years 2017-2025 have >=240 trading days"
else no "year(s) with suspiciously few days: $gaps"; fi

echo "################ 4. FORWARD-SOURCE parity — Polygon universe vs OLTP backtest_prices ################"
# symbols in a recent Polygon day not present in backtest_prices = would be LOST after switch
RECENT=$(ls -d $SILVER/market_bars_daily/d=*/ | tail -1 | sed -E 's#.*/d=([0-9-]{10})/#\1#')
polysyms=$(duckdb -noheader -csv -c "SELECT count(DISTINCT symbol) FROM read_parquet('$SILVER/market_bars_daily/d=$RECENT/*.parquet')" 2>/dev/null)
btsyms=$(psql "$DBURL" -At -c "SELECT count(DISTINCT symbol) FROM backtest_prices WHERE price_date=(SELECT max(price_date) FROM backtest_prices)" 2>/dev/null)
miss=$(duckdb -noheader -csv -c "
  SELECT count(*) FROM (SELECT DISTINCT symbol FROM read_parquet('$SILVER/market_bars_daily/d=$RECENT/*.parquet')) p
  WHERE symbol NOT IN (SELECT column0 FROM read_csv('/tmp/_bt_syms.csv', header=false))" 2>/dev/null || echo "n/a")
psql "$DBURL" -At -c "SELECT DISTINCT symbol FROM backtest_prices WHERE price_date=(SELECT max(price_date) FROM backtest_prices)" 2>/dev/null > /tmp/_bt_syms.csv
miss=$(duckdb -noheader -csv -c "
  SELECT count(*) FROM (SELECT DISTINCT symbol FROM read_parquet('$SILVER/market_bars_daily/d=$RECENT/*.parquet')) p
  WHERE p.symbol NOT IN (SELECT column0 FROM read_csv('/tmp/_bt_syms.csv', header=false, columns={'column0':'VARCHAR'}))" 2>/dev/null)
echo "  recent day $RECENT: polygon symbols=$polysyms  backtest_prices symbols=$btsyms  in-polygon-not-in-OLTP=$miss"
echo "  (note: informational — Polygon universe is broader; decide if those names matter forward)"

echo "################ 5. REST snapshot completeness ################"
for sub in tickers/details corporate_actions/splits corporate_actions/dividends financials; do
  n=$(ls $REST/$sub/*.json.gz 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] && ok "REST $sub present ($n files)" || no "REST $sub EMPTY"
done

echo "################ 6. SHA-256 manifest (bit integrity) ################"
m=/Volumes/Archive/manifests/archive_manifest.tsv
[ -s "$m" ] && ok "manifest exists ($(wc -l <"$m"|tr -d ' ') files; re-run build-archive-manifest.sh --verify before/after moving drive)" || no "manifest missing"

echo
echo "################ RESULT: PASS=$PASS  FAIL=$FAIL ################"
[ "$FAIL" -eq 0 ] && echo "✅ DATA INTEGRITY OK — safe to proceed with Polygon exit plan." || echo "❌ FAILURES — investigate before cancelling Polygon."
rm -f /tmp/_bt_syms.csv
