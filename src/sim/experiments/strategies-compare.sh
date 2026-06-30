#!/usr/bin/env bash
# Compare the research-backed strategies head-to-head across regimes:
#   pullback (current) · reversal (deeper-loser upgrade) · opening-range (intraday momentum)
# Each window: reload data once, run all three. Same regime gate, same costs.
set -uo pipefail
cd "$(dirname "$0")/../../.."

STRATS=(pullback reversal opening-range)

run_window () {
  local wlabel="$1" from="$2" to="$3"
  echo "═══════════ $wlabel ($from..$to) ═══════════"
  WINDOW_FROM="$from" WINDOW_TO="$to" bash src/sim/etl/load-data.sh >/dev/null 2>&1
  for s in "${STRATS[@]}"; do
    node src/sim/run.mjs --quiet --from "$from" --to "$to" --strategy "$s" --run-id "${wlabel}__${s}" 2>&1 | grep -E "^${wlabel}__${s}"
  done
}

run_window R1_2026     2026-05-11 2026-06-10   # calm bull (our current window)
run_window R2_2024aug  2024-08-08 2024-08-27   # up-vol V-snapback
run_window R2_2020sep  2020-09-09 2020-10-07   # up-vol grind
run_window R2_2018feb  2018-02-06 2018-03-08   # volmageddon
run_window R4_2020covid 2020-03-05 2020-05-18  # crash (gate should mostly stand aside)
