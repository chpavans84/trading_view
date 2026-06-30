#!/usr/bin/env bash
# Multi-regime replay: run the SAME engine over historical R2/R3/R4 windows from
# the minute lake. Tests whether the daily-study edge (R2 strong) survives real
# intraday execution, and whether the regime gate correctly stands aside in
# downtrends. Each window: reload sim data (ETL) → run gated strategy.
#
# Survivorship caveat: universe is CURRENT S&P∪NDX membership applied to historical
# dates (today's survivors). Directional read; same universe across windows so the
# cross-regime comparison is fair.
set -uo pipefail
cd "$(dirname "$0")/../../.."

run_window () {
  local label="$1" from="$2" to="$3" extra="${4:-}"
  echo "─── $label  ($from .. $to) ───"
  WINDOW_FROM="$from" WINDOW_TO="$to" bash src/sim/etl/load-data.sh >/dev/null 2>&1
  node src/sim/run.mjs --quiet --from "$from" --to "$to" --run-id "$label" $extra 2>&1 | grep -E "^$label"
}

echo "========== R2 up-volatile (the strategy's supposed edge) =========="
run_window r2_2020sep  2020-09-09 2020-10-07
run_window r2_2024aug  2024-08-08 2024-08-27
run_window r2_2018feb  2018-02-06 2018-03-08

echo "========== R3 down-calm — gate should stand aside =========="
run_window r3_2022summer 2022-07-13 2022-09-12

echo "========== R4 down-vol (incl. COVID) — gate should stand aside =========="
run_window r4_2020covid 2020-03-05 2020-05-18
run_window r4_2022bear  2022-04-29 2022-07-12

echo "========== R4 WITHOUT the regime gate (does the gate earn its keep?) =========="
run_window r4_2020covid_nogate 2020-03-05 2020-05-18 "--regimes R1_up_calm,R2_up_vol,R3_down_calm,R4_down_vol"
run_window r4_2022bear_nogate  2022-04-29 2022-07-12 "--regimes R1_up_calm,R2_up_vol,R3_down_calm,R4_down_vol"
