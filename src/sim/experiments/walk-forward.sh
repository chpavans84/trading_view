#!/usr/bin/env bash
# Walk-forward out-of-sample test: reversal vs pullback across ~16 independent
# windows spanning 2017→2026 (every year, every regime). Each window = fresh
# capital. The regime gate blocks the deep-bear windows (expected → ~0 trades).
# Goal: confirm reversal's cross-regime robustness is real, not 5-window luck.
set -uo pipefail
cd "$(dirname "$0")/../../.."

# label  from  to
WINDOWS=(
  "w17a 2017-02-13 2017-03-10"
  "w17b 2017-07-10 2017-08-04"
  "w18feb 2018-02-05 2018-03-02"
  "w18oct 2018-10-08 2018-11-02"
  "w19a 2019-01-07 2019-02-01"
  "w19b 2019-08-05 2019-08-30"
  "w20covid 2020-03-09 2020-04-03"
  "w20sep 2020-09-08 2020-10-02"
  "w21a 2021-03-08 2021-04-01"
  "w21b 2021-11-08 2021-12-03"
  "w22bear 2022-06-06 2022-07-01"
  "w23a 2023-02-06 2023-03-03"
  "w23b 2023-07-10 2023-08-04"
  "w24apr 2024-04-08 2024-05-03"
  "w24aug 2024-08-05 2024-08-29"
  "w25 2025-05-05 2025-05-30"
  "w26 2026-05-11 2026-06-10"
)

for spec in "${WINDOWS[@]}"; do
  set -- $spec; label=$1; from=$2; to=$3
  WINDOW_FROM="$from" WINDOW_TO="$to" bash src/sim/etl/load-data.sh >/dev/null 2>&1
  for s in reversal pullback; do
    node src/sim/run.mjs --quiet --from "$from" --to "$to" --strategy "$s" --run-id "wf_${label}__${s}" 2>&1 | grep -E "^wf_${label}__${s}"
  done
done
