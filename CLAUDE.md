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
`trades` · `conviction_scores` · `trade_rejections` · `knowledge_chunks` · `fundamentals` · `backtest_*` · `model_results` · `stock_predictions` · `prediction_calibration*` · `prediction_errors` · `user_activity` · `conversation_history` · `user_reminders` · **`user_notes`** (title, body, username, created_at) · `uw_flow_alerts` (alerted_at, premium, sentiment — 2-min cron, 90d retention) · `uw_top_movers` (captured_at, direction — 5-min cron, 30d retention) · `uw_economic_calendar` (event_date, event_name, country — 6 AM cron) · `uw_ipo_calendar` (ticker, ipo_date — 6 AM cron)

### Server ops
- PM2 processes: `trading-dashboard` (port 3000, production) · `trading-staging` (UAT) · `trading-bot` (cron bot)
- Restart: `pm2 restart trading-dashboard trading-staging` — **never use pkill**
- **After modifying `.env`, ALWAYS restart with `--update-env`**: `pm2 restart trading-dashboard --update-env`. Plain `pm2 restart` does NOT re-read env vars (PM2 caches them at spawn time). Same for all PM2 apps.
- Images served from: `images/` project root → `/images/` URL path
- Background image: `images/New_backgraound.PNG` (NYSE bull, opacity 0.18)
- GARUDA AI logo: `images/GARUDA_SEARCH.PNG`

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`

---

## Sentinel + UW + System Alerts (shipped May 2026)

This section captures the durable design, operational state, and user preferences from the May 2026 build arc. Survives context compression — read this before making changes to sentinel, UW, or alerting code.

### What was built (commits on `main`)
- `3e63487` — Pre-close sentinel core
- `05744e9` — 12 CodeRabbit fixes (GET/POST split, ORDER_TYPE.TWAP_LIMIT, etc.)
- `cb8626d` — Unusual Whales full integration (client, cron, sentinel hooks)
- `730df04` — Data integrity (NULL-safe UNIQUE indexes, PUBLIC_URL validation)
- `b20635d` — Observability (schema linter, retention, data-quality, routes)
- `e4e9691` — UI tabs (Flow History, Sentinel Activity)
- `a8597d5` — System-alerts module + DB table + routes + boot/uncaught wiring
- `0fca15a` — Wired system-alerts into all 14 cron handlers + WS flap counter + UI tab

### Pre-Close Sentinel (`src/core/sentinel.js`)

**Schedule:** Mon–Fri 3:00 PM ET (`'0 15 * * 1-5'`) + Sun 6:00 PM ET (`'0 18 * * 0'`), America/New_York timezone.

**Architecture rule (non-negotiable):** Deterministic Node code builds risk facts AND trade proposals (qty, side, limit_price, stop_price). Claude Sonnet 4.6 writes ONLY the prose email body from those facts. LLM output is NEVER parsed for trade parameters. Every number in a proposal is decided in Node code.

**Risk types detected per holding:**
- `earnings` — next earnings within 5 trading days (Yahoo `calendarEvents`)
- `news` — Benzinga headlines in last 24h
- `calibration` — `prediction_calibration` shows dir_accuracy < 0.35 AND 30d move > +20%
- `concentration` — any sector > 40% of portfolio
- `macro` — economic events in next 2 trading days (from UW `getEconomicCalendar()`)
- `unusual_options` — UW options flow > $500k contradicting position direction
- `insider_selling` — insider sold > $1M in last 7 days
- `congressional_activity` — Congress member transacted in last 14 days
- `drawdown` — unrealized P/L < −5%

**Proposal rules (deterministic):**
- Earnings ≤ 2 days + position > 5% → trim to 5%
- Calibration warning (dir_acc < 0.30 + 30d > +25%) + position > 3% → trim to 3%
- High news severity + unrealized > +15% → tighten stop to (entry + 50% of gain)
- Sector concentration > 50% → trim largest by 25%

**One-click confirm flow:**
- Email contains `[Execute]` and `[Ignore]` links — HMAC-SHA256 signed tokens, 30-min expiry
- `GET /api/action/execute/:id?token=...` — shows confirm page (safe for email/link previews)
- `POST /api/action/execute/:id` — actually executes; re-fetches live price; refuses if drift > `SENTINEL_DRIFT_TOLERANCE` (default 0.02)
- Idempotent — second click renders "already actioned" page
- Token verified via `crypto.timingSafeEqual` (never `===` or `Buffer.compare`)

**Env vars required (sentinel will throw at boot if missing in production):**
- `ACTION_SIGNING_SECRET` — must be ≥32 chars. Generate: `openssl rand -hex 32`. NO fallback — throws if missing.
- `PUBLIC_URL` — must be valid https:// (or http://localhost). Throws if placeholder.
- `SENTINEL_EMAIL_FROM`, `SENTINEL_EMAIL_TO` — Resend transport
- `SENTINEL_DRIFT_TOLERANCE` — default `0.02` (2%). Higher = more permissive
- Email transport is **Resend** (not nodemailer/SMTP). Uses `RESEND_API` env var.

**Persistence:**
- `sentinel_runs` — every run logged (mode, as_of, risks_json, proposals_json, email_sent, error)
- `pending_actions` — UUID PK, partial UNIQUE index `(symbol, side, qty) WHERE status='pending'` prevents duplicate proposals
- Routes: `GET /api/sentinel/recent`, `GET /api/sentinel/runs/:id`, `POST /api/sentinel/run` (admin trigger)

### Unusual Whales Integration

**License: PERSONAL USE ONLY.** Never expose UW data via any public API or to other users. UW actively polices this. Multi-tenant or external API endpoints serving UW data violate ToS.

**Plan:** API Advanced — 120 req/min, 80,000 req/day, WebSocket streaming, 90-day historical lookback.

**Single client:** `src/core/unusual-whales.js`. ALL UW calls go through it. Real token-bucket rate limiter (dual minute + day enforcement). Per-endpoint in-memory cache with explicit TTL. **DO NOT modify rate-limit or cache internals** — sealed. Add new fetch methods if needed, following the existing pattern.

**Cron schedule (`src/web/server.js`):**

| Cron | Schedule | Action |
|---|---|---|
| `uw-cron/movers` | `*/5 * * * 1-5` | Persist top movers (3 directions parallel) to `uw_top_movers` with 5-min-rounded `captured_at` |
| `uw-cron/insider` | `*/15 * * * 1-5` | Persist Form 4 insider trades to `uw_insider_trades` |
| `uw-cron/congress` | `0 * * * 1-5` | Persist congressional trades to `uw_congressional_trades` |
| `uw-cron/flow-alerts` | `*/2 9-16 * * 1-5` | Persist real-time options flow to `uw_flow_alerts` (~20K rows/day) |
| `uw-cron/econ-cal` | `0 6 * * 1-5` | UPSERT economic calendar to `uw_economic_calendar` |
| `uw-cron/ipo-cal` | `5 6 * * 1-5` | UPSERT IPO calendar to `uw_ipo_calendar` |
| `uw-cron/fundamentals-warmup` | `0 18 * * 1-5` | Cache fundamentals for held positions |
| `uw-schema-linter` | `0 7 * * *` | Audit raw JSONB vs `EXPECTED_KEYS`; alert on drift |
| `uw-retention` | `0 3 * * *` | Purge old rows past retention window |
| `uw-quality` | `0 8 * * *` | NULL-rate + freshness audit; alert on anomalies |

**Retention defaults (env-overridable):**
- `UW_FLOW_RETENTION_DAYS=90`
- `UW_MOVERS_RETENTION_DAYS=30`
- `UW_OPTIONS_FLOW_RETENTION_DAYS=90`
- Other UW tables kept indefinitely (low volume, high historical value)

**Field mapping gotchas:**
- UW returns numeric values sometimes as strings with `%` suffix — use `parseUWNum()` helper to strip
- Flow alerts have nullable `strike`/`side` — UNIQUE indexes use COALESCE expression indexes (Postgres NULL ≠ NULL)
- Insert sentinel values (`''`, `-1`, `'1900-01-01'`) instead of NULL to match the expression indexes
- If `EXPECTED_KEYS` drift detected by `uw-schema-linter`, update both the cron INSERT and the EXPECTED_KEYS map

### System Alerts Layer (`src/core/system-alerts.js`)

**Purpose: no silent failures.** Every cron catch, sentinel error, execute-route failure, schema drift, low quota, WS flap, uncaught exception, and boot event flows through one alerting pipeline.

**API:**
```js
await alert({
  key: 'uw-cron/<task>',         // stable string for dedup
  severity: 'info'|'warn'|'critical',
  title: '...',
  detail: { ... },                // redacted before storage (secret|token|password|api_key|cookie stripped)
  dedup_window_minutes: 60,        // default
});
```

**Severity rules:**
- `info` — log + DB row; emails dedup'd at 5-min window (`system/boot` etc.)
- `warn` — log + DB row + email dedup'd at `ALERT_DEDUP_WINDOW_MIN` (default 60)
- `critical` — log + DB row + email **bypasses dedup** (every critical fires)

**Email format:** Subject prefixed `[OK]` / `[WARN]` / `[CRITICAL]` for inbox filtering.

**Inbox filter rules (Gmail/Apple Mail):**

| Subject | Action |
|---|---|
| `[CRITICAL]` | Star + VIP folder + push notification + sound |
| `[WARN]` | Label + skip inbox |
| `[OK]` | Label + skip inbox + mark read |

**Routes:**
- `GET /api/system-alerts/recent?limit=N` — auth-gated history
- `GET /api/system-alerts/:id` — full detail
- `POST /api/system-alerts/test` — admin-only manual trigger (for testing pipeline)

**Persistence:** `system_alerts` table — every alert stored even when email is suppressed by dedup. Has `email_sent`, `email_suppressed`, `email_error` columns for forensics.

**Env vars:**
- `ALERT_EMAIL` — recipient (defaults to `SENTINEL_EMAIL_TO` if unset)
- `ALERT_DEDUP_WINDOW_MIN` — default 60

**Critical-bypass-dedup means:** if you trigger 3 critical alerts in 30s with the same key, you get 3 emails. Use `severity: 'warn'` if you only want one alert per hour for repeating issues.

### User preferences (durable — DO NOT violate)

1. **No silent failures.** Every cron catch, every error path, every threshold breach calls `alert()`. If you add new background work, wire it through `system-alerts`.

2. **LLM never writes trade params.** Claude only writes prose explanations. All numbers (qty, side, price, stop) are decided in Node code. Never parse LLM output for trade values.

3. **CodeRabbit reviews before push.** Stage diff, get CodeRabbit pass, then commit. The 12 fixes from `05744e9` are the historical precedent — pre-empt them by reading what CodeRabbit usually catches: GET/POST split, idempotency, resource cleanup, secret fallbacks, ORDER_TYPE strings, NULL handling.

4. **Personal use only on UW data.** Never expose UW data via public routes or multi-tenant APIs. Internal owner-only routes are fine.

5. **Additive enrichment, not replacement.** When integrating UW into existing widgets (e.g. Tomorrow's Catalysts), keep the existing source as primary and add UW as a parallel `Promise.allSettled` enrichment. Don't replace Nasdaq earnings cal, Yahoo `quoteSummary`, or Benzinga news — augment them.

6. **`--update-env` after `.env` changes.** `pm2 restart trading-dashboard --update-env`. Plain restart doesn't re-read env vars.

7. **Don't refactor what's working.** The `src/core/unusual-whales.js` client rate-limit and cache internals are sealed. Add new methods, don't change the bucket logic.

### Deferred items (do NOT rebuild unless explicitly asked)

- **PM2 ingestor service refactor** — splitting UW work into a 3rd PM2 process. Discussed; deferred. Revisit only if cron-in-web-server causes actual pain (UW outage slowing dashboard, day quota exhausted).
- **Pine_analyze 403 tests** — pre-existing failures, currently `it.skip`'d. Cosmetic.
- **Sentinel "cancel all" UX** — clicking Ignore on one proposal in an email doesn't cancel siblings. UX nicety only.
- **UW quota proactive monitor cron** — `/api/uw/quota` route exists. A daily cron that emails when day quota < 5,000 was specced but not yet built. Add only if quota becomes a real concern (currently at 0.7% daily utilization).
- **Resend production domain setup** — operational, not code. Verify when scaling beyond personal use.

### DB tables added in this build arc

Append to the "Key DB tables" list above:
- `sentinel_runs` (mode, as_of, risks_json, proposals_json, email_sent, error)
- `pending_actions` (UUID, symbol, side, qty, signed_token, expires_at, status; partial UNIQUE on pending status)
- `system_alerts` (key, severity, title, detail JSONB, email_sent, email_suppressed, email_error)
- `uw_options_flow` · `uw_top_movers` · `uw_flow_alerts` · `uw_insider_trades` · `uw_congressional_trades` · `uw_economic_calendar` · `uw_ipo_calendar`

### Dashboard widget tabs added

Append to the "Dashboard widget tabs" table:
- `uw_flow_history` 🐋 Flow History — `uw_flow_alerts` last 24h, auto-refresh 60s
- `sentinel_runs` 📨 Sentinel Activity — `/api/sentinel/recent`, row click → detail modal
- `sys_alerts` 🚨 System Alerts — severity-colored, 24h counts, row click → detail modal

### Verification queries (run after any sentinel/UW change)

```sql
-- 24h health summary (system-alerts)
SELECT severity, COUNT(*) AS count_24h, MAX(created_at) AS most_recent
FROM system_alerts WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY severity ORDER BY severity;

