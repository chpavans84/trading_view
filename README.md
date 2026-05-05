# AI Trading Bot Dashboard

A personal AI-powered trading dashboard that combines a web UI, Claude AI analyst, local knowledge base, 5-algorithm stock predictor, Moomoo portfolio integration, Alpaca paper trading, and a 3-year backtested ML conviction engine.

---

## What It Does

- **AI Trading Analyst** — Ask anything in plain English via the web chat. Claude answers with live market data, your portfolio, news, and technical indicators.
- **5-Algorithm Stock Predictor** — Linear regression projection, ATR expected move ranges, momentum score, personal trade pattern analysis, and an earnings catalyst model — all run in parallel, no LLM cost.
- **Local Knowledge Base** — Instant answers to trading education questions (RSI, options strategies, candlestick patterns, etc.) without hitting the Claude API.
- **3-Layer ML Conviction Scoring** — Every trade candidate is scored 0–100 using RSI, MACD, EMA, Bollinger Bands, relative volume, pre-earnings drift, and a 3-year backtested logistic regression model.
- **Voice Chat** — Hands-free interactive voice session with 10-second auto-quit on silence. Say "exit" to end the session.
- **Moomoo Portfolio** — Reads live positions, P&L, and buying power from your real Moomoo account via Futu OpenD.
- **Alpaca Paper Trading** — ATR-sized bracket orders (stop + target placed simultaneously) via Alpaca paper account.
- **Earnings Date Accuracy** — Next earnings dates for all your held positions are fetched live from Yahoo Finance and injected into every Claude prompt — Claude never guesses.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              OFFLINE ML RESEARCH PIPELINE                               │
│                    (weekend cron Sat 10 PM ET + nightly 2 AM ET)                       │
│                                                                                         │
│  Yahoo Finance API                                                                      │
│       │                                                                                 │
│       ▼                                                                                 │
│  download-prices.js  ──► backtest_prices   (3yr OHLCV, S&P500/NASDAQ100/VIX/SPY)      │
│       │                                                                                 │
│       ▼                                                                                 │
│  compute-scores.js   ──► backtest_scores   (RSI, EMA, MACD, BB, RVOL per date)        │
│       │                                                                                 │
│       ▼                                                                                 │
│  backtest.js         ──► backtest_returns  (fwd returns 1d/1w/1m/3m, dip flags)       │
│       │                                                                                 │
│       ▼                                                                                 │
│  train-model.js      ──► model_results     (logistic regression weights, AUC/F1)      │
└─────────────────────────────────┬───────────────────────────────────────────────────────┘
                                  │  getFactorWeights() — 24h cache
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              LIVE SCORING & TRADING                                     │
│                                                                                         │
│  scoring.js  ◄── ML grade adjustments (A/B/C/F weights from model_results)            │
│      │            + Yahoo Finance (RSI, EMA, MACD, BB, RVOL, earnings, insider)       │
│      │            + news.js (sentiment, earnings surprise)                             │
│      │            + sentiment.js (relative strength vs SPY, VIX regime)               │
│      │            + tradingview-bridge.js (Pine levels from chart)                    │
│      │                                                                                  │
│      ▼  conviction score 0–100                                                         │
│  AI Scanner Bot (cron) ──► stock-selector.js ──► trader.js ──► Alpaca Paper API      │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 WEB DASHBOARD (port 3000)                               │
│                                                                                         │
│  Browser ─────────────────────────────────────────────────────────────────────────     │
│  ├── AI Chat (SSE streaming)                                                            │
│  │     │                                                                                │
│  │     ▼  Question routing (knowledge.js)                                              │
│  │     ├─ FAST PATH: keyword match → local knowledge_chunks (instant, $0)             │
│  │     ├─ VECTOR PATH: nomic-embed-text similarity search → knowledge_chunks ($0)     │
│  │     ├─ TRADE HISTORY: isTradeHistoryQuestion() → DB query + Ollama analysis ($0)  │
│  │     ├─ FUNDAMENTALS: isFundamentalScreeningQuestion() → PostgreSQL query ($0)      │
│  │     └─ CLAUDE SONNET: all prediction/analysis questions → Claude API ($0.001/msg) │
│  │           └─ Tools: get_stock_prediction, get_earnings, get_news, get_portfolio,   │
│  │                      scan_for_trades, moomoo_portfolio, moomoo_place_trade, ...     │
│  │                                                                                      │
│  │     System prompt includes:                                                          │
│  │       • Held positions' next earnings dates (fetched live, Yahoo Finance)           │
│  │       • Recent trading lessons from closed trades                                   │
│  │       • Win-rate patterns by market regime                                          │
│  │                                                                                      │
│  ├── Voice Chat                                                                         │
│  │     Web Speech API: mic → transcript → AI → TTS → mic (loop)                       │
│  │     10-second silence → auto-quit. Say "exit/quit/stop" → end session.             │
│  │                                                                                      │
│  ├── Portfolio (Moomoo positions, Alpaca paper account)                                │
│  ├── Trade History (closed trades, P&L chart)                                          │
│  ├── Conviction Scanner (live scoring with ML model)                                   │
│  ├── Knowledge Base (search/manage trading education entries)                          │
│  ├── ERD (entity-relationship diagram with zoom/pan)                                   │
│  └── Settings / Permissions                                                             │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              5-ALGORITHM PREDICTOR (predictor.js)                       │
│                              Runs in parallel, zero LLM cost                           │
│                                                                                         │
│  1. Linear Regression Trend  — slope, R², day-5 and day-10 price projections           │
│  2. ATR Expected Move        — Wilder ATR-14 → probability ranges for 1/5/10 days      │
│  3. Momentum Score (0–100)   — RSI + EMA9/20/50 alignment + MACD + volume trend       │
│  4. Personal Trade Edge      — your own win rate, profit factor, best hour/day         │
│  5. Earnings Catalyst        — revenue growth trend, EPS momentum, next earnings date  │
│                                                                                         │
│  Combined → overall_signal 0–100, overall_label (Strong Buy / Buy / Neutral / Avoid)  │
│  Cached 15 min per symbol. Exposed to Claude as: get_stock_prediction tool.            │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                     PostgreSQL                                          │
│  trades              ← every buy/sell from all UI paths (force/quick/close/bot)        │
│  conviction_scores   ← live scoring history                                            │
│  trade_rejections    ← guard-block audit log                                           │
│  knowledge_chunks    ← trading education KB (keyword + vector search)                  │
│  fundamentals        ← quarterly revenue, EPS, net income per symbol                  │
│  backtest_prices     ← 3yr OHLCV for S&P500 + NASDAQ100                               │
│  backtest_scores     ← historical indicator snapshots                                  │
│  backtest_returns    ← forward return labels for ML training                          │
│  model_results       ← trained model weights + AUC/accuracy/F1                        │
│  user_activity       ← all UI actions                                                  │
│  conversation_history← chat context per user                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘

Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

