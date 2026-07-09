#!/bin/bash
# One-shot (scheduled 2026-07-07): ACTIVATE Fix A (min-hold floor) AFTER market close by
# setting bot 4's rules.exits.min_hold_hours to 6 (BOT_SIM-calibrated). Fix A code was
# deployed earlier the same day but held inert via min_hold_hours=0. Idempotent; safe to
# re-run. Self-removes its own cron line after success. See GOTCHAS + retrospective_alpaca.
set -euo pipefail
cd /Users/pavan/Documents/Claude_Projects/trading_view/tradingview-mcp
set -a; source .env; set +a
LOG=/Volumes/Archive/polygon-flatfiles/logs/fix-a-flip.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
psql "$DATABASE_URL" -c "
UPDATE bots_advance
   SET rules = jsonb_set(
         CASE WHEN rules ? 'exits' THEN rules ELSE rules || '{\"exits\":{}}'::jsonb END,
         '{exits,min_hold_hours}', '6'::jsonb, true),
       updated_at = NOW()
 WHERE id = 4;" >> "$LOG" 2>&1
VAL=$(psql "$DATABASE_URL" -Atc "select rules->'exits'->>'min_hold_hours' from bots_advance where id=4")
echo "$(date '+%F %T %Z') Fix A ACTIVATED — bot 4 min_hold_hours=${VAL}" >> "$LOG"
# self-remove this cron line (idempotent regardless; dated cron only fires once anyway)
( crontab -l 2>/dev/null | grep -v 'flip-min-hold-fix-a.sh' ) | crontab - || true
echo "$(date '+%F %T %Z') cron line removed" >> "$LOG"
