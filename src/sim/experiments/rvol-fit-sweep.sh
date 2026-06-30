#!/usr/bin/env bash
# Held-out fit: sweep breakout's rvol_min (the proven lever) across 2018→2026 windows for the
# regime-switch book. Selection uses TRAIN years (2018-2023) only; TEST years (2024-2026) are
# evaluated with the train-chosen value (done in analysis). One load per window, 3 rvol runs each.
# Run IDs: sweep_<YYYYMM>__rv<val>. See reports/breakout-study-20260620/.
set -uo pipefail
cd "$(dirname "$0")/../../.."
export SIM_SLIP_MODEL=realistic
RVOLS=(1.0 1.5 2.5)

run_window () {
  local label="$1" from="$2" to="$3"
  WINDOW_FROM="$from" WINDOW_TO="$to" bash src/sim/etl/load-data.sh >/tmp/sweep_load_${label}.log 2>&1 \
    || { echo "$label LOAD FAIL"; return; }
  for rv in "${RVOLS[@]}"; do
    BO_RVOL_MIN="$rv" node src/sim/run.mjs --quiet --from "$from" --to "$to" \
      --strategy regime-switch --run-id "sweep_${label}__rv${rv}" 2>&1 \
      | grep -E "^sweep_${label}__rv${rv}" || echo "  sweep_${label}__rv${rv}: no result"
  done
}

for yr in 2018 2019 2020 2021 2022 2023 2024 2025; do
  for mo in 02 05 08 11; do echo "─── ${yr}-${mo} ───"; run_window "${yr}${mo}" "${yr}-${mo}-04" "${yr}-${mo}-26"; done
done
echo "─── 2026 ───"
run_window 202602 2026-02-04 2026-02-26
run_window 202605 2026-05-04 2026-05-26
echo "═══════════ SWEEP DONE ═══════════"