---

## AI Chat — Question Routing

Every message is routed through four layers before hitting the Claude API:

| Layer | Trigger | Cost | Latency |
|-------|---------|------|---------|
| Keyword fast path | Trading education terms (RSI, options, etc.) with score ≥ 2 | $0 | <10ms |
| Vector similarity | Embedding match > 0.55 in knowledge_chunks | $0 (Ollama embed) | ~200ms |
| Trade history | "my NVDA trades", "how did I do", "my win rate" | $0 (Ollama analysis) | 2–10s |
| Fundamental screener | "stocks with growing revenue", "EPS growth" | $0 (PostgreSQL) | <100ms |
| Claude Sonnet | Everything else — predictions, analysis, trading decisions | ~$0.001/msg | 2–5s |

Prediction questions ("where is NVDA headed?", "forecast", "price target") always go to Claude Sonnet, which calls `get_stock_prediction` for live algorithm output.

---

## Local AI (Ollama — Optional)

Ollama is used for:
1. **Knowledge Base embeddings** — `nomic-embed-text` for semantic search in `knowledge_chunks`
2. **Trade history analysis** — smaller model (llama3.2:3b default) for answering questions about your closed trades

Ollama is **not** used for general Q&A anymore. All knowledge questions go to the local DB first, then Claude Sonnet as fallback.

