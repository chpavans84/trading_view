#!/bin/bash
# Fail-fast: any unhandled error / unset var / pipe failure aborts the script
# (added 2026-06-01 — previously psql failures could be silently masked).
set -euo pipefail

# War-room snapshot — quick status check during live market session.
# Created 2026-05-27 for 4-bot launch night.
# Usage:  ./scripts/war-room.sh
#         (run at every checkpoint: +5min, +30min, +1h, +2h, pre-close, post-close)

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════════"
echo -e "  WAR ROOM SNAPSHOT  ·  $(date)"
echo -e "═══════════════════════════════════════════════════════════════${NC}"

# 1. Bot activity in last 10 minutes
echo -e "\n${YELLOW}1. Bot activity (last 10 min)${NC}"
psql tradingbot -F"|" -P "format=aligned" <<'SQL'
SELECT
  b.name,
  COUNT(*)                         AS scans,
  COUNT(*) FILTER (WHERE bd.action='buy')                       AS buys,
  COUNT(*) FILTER (WHERE bd.action='hold')                      AS holds,
  COUNT(*) FILTER (WHERE bd.action='skip_no_candidate')         AS skip_score,
  COUNT(*) FILTER (WHERE bd.action='skip_unclassifiable_setup') AS skip_class,
  MAX(bd.scanned_at)::time(0)      AS last_scan
FROM bots b
LEFT JOIN bot_decisions bd ON bd.bot_id = b.id AND bd.scanned_at > NOW() - INTERVAL '10 minutes'
WHERE b.status='active' AND b.deleted_at IS NULL
GROUP BY b.name ORDER BY b.name;
SQL

# 2. What did the bots buy in the last hour?
echo -e "\n${YELLOW}2. Recent BUYS (last hour)${NC}"
psql tradingbot -F"|" -P "format=aligned" -c "
SELECT
  bd.scanned_at::time(0) AS t,
  b.name AS bot,
  bd.symbol,
  bd.composite_score::numeric(5,1) AS score,
  bd.setup_type
FROM bot_decisions bd JOIN bots b ON b.id = bd.bot_id
WHERE bd.action='buy' AND bd.scanned_at > NOW() - INTERVAL '1 hour'
ORDER BY bd.scanned_at DESC LIMIT 20;"

# 3. Top gate rejections in last 30 min — what's killing trades?
echo -e "\n${YELLOW}3. Top rejection gates (last 30 min)${NC}"
psql tradingbot -F"|" -P "format=aligned" -c "
SELECT key AS gate, SUM(value::int)::int AS rejections
FROM bot_decisions bd, jsonb_each_text(bd.factor_breakdown->'gate_histogram')
WHERE bd.scanned_at > NOW() - INTERVAL '30 minutes'
  AND bd.factor_breakdown ? 'gate_histogram'
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;"

# 4. Open positions
echo -e "\n${YELLOW}4. Open positions (this session)${NC}"
psql tradingbot -F"|" -P "format=aligned" -c "
SELECT
  t.symbol, t.qty, t.entry_price::numeric(10,2) AS entry,
  t.opened_at::time(0) AS opened,
  t.setup_type, b.name AS bot
FROM trades t LEFT JOIN bots b ON b.id = t.bot_id
WHERE t.status='open' AND t.opened_at > NOW() - INTERVAL '12 hours'
ORDER BY t.opened_at DESC LIMIT 15;"

# 5. Symbols passing the conviction pre-warm — what was scored fresh this scan?
echo -e "\n${YELLOW}5. Conviction scores written in last 15 min (top 12 by score)${NC}"
psql tradingbot -F"|" -P "format=aligned" -c "
SELECT symbol, score::int, grade, scored_at::time(0) AS t
FROM conviction_scores
WHERE scored_at > NOW() - INTERVAL '15 minutes'
ORDER BY score DESC NULLS LAST LIMIT 12;"

# 6. Bot heartbeat watchdog status
echo -e "\n${YELLOW}6. Heartbeat status${NC}"
psql tradingbot -tAc "
SELECT
  CASE
    WHEN MAX(scanned_at) > NOW() - INTERVAL '8 minutes'  THEN '🟢 ALIVE (last decision '||AGE(NOW(), MAX(scanned_at))||' ago)'
    WHEN MAX(scanned_at) > NOW() - INTERVAL '30 minutes' THEN '🟡 STALE ('||AGE(NOW(), MAX(scanned_at))||')'
    ELSE                                                      '🔴 SILENT — investigate'
  END
FROM bot_decisions;"

echo -e "\n${BLUE}═══════════════════════════════════════════════════════════════${NC}"
