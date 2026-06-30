#!/usr/bin/env bash
# Step 3 (#2) — market-bounce filter. Targets the one R2 window nothing fixed
# (Sep-2020, a grinding selloff). Hypothesis: only enter when SPY itself is
# bidding intraday (≥ its own VWAP). ETL now also loads SPY's minute bars.
set -uo pipefail
cd "$(dirname "$0")/../../.."

VARIANTS=(
  "M0base|"
  "M1mkt|--entry {\"require_market_bounce\":true}"
  "M2mkt_reclaim|--entry {\"require_market_bounce\":true,\"mode\":\"reclaim\"}"
  "M3reclaim|--entry {\"mode\":\"reclaim\"}"
)

run_grid () {
  local wlabel="$1" from="$2" to="$3"
  echo "═══════════ $wlabel ($from..$to) ═══════════"
  WINDOW_FROM="$from" WINDOW_TO="$to" bash src/sim/etl/load-data.sh >/dev/null 2>&1
  for v in "${VARIANTS[@]}"; do
    local name="${v%%|*}"; local extra="${v#*|}"
    node src/sim/run.mjs --quiet --from "$from" --to "$to" --run-id "${wlabel}_${name}" $extra 2>&1 | grep -E "^${wlabel}_${name}"
  done
}

run_grid g_sep20 2020-09-09 2020-10-07
run_grid g_aug24 2024-08-08 2024-08-27
run_grid g_feb18 2018-02-06 2018-03-08