```bash
# Install
brew install ollama
ollama serve
ollama pull nomic-embed-text      # for KB embeddings (274MB)
ollama pull llama3.2:3b           # for trade history analysis (2GB)
```

Add to `.env`:
```
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
```

> **Intel Mac note:** CPU-only inference is ~0.6 tok/s on llama3.1:8b and ~8-10 tok/s on llama3.2:3b. The knowledge routing avoids Ollama for most answers.

---

## Custom Ollama Model from Trade Data

To bake your real trade history into a fine-tuned Ollama model:

```bash
npm run ollama:build     # generates trading-coach.Modelfile from your DB
ollama create trading-coach -f trading-coach.Modelfile
```

Set `OLLAMA_MODEL=trading-coach` in `.env` to use it for trade history questions.

---

## Stock Predictor — 5 Algorithms

Triggered by Claude via the `get_stock_prediction` tool. Runs all 5 in parallel (Promise.all), cached 15 min per symbol.

### Algorithm 1 — Linear Regression Trend
- Last 50 daily bars from Yahoo Finance
- Computes slope, intercept, R² (coefficient of determination)
- Projects regression line forward → `projected_day5`, `projected_day10`
- Confidence band = ±1.5 × standard error of residuals
- R² > 0.7 = high reliability, < 0.4 = choppy/unreliable

### Algorithm 2 — ATR Expected Move
- 14-period Wilder ATR from daily OHLCV
- 1-day range: ±1.0 × ATR14
- 5-day range: ±2.2 × ATR14 (√5 scaling)
- 10-day range: ±3.2 × ATR14 (√10 scaling)
- ATR > 3% of price = high volatility warning

### Algorithm 3 — Momentum Score (0–100)
- RSI(14): bullish 50-70 (+2), overbought >70 (-1), bearish 30-50 (-2), oversold <30 (+1)
- EMA9/20/50 alignment: fully bullish (+3) to fully bearish (-3)
- MACD(12,26,9): bullish cross with growing histogram (+2) or bearish (-2)
- Volume trend: 5-day vs 20-day avg (+1 accumulation, -1 distribution)
- Price vs 20-day SMA proxy (+1 above, -1 below)
- Normalized 0–100. Labels: Strong Bullish ≥70, Bullish ≥55, Neutral ≥45, Bearish ≥30, Strong Bearish <30

### Algorithm 4 — Personal Trade Pattern Analysis
- Queries your `trades` table for closed trades on this symbol
- Win rate, avg win/loss, profit factor
- Best time of day and day of week (by historical win rate)
- Last 3 trades with P&L
- Edge label: Strong Edge (win rate > 60% AND profit factor > 1.5), Slight Edge, or No Edge
- Requires ≥ 3 closed trades on this symbol

### Algorithm 5 — Earnings Catalyst Model
- Revenue growth trend from `fundamentals` table (accelerating / decelerating / flat)
- EPS growth streak (QoQ) → earnings momentum score 0–100
- Net income positive and growing bonus
- Next earnings date via yahoo-finance2 (handles crumb auth)
- Pre-earnings setup flags: "Pre-earnings long candidate" (≤14 days + momentum ≥60), "Earnings imminent" (≤3 days)

### Combined Signal
```
overall_signal = 50
  + (momentum_score − 50) × 0.30   // momentum weight 30%
  + (trend up ? +15 : −15)          // trend direction 15%
  + (R² × 10)                       // trend reliability
  + (earnings_momentum − 50) × 0.20 // earnings weight 20%
  + (personal win_rate > 0.5 ? +10 : −5)
  clamped 0–100
```

---

## Earnings Date Accuracy

A common LLM failure is answering "when are NVDA earnings?" from training data (stale). This is fixed by:

1. At the start of **every** chat request, `buildPositionEarningsBlock()` fetches next earnings dates for all Moomoo-held symbols via Yahoo Finance (`calendarEvents` module)
2. These dates are injected directly into the Claude system prompt:

```
━━━ HELD POSITIONS — NEXT EARNINGS (fetched live right now) ━━━
• NVDA: 2026-05-20 (confirmed)
IMPORTANT: These dates are authoritative. Do NOT contradict them with training-data guesses.
```

