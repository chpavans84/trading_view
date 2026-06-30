#!/usr/bin/env bash
# Multi-regime walk-forward for the `breakout` strategy vs `pullback` baseline.
# Each window: reload sim data once (load-data.sh), run both strategies (same regime gate,
# same 4bps slippage). Tests whether the volume-confirmed-breakout edge survives OUTSIDE a
# calm bull — the only thing that makes the 2026 R1 result trustworthy.
# See reports/breakout-study-20260620/.
set -uo pipefail
cd "$(dirname "$0")/../../.."

STRATS=(breakout pullback)

run_window () {
  local wlabel="$1" from="$2" to="$3"
  echo "═══════════ $wlabel ($from..$to) ═══════════"
  WINDOW_FROM="$from" WINDOW_TO="$to" bash src/sim/etl/load-data.sh >/tmp/wf_load_${wlabel}.log 2>&1 \
    || { echo "  LOAD FAILED (see /tmp/wf_load_${wlabel}.log)"; return; }
  for s in "${STRATS[@]}"; do
    node src/sim/run.mjs --quiet --from "$from" --to "$to" --strategy "$s" --run-id "${wlabel}__${s}" 2>&1 \
      | grep -E "^${wlabel}__${s}" || echo "  ${s}: no result (check run)"
  done
}

run_window R1_2026calm    2026-05-11 2026-06-10   # calm bull  (the in-sample window)
run_window R2_2024aug     2024-08-08 2024-08-27   # up-vol V-snapback
run_window R2_2020sep     2020-09-09 2020-10-07   # up-vol grind
run_window R2_2018feb     2018-02-06 2018-03-08   # volmageddon
run_window R3_2022bear    2022-04-01 2022-06-17   # bear leg (gate should mostly stand aside)
run_window R4_2020covid   2020-03-05 2020-05-18   # crash    (gate should stand aside)
echo "═══════════ DONE ═══════════"
