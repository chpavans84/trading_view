/**
 * DASHBOARD REGISTRY — the single source of truth for tabs, widgets, permissions, and the
 * API contract each surface depends on.
 *
 * WHY THIS EXISTS: to stop drift/hallucination. Add a tab/widget/endpoint HERE and it flows
 * automatically to permissions (server.js imports the lists below) and to the contract test
 * (tests/registry-contract.test.js walks ENDPOINT_CONTRACTS and asserts every one still
 * responds). A removed/broken endpoint becomes a red test, not a silent production break.
 *
 * RULE: when you add a dashboard tab or widget, add it here + add its backing endpoint(s) to
 * ENDPOINT_CONTRACTS. Do NOT redeclare these lists elsewhere.
 */

// ─── Permission lists (imported by server.js — do not duplicate there) ──────────
// 'stats' merged into 'health' (2026-05-25); both kept for back-compat (TAB_PAGE_MAP aliases).
export const ALL_TABS = [
  'home', 'dashboard', 'trades', 'scores', 'market', 'news', 'health', 'stats', 'docs',
  'research', 'admin_bot', 'bot_rules', 'calendar', 'watchlist', 'signal_center',
  'trading_desk', 'discover', 'bots', 'screener', 'ext_hours', 'retrospective', 'top_picks',
  'ownership', 'bot_sim',
];

export const ALL_WIDGETS = [
  'moomoo', 'alpaca_live', 'tiger', 'force_trade', 'chat', 'stock_explorer', 'notifications',
];

export const DEFAULT_PERMISSIONS = {
  admin:  { tabs: ALL_TABS, widgets: ALL_WIDGETS },
  viewer: {
    tabs: [
      'home', 'dashboard', 'trades', 'scores', 'market', 'news', 'research', 'bot_rules',
      'calendar', 'watchlist', 'signal_center', 'trading_desk', 'discover', 'bots',
      'screener', 'ext_hours', 'retrospective', 'top_picks', 'ownership',
    ],
    widgets: ['alpaca_live', 'chat', 'stock_explorer', 'notifications'],
  },
};

// ─── API contract (walked by the contract test) ─────────────────────────────────
// auth: 'user' = requires login, 'public' = no auth. path includes sample params so the
// endpoint returns real data. The test fails an entry only on 404 (route gone) or 500
// (route crashes) — the two failure modes that matter.
export const ENDPOINT_CONTRACTS = [
  // core dashboard / P&L
  { key: 'dashboard',        path: '/api/dashboard',                              auth: 'user'   },
  { key: 'positions',        path: '/api/positions',                             auth: 'user'   },
  { key: 'trades',           path: '/api/trades?limit=5',                        auth: 'user'   },
  { key: 'pnl_scores',       path: '/api/scores',                                auth: 'public' },
  { key: 'ownership',        path: '/api/screener/ownership?limit=10',           auth: 'user'   },
  { key: 'forecast',         path: '/api/forecast?limit=5',                      auth: 'user'   },
  { key: 'top_picks',        path: '/api/predictions/top',                       auth: 'user'   },
  { key: 'watchlist',        path: '/api/watchlist',                             auth: 'user'   },
  // market / calendar
  { key: 'market',           path: '/api/market?limit=5',                        auth: 'public' },
  { key: 'market_status',    path: '/api/market-status',                         auth: 'public' },
  { key: 'earnings',         path: '/api/earnings-calendar?date=2026-06-09',     auth: 'user'   },  // endpoint REQUIRES ?date=
  // Unusual Whales widgets
  { key: 'uw_flow',          path: '/api/uw/options-flow?limit=5',               auth: 'user'   },
  { key: 'uw_flow_alerts',   path: '/api/uw/flow-alerts?limit=5',                auth: 'user'   },
  { key: 'uw_flow_history',  path: '/api/uw/flow-alerts-history?hours=24&limit=5', auth: 'user' },
  { key: 'uw_insider',       path: '/api/uw/insider?limit=5',                    auth: 'user'   },
  { key: 'uw_congress',      path: '/api/uw/congressional?limit=5',              auth: 'user'   },
  { key: 'uw_correlations',  path: '/api/uw/correlations?ticker=AAPL',           auth: 'user'   },
  { key: 'uw_movers',        path: '/api/uw/movers',                             auth: 'user'   },
  // sentinel / alerts / journal
  { key: 'sentinel',         path: '/api/sentinel/recent?limit=5',               auth: 'user'   },
  { key: 'system_alerts',    path: '/api/system-alerts/recent',                  auth: 'user'   },
  { key: 'notes',            path: '/api/notes',                                 auth: 'user'   },
  { key: 'reminders',        path: '/api/reminders',                             auth: 'user'   },
  { key: 'notifications',    path: '/api/notifications',                          auth: 'user'   },
  // health / stats / chat
  { key: 'stats',            path: '/api/stats',                                 auth: 'user'   },
  { key: 'health',           path: '/api/health',                                auth: 'public' },
  { key: 'health_history',   path: '/api/health/history?hours=24',               auth: 'user'   },
  { key: 'logs_sources',     path: '/api/logs/sources',                          auth: 'user'   },
  { key: 'logs_tail',        path: '/api/logs/tail?source=pm2:trading-dashboard-out.log&lines=5', auth: 'user' },
  { key: 'sim_runs',         path: '/api/sim/runs',                              auth: 'user'   },
  { key: 'sim_trades',       path: '/api/sim/trades?run_id=sim_baseline',        auth: 'user'   },
  { key: 'sim_lessons',      path: '/api/sim/lessons?run_id=sim_learn',          auth: 'user'   },
  { key: 'sim_verify',       path: '/api/sim/verify?run_id=sim_baseline',        auth: 'user'   },
  { key: 'chat_history',     path: '/api/chat/history',                          auth: 'user'   },
];