Cached 30 min per symbol.

---

## Conviction Scoring Engine (`src/core/scoring.js`)

Every trade candidate is scored 0–100 before execution:

| Factor | Weight |
|--------|--------|
| RSI, MACD, EMA, Bollinger Bands (local compute) | Base score |
| 3yr backtest ML adjustment (grade A/B/C/F) | ±3–9 pts |
| Performance pattern boost (regime win rate) | ±8–10 pts |
| Pre-earnings drift (5-day momentum) | +15 |
| Relative strength vs sector ETF | +15 |
| 2+ insider Form 4 filings (60d window) | +10 |
| "Raises guidance" in news | +15 |
| VIX > 25 (defensive) | half size |
| VIX > 35 (crisis) | no new longs |
| "Lowers guidance" in news | −15 |

**Score < min_conviction** → skip (default 50, configurable per user)
**Score ≥ min_conviction** → propose trade with ATR-sized stop and target

---

## Project Structure

```
src/
├── core/
│   ├── ai-chat.js           # Claude chat engine, tools, routing, system prompt builder
│   ├── knowledge.js         # 3-layer KB routing: keyword → vector → error
│   ├── predictor.js         # 5 prediction algorithms (linear regression, ATR, momentum,
│   │                        #   personal edge, earnings catalyst) — pure JS, no LLM
│   ├── market-context.js    # Market regime, VIX, sector performance (deterministic)
│   ├── scoring.js           # ML conviction scoring engine (0–100)
│   ├── trader.js            # Alpaca trade execution, ATR sizing, bracket orders
│   ├── news.js              # SEC EDGAR, Yahoo Finance, Alpaca news, earnings calendar
│   ├── sentiment.js         # VIX, sector ETFs, trending stocks, market movers
│   ├── db.js                # PostgreSQL client, all table schemas, query helpers
│   ├── moomoo-tcp.js        # Moomoo OpenD TCP client (positions, orders, trades)
│   ├── fundamental-screener.js # PostgreSQL screener ("stocks with growing EPS")
│   ├── stock-selector.js    # Cron-driven scanner (movers → score → propose)
│   └── ...                  # drawing, chart, pine, replay, alerts, indicators
├── research/
│   ├── download-prices.js   # Fetch 3yr OHLCV from Yahoo Finance → PostgreSQL
│   ├── compute-scores.js    # Compute RSI/EMA/MACD/BB/RVOL per bar → PostgreSQL
│   ├── backtest.js          # Forward return labelling (1d/1w/1m/3m)
│   ├── train-model.js       # Logistic regression training → model_results table
│   ├── download-fundamentals.js # SEC EDGAR fundamentals → PostgreSQL
│   └── create-modelfile.js  # Generate Ollama Modelfile from real trade data
├── web/
│   ├── server.js            # Express server (port 3000), all /api/* routes
│   └── public/
│       └── index.html       # Single-page dashboard (all JS/CSS inline)
├── bot/
│   ├── telegram-ai.js       # Telegram AI analyst (uses same ai-chat.js engine)
│   └── telegram.js          # Basic Telegram data bot
└── tools/                   # MCP tool registrations (for Claude Code TradingView control)
```

---

## npm Scripts

```bash
npm run dashboard         # Start web dashboard on port 3000
npm run bot:ai            # Start Telegram AI bot
npm start                 # Start MCP server (for Claude Code TradingView tools)

# ML research pipeline (run in order)
npm run research:download   # Download 3yr price history
npm run research:scores     # Compute technical indicators
npm run research:backtest   # Label forward returns
npm run research:train      # Train logistic regression model

# Utilities
npm run ollama:build        # Generate trading-coach Modelfile from your trade DB
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

```env
# Required
DATABASE_URL=postgresql://localhost:5432/tradingbot
ANTHROPIC_API_KEY=sk-ant-...

# Alpaca paper trading
ALPACA_API_KEY=PK...
ALPACA_SECRET_KEY=...
ALPACA_BASE_URL=https://paper-api.alpaca.markets

