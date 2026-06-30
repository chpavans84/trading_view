#!/usr/bin/env bash
# Rolling multi-year walk-forward for statistical power. One ~3-week window per quarter,
# 2018→2026 (34 windows), breakout vs pullback, REALISTIC momentum-aware slippage.
# Aggregated at the TRADE level (thousands of trades) so "robust" vs "noise" is decidable.
# Run IDs: roll_<YYYYMM>__<strategy>. See reports/breakout-study-20260620/.
set -uo pipefail
cd "$(dirname "$0")/../../.."
export SIM_SLIP_MODEL=realistic

# Strategies to run per window (override via ROLL_STRATS env, space-separated).
read -r -a STRATS <<< "${ROLL_STRATS:-breakout pullback}"
run_window () {
  local label="$1" from="$2" to="$3"
  WINDOW_FROM="$from" WINDOW_TO="$to" bash src/sim/etl/load-data.sh >/tmp/roll_load_${label}.log 2>&1 \
    || { echo "$label LOAD FAIL"; return; }
  for s in "${STRATS[@]}"; do
    local rid="${RUN_PREFIX:-roll}_${label}__${s}"
    node src/sim/run.mjs --quiet --from "$from" --to "$to" --strategy "$s" --run-id "$rid" 2>&1 \
      | grep -E "^${rid}" || echo "  ${rid}: no result"
  done
}

for yr in 2018 2019 2020 2021 2022 2023 2024 2025; do
  for mo in 02 05 08 11; do
    echo "─── ${yr}-${mo} ───"
    run_window "${yr}${mo}" "${yr}-${mo}-04" "${yr}-${mo}-26"
  done
done
echo "─── 2026 ───"
run_window 202602 2026-02-04 2026-02-26
run_window 202605 2026-05-04 2026-05-26
echo "═══════════ ROLLING DONE ═══════════"
