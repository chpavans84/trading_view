#!/usr/bin/env bash
# Step 3 — hunt for the trend-RESUMPTION filter that separates V-snapbacks (win)
# from knife-catches (lose). For each R2 window, load it ONCE, then run every
# entry-filter variant on the same data. Goal: turn the 2 losing R2 windows
# positive WITHOUT killing the 2024-08 winner.
set -uo pipefail
cd "$(dirname "$0")/../../.."

# variant name | extra args
VARIANTS=(
  "F0_base|"
  "F1_reclaim|--entry {\"mode\":\"reclaim\"}"
  "F3_rs|--setup {\"require_rs_positive\":true}"
  "F4_sma50|--setup {\"require_above_sma50\":true}"
  "F5_reclaim_rs|--entry {\"mode\":\"reclaim\"} --setup {\"require_rs_positive\":true}"
  "F6_reclaim_rs_sma50|--entry {\"mode\":\"reclaim\"} --setup {\"require_rs_positive\":true,\"require_above_sma50\":true}"
)

run_grid () {
  local wlabel="$1" from="$2" to="$3"
  echo "═══════════ $wlabel ($from..$to) ═══════════"
  WINDOW_FROM="$from" WINDOW_TO="$to" bash src/sim/etl/load-data.sh >/dev/null 2>&1
  for v in "${VARIANTS[@]}"; do
    local name="${v%%|}"; name="${v%%|*}"; local extra="${v#*|}"
    node src/sim/run.mjs --quiet --from "$from" --to "$to" --run-id "${wlabel}_${name}" $extra 2>&1 | grep -E "^${wlabel}_${name}"
  done
}

run_grid r2sep20  2020-09-09 2020-10-07
run_grid r2aug24  2024-08-08 2024-08-27
run_grid r2feb18  2018-02-06 2018-03-08
