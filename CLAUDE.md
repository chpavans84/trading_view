# TradingView MCP — Claude Instructions

79 tools for reading and controlling a live TradingView Desktop chart via CDP (port 9222), plus Moomoo portfolio integration.

## Decision Tree — Which Tool When

### "Analyze my chart" / "Do I have a position in X?" / "What's my chart + portfolio?"
Use **`portfolio_chart_snapshot`** — it's one call that fetches everything in parallel:
- Current chart symbol, timeframe, indicators
- Real-time price (OHLC, volume)
- All indicator values (RSI, MACD, EMAs, etc.)
- Key price levels from custom Pine indicators
- Your Moomoo positions (highlights any position in the current symbol)
- Account balance and buying power

This is the primary analysis tool. Use it first for any question combining chart + account data.

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              OFFLINE ML RESEARCH PIPELINE                           │
│                      (weekend cron Sat 10 PM ET + nightly 2 AM ET)                 │
│                                                                                     │
│  Yahoo Finance API                                                                  │
│       │                                                                             │
│       ▼                                                                             │
│  download-prices.js ──► backtest_prices   (3yr OHLCV, S&P500/NASDAQ100/VIX/SPY)   │
│       │                                                                             │
│       ▼                                                                             │
│  compute-scores.js  ──► backtest_scores   (RSI, EMA, MACD, BB, RVOL per date)     │
│       │                                                                             │
│       ▼                                                                             │
│  backtest.js        ──► backtest_returns  (fwd returns 1d/1w/1m/3m, dip flags)    │
│       │                                                                             │
│       ▼                                                                             │
│  train-model.js     ──► model_results     (logistic regression weights, AUC/F1)   │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │  getFactorWeights() — 24h cache
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              LIVE SCORING & TRADING                                 │
│                                                                                     │
│  scoring.js  ◄── ML grade adjustments (A/B/C/F weights from model_results)         │
│      │            + Yahoo Finance (RSI, EMA, MACD, BB, RVOL, earnings, insider)    │
│      │            + news.js (sentiment, earnings surprise)                          │
│      │            + sentiment.js (relative strength vs SPY, VIX regime)            │
│      │            + tradingview-bridge.js (Pine levels from chart)                 │
│      │                                                                              │
│      ▼  conviction score 0–100                                                     │
│  AI Scanner Bot (cron) ──► stock-selector.js ──► trader.js ──► Alpaca Paper API   │
│                                                                                     │
│  Web Dashboard (Express, port 3000) ──────────────────────────────────────────     │
│  ├── /api/trade/force  ──────────────────────► trader.js ──► Alpaca Paper API     │
│  ├── /api/trade/quick  ──────────────────────► trader.js ──► Alpaca Paper API     │
│  ├── /api/trade/close  ──────────────────────► trader.js ──► Alpaca Paper API     │
│  ├── /api/moomoo/*     ──────────────────────► moomoo-tcp.js ──► Futu OpenD       │
│  └── /api/chat (SSE)   ──────────────────────► ai-chat.js                         │
│           │                                                                         │
│           ▼  Question routing (knowledge.js)                                       │
│           ├─ keyword match score ≥ 2 → knowledge_chunks (instant, $0)             │
│           ├─ vector similarity > 0.55 → knowledge_chunks (Ollama embed, $0)       │
│           ├─ isTradeHistoryQuestion() → DB query + Ollama llama3.2:3b ($0)        │
│           ├─ isFundamentalScreeningQuestion() → PostgreSQL fundamentals ($0)       │
│           └─ Claude Sonnet (prediction / analysis / trading decisions)             │
│                   ▼  Tools available to Claude                                     │
│                   ├─ get_stock_prediction → predictor.js (5 algorithms, $0)       │
│                   ├─ get_portfolio / propose_trade / close_position → Alpaca      │
│                   ├─ moomoo_portfolio / moomoo_place_trade → Futu OpenD           │
│                   ├─ scan_for_trades → scoring.js conviction engine               │
│                   ├─ get_earnings / get_news / get_live_quote → Yahoo/SEC/Alpaca  │
│                   └─ get_chart_technicals / get_price_levels → TradingView CDP    │
│                                                                                     │
│  System prompt always includes (rebuilt per request):                              │
│    • Held positions' next earnings dates (Yahoo Finance calendarEvents, 30m cache) │
│    • Recent trading lessons from closed trades (5m cache)                          │
│    • Win-rate patterns by market regime (5m cache)                                 │
│    • Voice mode flag → compresses reply to ≤3 sentences, no markdown              │
│                                                                                     │
│  All trade paths ──► recordTrade() / closeTrade() ──► PostgreSQL trades table      │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────────────────┐
│                              5-ALGORITHM PREDICTOR (predictor.js)                   │
│                              Runs in parallel, zero LLM cost, 15-min cache         │
│                                                                                     │
│  1. Linear Regression Trend  — slope, R², projected_day5, projected_day10          │
│  2. ATR Expected Move        — Wilder ATR-14 → ±ranges for 1/5/10 days            │
│  3. Momentum Score (0–100)   — RSI + EMA9/20/50 + MACD + volume trend             │
│  4. Personal Trade Edge      — win rate, profit factor, best hour/day from trades  │
│  5. Earnings Catalyst        — revenue trend, EPS momentum, next earnings date     │
│                                                                                     │
│  Combined → overall_signal 0–100 (momentum 30% + trend 25% + earnings 20% + edge) │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────────────────┐
│                    PREDICTION CALIBRATION (prediction-calibration.js)               │
│                    Learns from historical errors, runs after each EOD fill          │
│                                                                                     │
│  trainCalibration()       — runs after fillTodayActuals(); learns:                  │
│    • per-symbol bias correction (e.g. MU consistently under-predicts by 3%)        │
│    • per-symbol vol_scale + dir_accuracy                                            │
│    • global R²-bucket error/direction stats (key finding: high R² = worst acc)     │
│    • global bullish bias (model predicts UP more than stocks actually go up)        │
│                                                                                     │
│  applyCalibration(symbol, changePct, rSq) — adjusts raw prediction:               │
│    • additive bias correction (weighted by sample_size/10)                          │
│    • R² reversal damper: if R²>0.6 and dir_acc<35%, multiply by 0.5               │
│    • returns confidence 0–100 + _bias_correction + _reversal_factor                │
│                                                                                     │
│  applyCalibrationToDay(projPct, factors) — re-applies same factors to any day     │
│                                                                                     │
│  Integration points:                                                                │
│    • generateWeekPredictions() — stores adjusted_change_pct + confidence           │
│    • get_stock_prediction tool  — adds calibration{} block to Claude's response    │
│    • GET /api/forecast          — exposes adjusted_change_pct + confidence per day │
│    • GET /api/forecast/failure-analysis — worst symbols, R² bucket stats           │
│    • POST /api/forecast/train-calibration — manual retrain trigger                 │
│    • Crons: auto-retrain Mon 8:30 AM ET + after each daily EOD fill               │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────────────────┐
│                                 PostgreSQL                                          │
│  trades              ← every buy/sell from all UI paths (force/quick/close/bot)    │
│  conviction_scores   ← live scoring history                                        │
│  trade_rejections    ← guard-block audit log (time, VIX, duplicate blocks)        │
│  knowledge_chunks    ← trading education KB (keyword index + vector embeddings)    │
│  fundamentals        ← quarterly revenue, EPS, net income per symbol              │
│  backtest_prices     ← 3yr OHLCV for S&P500 + NASDAQ100                           │
│  backtest_scores     ← historical indicator snapshots                              │
│  backtest_returns    ← forward return labels for ML training                      │
│  model_results       ← trained model weights + AUC/accuracy/F1                    │
│  stock_predictions   ← weekly 5-day forecasts (pred + actual + adjusted + conf)   │
│  prediction_calibration        ← per-symbol bias, vol_scale, dir_accuracy         │
│  prediction_calibration_global ← R² bucket stats, bullish bias                    │
│  prediction_errors             ← one row per filled prediction for analysis        │
│  user_activity       ← all UI actions                                              │
│  conversation_history← chat context per chatId (20-message rolling window)        │
│  sentinel_runs       ← one row per sentinel execution (mode, risks, proposals)    │
│  pending_actions     ← HMAC-signed one-click trade proposals; expires in 30 min   │
│  uw_options_flow     ← unusual options flow alerts (ingested every 5 min)         │
│  uw_insider_trades   ← insider buy/sell filings from Unusual Whales (15 min)      │
│  uw_congressional_trades ← congressional trading disclosures (hourly)             │
└─────────────────────────────────────────────────────────────────────────────────────┘

Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

**ML model:** logistic regression (pure JS) · features: RSI, MACD sign, EMA trend, BB position, vol ratio, conviction score, VIX, day-of-week · target: `ret_1w > 0.5%` · output: grade adjustments `{ A: +8, B: +3, C: -2, F: -9 }` applied to live scores · fallback: backtest alpha heuristic when no model trained

**Predictor model:** pure JS, no external libraries · Algorithm 1 (linear regression) shares OHLCV fetch with 2 and 3 · Algorithm 4 queries PostgreSQL trades table directly · Algorithm 5 uses yahoo-finance2 for authenticated calendarEvents · all 5 run via Promise.allSettled so one failure doesn't block the rest

**Prediction calibration:** uses shared db.js query pool (no separate pg.Pool) · trainCalibration() requires ≥5 actuals; skips gracefully otherwise · applyCalibrationToDay() applies the same _bias_correction + _reversal_factor to each forecast day without extra DB calls (O(1) DB calls per symbol, not O(days)) · R² reversal paradox: R²>0.6 stocks have only ~14% direction accuracy — strong momentum over-extrapolated, then reverses

**Knowledge routing:** keyword search uses min word length ≥ 5 and requires score ≥ 2 to avoid false positives · vector search uses nomic-embed-text (Ollama) with similarity threshold 0.55 · `isKnowledgeQuestion()` blocks prediction/forecast/explain patterns and routes them to Claude instead · Ollama Q&A is fully removed — fallback on error is `{ source: 'error' }` → Claude handles it

**Pipeline npm scripts:** `research:download` → `research:scores` → `research:backtest` → `research:train`

**Pre-Close Sentinel** (`src/core/sentinel.js`): Runs weekdays 3 PM ET + Sundays 6 PM ET. Scans all Alpaca + Moomoo positions for 8 risk signals (earnings, news, calibration accuracy, sector concentration, macro events, unusual_options, insider_selling, congressional_activity). The last 3 require UW_API_KEY. Macro events are now pulled live from Unusual Whales economic calendar with static fallback. High-severity risks get deterministic one-click HMAC-signed trade proposals. Claude (sonnet-4-6) writes ONLY the prose explanation from pre-built facts — it never invents tickers, prices, or quantities. LLM output is never parsed for trade parameters; every number in a proposal is decided in Node code. One-click links: `GET /api/action/execute/:id?token=` and `GET /api/action/ignore/:id?token=` — registered before `requireAuth`, use HMAC-SHA256 token auth only. Manual trigger: `POST /api/sentinel/run` (admin only). HTML response pages in `src/core/sentinel-pages.js`. Env vars required: `SENTINEL_EMAIL_FROM`, `SENTINEL_EMAIL_TO`, `PUBLIC_URL`, `ACTION_SIGNING_SECRET`.

**Unusual Whales Integration** (`src/core/unusual-whales.js`): Personal use only — ONE rate-limited client (120 req/min, 80,000 req/day). Dual token bucket rate limiter. In-memory TTL cache. WebSocket streaming for real-time options flow (auto-reconnect, exponential backoff). Exported methods: `getFlowAlerts`, `getMarketTide`, `getOptionsFlow`, `getInsiderTrades`, `getCongressionalTrades`, `getTopMovers`, `getEconomicCalendar`, `getIpoCalendar`, `getFundamentals`, `getAnalystTargets`, `getEarningsTranscript`, `getCorrelations`, `getDrawdown`, `getIvRank`, `getStockState`, `getQuota`, `streamOptionsFlow`. All routes consuming UW data are `requireAuth`-gated. If `UW_API_KEY` is missing, every feature degrades gracefully (returns null/503). Env var: `UW_API_KEY`. Ingestion crons: movers every 5 min, flow alerts every 2 min (market hours), insider every 15 min, congress every 1 hr, economic cal + IPO cal at 6 AM ET, fundamentals cache warmup at 6 PM ET. Daily UW maintenance crons: 3 AM retention purge (`uw-retention.js`) · 4 AM quota low-water alarm · 7 AM schema linter (`uw-schema-linter.js`) · 8 AM data-quality report (`uw-data-quality.js`). API routes: `GET /api/uw/flow-alerts`, `/api/uw/flow-alerts-history`, `/api/uw/market-tide`, `/api/uw/options-flow`, `/api/uw/insider`, `/api/uw/congressional`, `/api/uw/movers`, `/api/uw/correlations`, `/api/uw/quota`. Sentinel routes: `/api/sentinel/recent`, `/api/sentinel/runs/:id`. DB tables: `uw_options_flow`, `uw_insider_trades`, `uw_congressional_trades`, `uw_flow_alerts`, `uw_top_movers`, `uw_economic_calendar`, `uw_ipo_calendar`. Claude AI tools: `get_options_flow`, `get_insider_activity`, `get_congressional_activity`, `get_top_movers_uw`, `get_economic_calendar`, `get_correlations`. Dashboard widgets: 🐋 Options Flow, 👤 Insider, 🏛️ Congress, 🔗 Correlations, 📊 Flow History, 📨 Sentinel Activity (inside P&L Dashboard tab strip). Stock Explorer: shows UW options flow + insider activity in collapsible sections alongside analyst rating and news.

**Custom Ollama model:** `npm run ollama:build` → generates `trading-coach.Modelfile` from last 90 days of PostgreSQL trade data → `ollama create trading-coach -f trading-coach.Modelfile`

---

## Web Dashboard — Built Features Inventory
> Keep this section updated after every feature addition. It is the single source of truth that survives context compression.

### Top-nav tabs (id → label)
| id | Label | Notes |
|----|-------|-------|
| tab-dashboard | P&L Dashboard | Renamed from "Dashboard". Two-column layout: left sidebar (account metrics) + right main (positions, trades, P&L chart) |
| tab-market | Market | Market overview, home stats |
| tab-stats | Stats | Usage stats, cost per day |
| tab-docs | Docs | Architecture docs, DB schema |
| tab-calendar | Calendar | Earnings calendar, FDA, dividends |
| tab-signal-center | Signal Center | Catalyst scan, signal graph |
| tab-trading-desk | Trading Desk | Moomoo-style 3-column layout: watchlist left, chart+header center, stats/signals/conviction right. Live WebSocket prices. APIs: /api/watchlist, /api/quote/:sym, /api/explorer/extras, /api/chart-data/:sym |
| tab-research | Research | Research pipeline |
| tab-users | Users | Admin only |
| tab-admin | Admin | Admin only |
| tab-explorer | Stock Explorer | Floating panel, opened via nav button |

### Dashboard widget tabs (inside P&L Dashboard)
| key | Label |
|-----|-------|
| positions | Open Positions + Daily P&L chart + P&L history table |
| trades | Recent Trades |
| catalysts | 🎯 Tomorrow's Catalysts *(planned move → Signal Center)* |
| intraday | Intraday Picks |
| watchlist | ❤️ Watchlist |
| cp | 📈 Trade Results *(planned move → Signal Center)* |
| tradehistory | 📋 Trade History |
| **notes** | **📝 Notes — personal trade journal. Free-text notes saved to PostgreSQL `user_notes` table. Features: add note with title+body, list all notes newest-first, delete note. BUILT IN PREVIOUS SESSION — needs to be verified/rebuilt if missing.** |
| uw_flow | 🐋 Options Flow — Unusual Whales real-time options alerts (60s refresh). Requires UW_API_KEY. |
| uw_insider | 👤 Insider Trades — Form 4 insider filings from Unusual Whales. Requires UW_API_KEY. |
| uw_congress | 🏛️ Congressional Trades — STOCK Act disclosures from Unusual Whales. Requires UW_API_KEY. |
| uw_correlations | 🔗 Correlations — 30d/90d correlation vs market instruments. Requires UW_API_KEY + ticker input. |
| uw_flow_history | 📊 Flow History — DB-backed options flow alerts (last 24h/7d). Filter by premium. Auto-refresh 60s. |
| sentinel_runs | 📨 Sentinel Activity — last 20 sentinel runs with risk/proposal counts. Click row for full JSON detail. Auto-refresh 5min. |

### Floating / overlay widgets
- **Chat widget** (Akshaya AI) — draggable, touch-enabled, saves position. FAB button + nav button. Logo: `GARUDA_SEARCH.PNG`.
- **Stock Explorer** — left-side floating panel, touch resize on iPad, overlay mode on tablet (backdrop).
- **News Drawer** — right-side sliding drawer.
- **Notifications panel** — top-right overlay.
- **Reminders** — `user_reminders` table, AI `set_reminder` tool, `GET/POST /api/reminders`, `PATCH/DELETE /api/reminders/:id`.

### Themes
| id | Description |
|----|-------------|
| vexai | Default dark navy |
| github | GitHub dark |
| midnight | Deep blue |
| dracula | Dracula purple |
| tokyo | Tokyo Night |
| solarized | Solarized dark |
| cyberpunk | Cyberpunk pink |
| matrix | Green-on-black, Share Tech Mono font |
| bluematrix | Cyan-on-black, Share Tech Mono font |

### Key DB tables (web dashboard)
`trades` · `conviction_scores` · `trade_rejections` · `knowledge_chunks` · `fundamentals` · `backtest_*` · `model_results` · `stock_predictions` · `prediction_calibration*` · `prediction_errors` · `user_activity` · `conversation_history` · `user_reminders` · **`user_notes`** (title, body, username, created_at) · `uw_flow_alerts` (alerted_at, premium, sentiment — 2-min cron, 90d retention) · `uw_top_movers` (captured_at, direction — 5-min cron, 30d retention) · `uw_economic_calendar` (event_date, event_name, country — 6 AM cron) · `uw_ipo_calendar` (ticker, ipo_date — 6 AM cron) · `push_subscriptions` (username, endpoint, p256dh, auth — UNIQUE(username,endpoint)) · `webauthn_credentials` (username, credential_id BYTEA UNIQUE, public_key BYTEA, counter BIGINT, device_name)

### Phase 5 — PWA Push + Biometric (mobile.html)
- **Service worker**: `src/web/public/sw.js` — scope `/`, handles push events + notificationclick deep-link to `/mobile.html`
- **Push opt-in**: non-blocking chip `#push-chip` shown after first user interaction (never on page load — Safari rate-limits). Click calls `subscribePush()` → `Notification.requestPermission()` → `PushManager.subscribe()` → `POST /api/push/subscribe`
- **Critical push**: `system-alerts.js` calls `sendCriticalPush()` fire-and-forget when `severity='critical'`; stale subscriptions (HTTP 410) auto-deleted
- **WebAuthn**: `registerBiometric()` → `/api/webauthn/register/begin|finish`; `authenticateBiometric()` → `/api/webauthn/authenticate/begin|finish`. `userVerification:'required'` on both. Button `#biometric-btn` shown when `window.PublicKeyCredential` is available.
- **Optimistic UI**: Buy order injects pending `.pos-row-pending` card into `#positions-body` before server responds; reconciled on result (removed + home refresh on success, removed + toast on error)
- **Haptic**: 200ms on new critical alert in `pollAlertBadge`; [30,50,30] on order placed success

#### New API routes (Phase 5)
| Route | Auth | Description |
|-------|------|-------------|
| `GET /api/push/vapid-key` | none | Returns `{ vapidPublicKey }` (public key safe to expose) |
| `POST /api/push/subscribe` | required | Upsert push subscription for session user |
| `DELETE /api/push/unsubscribe` | required | Remove push subscription by endpoint |
| `POST /api/webauthn/register/begin` | required | Generate WebAuthn registration options |
| `POST /api/webauthn/register/finish` | required | Verify + store credential |
| `POST /api/webauthn/authenticate/begin` | required | Generate authentication options |
| `POST /api/webauthn/authenticate/finish` | required | Verify assertion, sets `req.session.biometric_verified=true` |

#### Env vars (Phase 5)
- `VAPID_PUBLIC_KEY` — base64url VAPID public key (generate with `npx web-push generate-vapid-keys`)
- `VAPID_PRIVATE_KEY` — base64url VAPID private key (never commit)
- `VAPID_SUBJECT` — `mailto:` or `https:` URL identifying sender
- `WA_RP_NAME` — Relying Party name shown in biometric prompts (default: `Trading Dashboard`)
- `PUBLIC_URL` — also used as WebAuthn expected origin (already required by Sentinel)

### Phase 6 — Polish, Menu, Accessibility, Offline (mobile.html)
**Status: SHIPPED (May 2026, 6 commits)**
- Bundle size: ~160 KB (under 200 KB hard limit)
- Test coverage: 15 unit tests in `tests/mobile.test.js` — all pass (`node --test tests/mobile.test.js`)
- Lighthouse scores: run `npm run lighthouse:mobile` or Chrome DevTools → Lighthouse → Mobile to get current numbers; paste here after first run
- Backup retained at `src/web/public/mobile-v1.html` for emergency rollback

**Phase 6 features:**
- **☰ Overflow menu drawer**: slides from right, 85% width max 380px, swipe-right-to-dismiss, ESC key close, focus trap + restore. Three sections: Account (avatar, username/role, broker status, balance), Tools (Notes/Reminders/Bot Config/Stats each open a bottom sheet), Settings (dark/push/biometric/privacy toggles + sign-out)
- **Accessibility (WCAG AA)**: focus trap inside bottom sheets and menu drawer, ESC closes both, `#sr-live` assertive live region for critical alerts + order placed + tab change announcements, visible `:focus-visible` rings, bottom nav `role="tablist"` + `role="tab"` + `aria-selected`
- **Performance**: shimmer animation converted to `transform: translateX` via `::after` (hardware-accelerated), reduced-motion skips bottom-sheet spring (instant show/hide), `:focus-visible` CSS-only focus rings
- **Offline support** (sw.js v6): static shell cache-first, `/api/dashboard`+`/api/forecast`+`/api/uw/flow-alerts` stale-while-revalidate, other `/api/*` network-first with 5 s timeout, background-sync queue for trade POSTs (IndexedDB), `#offline-banner` shown on `navigator.onLine` change
- **Screen-reader announcements**: tab switch, order placed, critical alert arrival via `announce()` helper + assertive live region

**13. Mobile is shipped. Future mobile changes are additive — don't refactor the 5-tab architecture without explicit ask.**

### Server ops
- PM2 processes: `trading-dashboard` (port 3000, production) · `trading-staging` (UAT) · `trading-bot` (cron bot)
- Restart: `pm2 restart trading-dashboard trading-staging` — **never use pkill**
- After modifying `.env`, restart with `pm2 restart trading-dashboard --update-env` — plain `pm2 restart` does NOT re-read env vars. Same applies to `trading-bot` and any other PM2 app.
- Images served from: `images/` project root → `/images/` URL path
- Background image: `images/New_backgraound.PNG` (NYSE bull, opacity 0.18)
- GARUDA AI logo: `images/GARUDA_SEARCH.PNG`

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`