# Optional — Moomoo OpenD (for real portfolio reading)
MOOMOO_HOST=127.0.0.1
MOOMOO_PORT=11111

# Optional — Telegram bot
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Optional — Ollama local AI
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
```

### 3. Start the dashboard

```bash
npm run dashboard
# Open http://localhost:3000
```

### 4. (Optional) Run the ML pipeline

```bash
npm run research:download
npm run research:scores
npm run research:backtest
npm run research:train
```

### 5. (Optional) Start TradingView with CDP for chart tools

```bash
# Mac
/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222
```

---

## Claude Tools Available in Chat

| Tool | What it does |
|------|-------------|
| `get_stock_prediction` | All 5 prediction algorithms for a symbol |
| `scan_for_trades` | Score top market movers with conviction engine |
| `get_conviction_score` | Score a specific symbol 0–100 |
| `get_portfolio` | Alpaca paper account: balance, positions, orders |
| `moomoo_portfolio` | Moomoo real account: positions, P&L, buying power |
| `moomoo_place_trade` | Place order on Moomoo (paper or live) |
| `propose_trade` | Execute Alpaca paper trade with ATR bracket |
| `get_live_quote` | Real-time price via Moomoo or Yahoo Finance |
| `get_earnings` | Last 4 quarters EPS + next earnings date |
| `get_news` | Stock-specific or macro keyword news |
| `get_market_sentiment` | VIX, S&P, Nasdaq, fear/greed |
| `get_market_regime` | VIX-based regime (normal / defensive / crisis) |
| `get_trade_history` | Your closed/open trades from PostgreSQL |
| `get_my_config` | Read bot risk config |
| `update_my_config` | Change risk profile, limits, thresholds |
| `get_chart_technicals` | RSI, MACD, EMAs from TradingView chart |
| `get_price_levels` | Support/resistance levels from Pine indicators |

---

## Voice Chat

Click the microphone icon in the AI Chat panel to start an interactive voice session:

- **Listening** — pulsing mic, 10-second silence countdown
- **Thinking** — countdown paused while AI processes
- **Speaking** — AI responds via text-to-speech, mic restarts after
- **Auto-quit** — 10 seconds of silence ends the session automatically
- **Manual exit** — say "exit", "quit", "stop", "bye", or click Stop

Toggle TTS on/off independently of voice session. Voice mode compresses AI responses to ≤3 sentences, no markdown.

---

## Data Sources (All Free, No Paid Feed)

| Source | Used for |
|--------|---------|
| Yahoo Finance | OHLCV, VIX, sector ETFs, earnings dates, trending stocks, predictor |
| SEC EDGAR XBRL | EPS actuals, revenue, net income (authoritative) |
| Alpaca / Benzinga | Real-time news (~1–2 min latency), paper trading |
| Moomoo OpenD | Live portfolio, positions, P&L, real trade execution |
| PostgreSQL | Trade history, fundamentals, ML model, knowledge base |

---

## Important Notes

- **Paper trading by default** — `ALPACA_BASE_URL=https://paper-api.alpaca.markets`
- **Moomoo trade mode** — set `MOOMOO_TRADE_ENV=1` in `.env` to switch from simulate to live
- **PDT Rule** — US accounts under $25K: 3 day trades per 5 business days
- **Moomoo OpenD** must be running on port 11111 for portfolio reading
- **TradingView Desktop** must run with `--remote-debugging-port=9222` for chart tools
- This is an experimental personal project — not financial advice

---

## Roadmap

- [x] Web dashboard with AI chat and SSE streaming
- [x] 3-layer knowledge routing (keyword → vector → Claude)
- [x] 5-algorithm stock predictor (no LLM cost)
- [x] Voice chat with auto-quit
- [x] Moomoo trade execution (paper/live)
- [x] ML conviction engine with 3-year backtest
- [x] Live earnings date injection into Claude system prompt
- [ ] Moomoo real-time news via OpenD quote API
- [ ] Post-earnings 8-K auto-detection (buy signal within minutes of SEC filing)
- [ ] Mobile-responsive dashboard
- [ ] Cloud deployment (remove dependency on Mac staying on)