-- UW ingestion rates last 24h
SELECT 'flow_alerts' AS t, COUNT(*) FROM uw_flow_alerts WHERE alerted_at > NOW() - INTERVAL '24 hours'
UNION ALL SELECT 'movers', COUNT(*) FROM uw_top_movers WHERE captured_at > NOW() - INTERVAL '24 hours'
UNION ALL SELECT 'insider', COUNT(*) FROM uw_insider_trades WHERE ingested_at > NOW() - INTERVAL '24 hours'
UNION ALL SELECT 'congress', COUNT(*) FROM uw_congressional_trades WHERE ingested_at > NOW() - INTERVAL '24 hours';

-- Sentinel run history
SELECT mode, COUNT(*), COUNT(*) FILTER (WHERE email_sent) AS sent,
       COUNT(*) FILTER (WHERE error IS NOT NULL) AS failed
FROM sentinel_runs WHERE as_of > NOW() - INTERVAL '7 days' GROUP BY mode;
```

### Test invocation

`npm test` runs: e2e + pine_analyze + sentinel + unusual-whales + uw-schema-linter + uw-retention + uw-null-unique + system-alerts. Uses `--experimental-test-module-mocks` flag (Node 22+ required). `NODE_ENV=test` allows `ACTION_SIGNING_SECRET` + `PUBLIC_URL` to use test defaults.
