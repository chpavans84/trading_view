# Akshaya Trading Platform — The Complete Reference

> **Last updated:** 2026-05-21  
> **How to keep this current:** When you add a table, route, feature, or module, find the right chapter and update it. This document is the single source of truth — written to be read, not just searched.

---

## Table of Contents

- [Preface — What This Book Is](#preface)
- **Part I — The Big Picture**
  - [Chapter 1 — What This Platform Does and Why](#chapter-1)
  - [Chapter 2 — How the System Is Organized](#chapter-2)
  - [Chapter 3 — Running the System in Production](#chapter-3)
- **Part II — The Intelligence Engine**
  - [Chapter 4 — How Stocks Are Scored](#chapter-4)
  - [Chapter 5 — Forecasting Price Moves](#chapter-5)
  - [Chapter 6 — The ML Research Pipeline](#chapter-6)
- **Part III — The Bot System**
  - [Chapter 7 — Automated Trading End to End](#chapter-7)
  - [Chapter 8 — Building the Candidate Universe](#chapter-8)
  - [Chapter 9 — Risk Management and the Guardian](#chapter-9)
- **Part IV — Where Data Comes From**
  - [Chapter 10 — Broker Connections](#chapter-10)
  - [Chapter 11 — Market Intelligence Sources](#chapter-11)
- **Part V — The Interface**
  - [Chapter 12 — The Desktop Dashboard](#chapter-12)
  - [Chapter 13 — The Mobile Experience](#chapter-13)
- **Part VI — Deep Reference**
  - [Chapter 14 — The Complete Database Schema](#chapter-14)
  - [Chapter 15 — The Complete API Reference](#chapter-15)
  - [Chapter 16 — Configuration and Environment Variables](#chapter-16)
  - [Chapter 17 — Scheduled Jobs and Cron Timetable](#chapter-17)
- [Appendix — Changelog](#changelog)

---

<a name="preface"></a>
## Preface — What This Book Is

This document is a reference book for the Akshaya Trading Platform. It is written to be *read* — to help you understand how the system thinks, why it was designed the way it was, and what each piece does before you have to look up a specific field name or route path.

The technical tables and route lists are here — but they are the *last* thing in each section, not the first. Before every reference table you will find an explanation of what it represents, why it exists, and how it connects to the rest of the system.

When you add a new feature, find the right chapter and write a paragraph explaining it, then add the technical details below. A future reader — or your future self — will thank you.

---

<a name="chapter-1"></a>
# Part I — The Big Picture

## Chapter 1 — What This Platform Does and Why

Most retail traders operate with a fundamental disadvantage: the tools available to them show them the same information that everyone else can see. Price charts, basic technicals, maybe some news. The professionals, meanwhile, are watching options flow that signals where institutional money is moving before a stock makes its big move. They are reading insider transaction filings. They are tracking what senators bought last week. They have quantitative models trained on years of data.

This platform was built to close that gap.

At its core, Akshaya is an AI-powered trading intelligence system. It connects to your real brokerage accounts — Alpaca (paper and live), Tiger Brokers, and Moomoo — and gives you a unified view of your positions and P&L. But beyond portfolio management, it does something more ambitious: it continuously analyzes the market to find high-conviction trade opportunities, and it can act on those opportunities automatically through a configurable bot system.

The platform does several things in parallel, all day, every market day:

**It watches options flow.** Through Unusual Whales, it ingests unusual options activity every two minutes — big block trades, sweeps, and alerts that suggest an institution is betting heavily on a specific stock. When a $2M call sweep comes in on a $30 stock, the system notices.

**It scores stocks.** The conviction scoring engine evaluates hundreds of symbols continuously against seven signals: technical indicators, relative strength vs. the market, momentum, earnings proximity, options flow sentiment, insider activity, and the output of a trained machine learning model. Every scored symbol gets a grade from A to F and a 0–100 score.

**It forecasts prices.** A five-algorithm prediction engine generates weekly price forecasts for every symbol in the portfolio, combining linear regression trend analysis, ATR-based expected moves, momentum scoring, your personal trade history edge, and earnings catalysts. The predictions are then calibrated against historical errors to remove systematic bias.

**It runs bots.** Configurable automated bots scan the scoring engine every five minutes, select the best candidate based on your rules, size the position, place the order through your broker, and then manage the trade with trailing stops and stop-losses until it closes.

**It watches your back.** The Pre-Close Sentinel runs every weekday at 3 PM, scans all your open positions for eight risk signals (upcoming earnings, degraded prediction accuracy, sector concentration, unusual options activity, insider selling, congressional trades, macro events), and emails you a risk briefing with one-click trade management links.

**It learns.** Every closed trade generates a lesson — an AI-written reflection on what worked and what did not, tagged by market regime and VIX level. Over time the system builds a personalized record of when you trade well and when you do not, and uses that history to adjust future confidence.

The stack is intentionally lean: Node.js, Express, PostgreSQL, and vanilla JavaScript on the frontend. No React, no complex build pipeline — a senior developer can read any file in the codebase and understand it in minutes.

---

<a name="chapter-2"></a>
## Chapter 2 — How the System Is Organized

Understanding the platform means understanding how data flows through it. There is a clear direction: raw market data comes in, gets analyzed, turns into signals, signals get combined into scores, scores drive decisions, decisions become trades, trades generate history, history feeds learning.

### The Three Layers

**The data layer** sits at the bottom. PostgreSQL holds everything — over 50 tables covering trades, scores, predictions, options flow, insider filings, news, bot decisions, and more. Above PostgreSQL, `src/core/db.js` is the single point of database access — a connection pool shared across all modules, plus the `initDb()` function that creates every table on startup.

**The intelligence layer** sits in the middle. The core modules in `src/core/` do the actual thinking: `scoring.js` computes conviction scores, `predictor.js` runs the five-algorithm price forecaster, `bot-engine.js` runs the scanner, `sentinel.js` analyzes risk, `unusual-whales.js` manages the real-time data feed, and `news.js` processes Benzinga articles into sentiment signals.

**The interface layer** sits on top. The Express server in `src/web/server.js` exposes about 120 API routes that the browser frontend (`src/web/public/index.html`) uses to drive the dashboard. The server also runs all the cron jobs — more than 30 scheduled tasks that keep the data fresh, fill prediction actuals, sync the tradable universe, and run the bots.

### How a Bot Trade Happens

To make the architecture concrete, here is what happens when a bot places a trade:

1. Every five minutes during market hours, `bot-engine.js` (Phase B-2, the scanner) wakes up for each active bot.
2. It builds a candidate universe by pulling from four sources: recent Unusual Whales flow alerts (highest priority, +10–15 priority points), recent Benzinga news (second priority, +8–12 points), top movers from the last 30 minutes (+5 points), and a base universe from the `tradable_universe` table — all NYSE/NASDAQ stocks with market cap above $5B, average daily dollar volume above $5M, and price between $5 and $500 (+1 point each).
3. It sorts all candidates by accumulated priority, takes the top 200, and scores each one using the conviction engine. Up to 50 symbols are scored per scan.
4. The top scorer that passes all the bot's entry filters (minimum score, VIX check, earnings window, etc.) wins the scan. The decision — and every symbol scored — is written to `bot_decisions`.
5. If the scan produced a `buy` decision, `bot-executor.js` (Phase B-3) picks it up within the next minute. It checks that the decision is fresh (under 6 minutes old), calculates position size, places the order through the bot's broker, records the trade, and starts monitoring it.
6. While the position is open, `bot-executor.js` polls the position every minute. When price moves in your favor, the trailing stop activates. When price hits stop or target, it places a closing order and logs a post-mortem.

This is the full loop. The scanner finds candidates. The executor acts on them. The guardian watches the open position. The post-mortem records what happened. The learning system extracts a lesson.

### The Architecture at a Glance

```
Browser / PWA (index.html + sw.js)
        │
        │  HTTP / WebSocket
        ▼
Express Server (server.js) — port 3000 (prod), 3001 (staging)
        │
        ├── Auth: requireAuth / requireAdmin
        ├── Sessions: PostgreSQL (http_sessions)
        ├── Crons: 30+ node-cron schedules
        │
        ├── Bot Engine (B-2)     ← Scans every 5 min
        ├── Bot Executor (B-3)   ← Executes buy decisions
        ├── Sentinel             ← 3 PM pre-close risk scan
        ├── Guardian             ← Continuous position monitoring
        │
        └── Core Modules
              ├── scoring.js       — Conviction scores
              ├── predictor.js     — 5-algorithm forecasts
              ├── news.js          — Benzinga sentiment
              ├── unusual-whales.js — UW flow + insider + congress
              ├── trader.js        — Order placement abstraction
              └── db.js            — Shared PostgreSQL pool

        Connected to:
        ├── PostgreSQL (50+ tables)
        ├── Alpaca API v2 (paper + live)
        ├── Tiger Brokers (tigeropen-node)
        ├── Futu/Moomoo (OpenD TCP)
        ├── Unusual Whales (REST + WebSocket)
        ├── Benzinga (REST)
        ├── Yahoo Finance 2
        └── Anthropic Claude (claude-sonnet-4-6)
```

---

<a name="chapter-3"></a>
## Chapter 3 — Running the System in Production

### The Three PM2 Processes

The platform runs as three PM2-managed processes:

**`trading-dashboard`** (port 3000) is the production web server. It serves the frontend, handles all API requests, runs the cron jobs, and manages the bot engine. This is the process your users connect to.

**`trading-staging`** (port 3001) is an identical server running from the same codebase but reading from `.env.staging`. Use it to test changes before touching production.

**`trading-bot`** is the background cron process for the bot engine. In some deployments this runs separately from the web server; in others the web server handles it. Check `pm2 list` to see what is running.

### Daily Operations

To restart after a code push:

```bash
git push chpavan main
pm2 restart trading-dashboard trading-staging
pm2 logs trading-dashboard --lines 30 --nostream   # watch for startup errors
```

When you change `.env`, a plain restart is not enough — PM2 caches environment variables:

```bash
pm2 restart trading-dashboard --update-env
```

Never use `pkill` to kill these processes — always go through PM2. A `pkill node` will kill all three processes simultaneously and any in-flight orders will not be tracked.

### Logs

```bash
pm2 logs trading-dashboard --lines 100     # live tail
~/.pm2/logs/trading-dashboard-out.log       # stdout archive
~/.pm2/logs/trading-dashboard-error.log     # stderr archive
```

Critical errors from background modules are also written to the `agent_error_log` database table and surfaced in the admin dashboard.

### The First-Time Universe Sync

The bot scanner draws its base candidate universe from the `tradable_universe` table, which is populated by a daily sync job. The first time you deploy, or after the database is wiped, this table will be empty. Run the sync manually as an admin:

```
POST /api/admin/universe-sync?force=true
```

Expected response: `{ fetched: ~4000–6000, enriched: ~3500–5000, skipped: <500, durationMs: 60000–180000 }`. After this, the bot scans will have a full base universe and the daily 8 AM ET cron will keep it refreshed.

---

<a name="chapter-4"></a>
# Part II — The Intelligence Engine

## Chapter 4 — How Stocks Are Scored

The conviction score is the central number that every other intelligent feature in this platform depends on. When the bot scanner picks a trade, it picks the highest-scoring candidate. When the AI chat evaluates a stock, it calls the scoring engine. When the Sentinel evaluates risk, it looks at conviction scores. Understanding how scoring works means understanding how the whole platform thinks about markets.

### The Seven Signals

Every scored stock is evaluated against seven signals. Each signal contributes a number between 0 and 100, and those numbers are combined into a final score using weights.

**Technical Analysis (25% weight by default)** pulls RSI, MACD, EMA trend, and Bollinger Band position from Yahoo Finance. A stock with RSI between 40 and 60, EMA slope trending up, MACD in a positive crossover, and price near the midpoint of its Bollinger Bands scores well here. Extreme RSI readings (above 75 or below 30) penalize the score.

**Relative Strength (20% weight)** measures how the stock is performing versus the S&P 500 over the last 5 and 20 days. A stock that goes up 3% while SPY goes up 1% has strong relative strength. This signal also reads the broader market regime — in a risk-off environment (VIX above 30), scores are damped down automatically because trending conditions that work in calm markets tend to fail in volatile ones.

**Momentum (15% weight)** looks at raw price performance over the last 1, 5, and 20 days. It rewards stocks that are in clean uptrends across multiple timeframes, and penalizes stocks that are bouncing after a large recent drop (the "catching a falling knife" pattern).

**Earnings Proximity (15% weight)** affects score based on when the next earnings report is. If earnings are 0–2 days away, the score is reduced by 15 points — earnings are unpredictable binary events that break technical setups. If earnings are 3–7 days away, a modest reduction applies. More than 7 days out, no adjustment.

**Options Flow Sentiment (10% weight)** reads the most recent Unusual Whales flow alerts for this ticker. Recent bullish call sweeps push this signal up. Recent bearish put activity pushes it down. If there is no recent options data for the stock, this component is neutral.

**Insider Activity (5% weight)** looks at recent Form 4 filings from Unusual Whales. CEO and director buys are a historically reliable signal — insiders rarely buy their own stock unless they believe in it. Multiple insider buys in the last 30 days can add meaningful points to this signal. Insider sells are more ambiguous (executives sell for many reasons) and are weighted less aggressively.

**ML Grade Adjustment (10% weight)** is a correction factor from the trained machine learning model. The model was trained on three years of historical OHLCV data and knows that certain indicator configurations — high RSI plus strong EMA plus positive MACD, for example — are historically more predictive of positive 5-day returns than others. The model outputs a grade (A, B, C, or F), and each grade adds or subtracts a fixed number of points from the final score. As of the most recent training run, the adjustments are approximately +8 for A, +3 for B, -2 for C, -9 for F.

### Reading a Score

The final score runs 0–100 and maps to a grade:
- **A (≥75)** — Strong conviction. Multiple signals aligned. The bot scanner targets these for entries.
- **B (60–74)** — Moderate conviction. Bot scanner will consider these if no A-grade candidates are available.
- **C (40–59)** — Mixed signals. Tradeable manually but not a clean setup.
- **F (<40)** — Negative conviction. Avoid.

Every scored symbol also gets a `conviction_breakdown` JSON showing exactly which signal contributed how much. When you see a surprising score in the dashboard, you can read the breakdown to understand why.

---

<a name="chapter-5"></a>
## Chapter 5 — Forecasting Price Moves

The prediction engine is different from the scoring engine. Scoring asks: "Is this a good stock to buy *right now*?" Forecasting asks: "Where will this stock be in five days?" These are related but distinct questions, and the platform handles them with a separate system.

### Five Algorithms in Parallel

Every week, for every symbol in your portfolio (and any symbol you request), the forecaster runs five algorithms simultaneously using `Promise.allSettled`. If any one algorithm fails, it fails silently — the others still contribute to the final result.

**Algorithm 1 — Linear Regression Trend** fits a line through the last 30 days of closing prices using ordinary least squares. It extrapolates that line forward to produce projected prices for days 1 through 10. The R² of the fit tells you how clean the trend is. *Here is a counterintuitive finding the system has learned from its own data: stocks with very high R² (close to 1.0, meaning the price has been moving in a very clean straight line) have historically worse direction accuracy than stocks with moderate R² around 0.3–0.6.* This is the R² reversal paradox — a stock that has been moving in a perfect straight line often reverses sharply. The calibration system applies a damping factor to high-R² predictions to compensate.

**Algorithm 2 — ATR Expected Move** uses Wilder's Average True Range over 14 days to calculate the statistically expected price range over the next 1, 5, and 10 days. It does not predict direction — it tells you the magnitude of likely movement. Combined with Algorithm 1 (which gives direction), you get a probability cone.

**Algorithm 3 — Momentum Score** synthesizes RSI, EMA alignment, MACD, and volume trend into a 0–100 momentum reading. It maps this reading to a price change expectation: high momentum suggests continuation, low momentum suggests consolidation or reversal.

**Algorithm 4 — Personal Trade Edge** is something most forecasting tools cannot offer. It queries your PostgreSQL `trades` table directly and computes your personal win rate, profit factor, and best-performing hours and days for this specific symbol. If you have a track record of 73% win rate on AAPL specifically but only 45% on NVDA, this algorithm knows that and adjusts the confidence accordingly.

**Algorithm 5 — Earnings Catalyst** uses Yahoo Finance's `calendarEvents` to find the next earnings date, revenue trend over the last four quarters, and EPS momentum. A company with accelerating revenue growth and a positive EPS surprise history has a catalyst-driven upside that pure price data does not capture.

### Calibration — Learning from Mistakes

Raw predictions are systematically biased. Every forecasting model that uses historical momentum data tends to over-extrapolate — it predicts stocks will continue moving in the direction they have been moving, but mean reversion is common. The platform corrects for this through `prediction-calibration.js`.

After every trading day, the system fills in the actual closing price for each outstanding prediction. Once enough data accumulates (minimum five actuals), it trains a calibration model for each symbol separately. The calibration learns:

- The **systematic bias** for this symbol — if AAPL predictions consistently run 1.5% too high, the calibration subtracts 1.5% from all future AAPL predictions
- The **volatility scale** — whether predictions tend to understate or overstate the magnitude of moves
- The **direction accuracy** — what percentage of the time the prediction got the direction right

The global calibration model also tracks the R² reversal paradox mentioned above, and applies a damping factor to predictions where R² > 0.6 and historical direction accuracy is below 35%.

---

<a name="chapter-6"></a>
## Chapter 6 — The ML Research Pipeline

The machine learning pipeline is where the platform learns from market history. It runs on a schedule — Saturday nights and nightly at 2 AM — and its outputs feed directly into the live scoring engine.

### The Four-Stage Pipeline

**Stage 1 — Download Prices** (`src/research/download-prices.js`) pulls three years of daily OHLCV data for every stock in the S&P 500, NASDAQ 100, plus SPY and VIX. This data goes into the `backtest_prices` table. Stage 1 only runs when the data is stale.

**Stage 2 — Compute Scores** (`src/research/compute-scores.js`) replays the historical price data and computes what the technical indicators (RSI, EMA, MACD, Bollinger Bands, relative volume) would have read on each historical date. This is important: the live scoring engine computes these in real-time, but the ML model needs historical snapshots to train on. The results go into `backtest_scores`.

**Stage 3 — Backtest Returns** (`src/research/backtest.js`) takes each historical date and looks forward to compute actual returns: +1 day, +1 week, +1 month, +3 months. It also flags "dip" conditions — stocks that fell more than 3% in the first two days. These forward returns are the training labels. They go into `backtest_returns`.

**Stage 4 — Train Model** (`src/research/train-model.js`) reads the historical scores and historical returns and trains a logistic regression classifier. The target variable is: did the stock return more than 1.5% over the next week? The features are: RSI (normalized), MACD sign, EMA trend direction, Bollinger Band position, relative volume ratio, the conviction score itself, VIX level, VIX above 20 flag, distance from 52-week high, and Monday flag (10 features total). The model outputs weights that translate these features into a probability, and those probabilities get binned into grades (A, B, C, F). The trained model goes into `model_results`.

The live scoring engine reads the latest model weights from `model_results` with a 24-hour cache. If no model has been trained yet, the system falls back to a simple heuristic: stocks in the top alpha decile historically outperform.

To run the full pipeline manually:
```bash
npm run research:download
npm run research:scores
npm run research:backtest
npm run research:train
```

---

<a name="chapter-7"></a>
# Part III — The Bot System

## Chapter 7 — Automated Trading End to End

The bot system is the most complex part of the platform. It consists of three phases that work together as a pipeline, plus a fourth phase (the rules editor) that lets you configure them.

### Phase B-0 — Bot Configuration

Before a bot can do anything, it needs to be configured. Each bot has a `rules` JSON object stored in the `bots` table that controls every aspect of its behavior. You configure bots through the "My Bots" tab in the dashboard. There is a natural language interface that lets you describe what you want ("only buy large-cap tech stocks, max $50 stop loss, avoid earnings week") and the system translates that into structured rules. You can also edit the rules directly.

The key configurable parameters are:

- **Entry filters** — minimum composite score, minimum conviction grade, maximum VIX, price range, minimum market cap, minimum average daily dollar volume, whether to avoid stocks within N days of earnings, and whether to check for UW flow labels or news sentiment thresholds
- **Position sizing** — what percentage of the bot's capital to deploy per trade (95% is common — deploy nearly everything while keeping a small buffer for fees)
- **Exit rules** — stop loss in dollars, trailing stop percentage
- **Circuit breaker** — maximum loss before the bot pauses itself for the day
- **Composite weights** — how much each signal type contributes to the bot's scoring

Every time rules are changed, the old rules are preserved in `bot_rules_versions` so you can audit what changed and when.

### Phase B-2 — The Scanner Engine

`src/core/bot-engine.js` is the scanner. It runs every five minutes during market hours (9:30 AM – 4:00 PM ET, Monday–Friday). On each run, for each active bot:

1. **Check circuit breaker** — if the bot has lost more than its `max_loss_usd` today, log a `skip_circuit_breaker` decision and stop.
2. **Build candidate universe** — described in detail in Chapter 8.
3. **Score top candidates** — run the conviction engine on up to 50 candidates, sorted by priority.
4. **Apply entry filters** — check each scored candidate against the bot's rules: minimum score, conviction grade, VIX level, price range, market cap, ADV, earnings proximity, and any optional filters.
5. **Pick the winner** — the top-scoring candidate that passes all filters.
6. **Log the decision** — write the full decision to `bot_decisions`, including every candidate considered and every filter applied.

The scanner never places orders. It only produces decisions. This separation is intentional — it means the decision log is always clean and auditable regardless of whether execution succeeds.

### Phase B-3 — The Executor

`src/core/bot-executor.js` reads fresh buy decisions from `bot_decisions` and acts on them. "Fresh" means within 6 minutes — if the scan decision is older than that, market conditions may have changed and the executor skips it.

For each actionable decision, the executor:

1. Verifies the bot is still active and not already in a position
2. Calculates position size from the bot's capital and `position_size_pct` rule
3. Decides order type: limit at `current_price + limit_offset_bps/10000`, or market if `order_type = 'market'`
4. Places the order through `trader.js` using the bot's configured broker
5. Records the trade in the `trades` table with `bot_id` filled in
6. Starts the position monitoring loop

While a position is open, the executor checks it every minute. When the price moves in your favor by enough to activate the trailing stop, it updates the stop level. When price crosses the stop, it fires a closing order. When the position closes, it writes a `trade_postmortem` — a JSON snapshot of market conditions at entry and exit, with an AI-generated prose summary.

### Phase B-4 — The Reconciler

`src/core/bot-reconciler.js` runs every 15 minutes and catches anything the executor missed. Closed broker positions that do not have matching close records in the database get reconciled. Orphaned trades from previous sessions get cleaned up. This prevents the bot's internal state from drifting away from broker reality.

---

<a name="chapter-8"></a>
## Chapter 8 — Building the Candidate Universe

Before the scanner can score stocks, it needs a list of stocks to consider. This is the candidate universe problem, and it is more subtle than it looks.

Early versions of the scanner used a static list — hand-maintained tickers, or a hardcoded S&P 500 list. The problem with this approach is that static lists go stale, reflect personal bias, and miss the most important signal of all: *what is actually moving right now?*

The current universe is dynamic and built from four sources, each with a priority weight that reflects how informative it is.

**Unusual Whales flow alerts (priority +10 to +15)** are the highest priority source. When a large unusual options trade comes in on a stock — a multi-million-dollar call sweep that is far out of the ordinary for that ticker — it means an institutional buyer is expressing a high-conviction view. This is the most valuable signal available to retail traders, and it should be the first thing the scanner examines. The priority weight scales with premium size: a $10M call sweep gets a higher priority bump than a $1M one.

**Benzinga news (priority +8 to +12)** captures stocks with recent catalyst events: earnings beats, analyst upgrades, regulatory approvals, product launches. When multiple articles are written about a stock in a short window, it usually means something real happened. More articles means a higher priority bump.

**Top movers (+5)** pull from the `uw_top_movers` table — stocks in the top gainers list over the last 30 minutes. A stock that is already moving has momentum; the scanner should at least evaluate it.

**Base universe (+1)** provides coverage. Not every good trade comes with a news headline or an options sweep. The `tradable_universe` table contains every NYSE and NASDAQ stock that is actively tradable through Alpaca, enriched with Yahoo Finance market cap, 30-day average daily volume, and current price. The bot scanner uses it as a filter: only stocks with market cap ≥ $5B, ADV ≥ $5M, and price between $5 and $500 qualify for consideration. These filters eliminate penny stocks, illiquid names, and micro-caps where the scanner's signals are unreliable.

The four priority sources are merged into a single priority map. If a stock appears in multiple sources, its weights accumulate — a stock with a recent call sweep *and* a news catalyst *and* price action will rank far above a stock that is only in the base universe. The top 200 by accumulated weight are then passed to the scoring engine.

### Keeping the Universe Fresh

The `tradable_universe` table is populated by `src/core/universe-sync.js`, which runs every weekday at 8 AM ET. It fetches all active US equity assets from the Alpaca `/v2/assets` endpoint (typically 4,000–7,000 symbols), filters to NYSE and NASDAQ only, upserts the broker metadata, then runs a Yahoo Finance enrichment pass with concurrency 20 to fill in market cap, ADV, price, and sector. The full sync takes 1–3 minutes.

A guard prevents unnecessary re-syncs: if more than 50% of rows were updated in the last 24 hours, the sync skips unless you pass `force=true`.

---

<a name="chapter-9"></a>
## Chapter 9 — Risk Management and the Guardian

### The Position Guardian

While the bot executor manages bot-opened positions, `src/core/guardian.js` watches all positions — both manual and bot-placed. It polls every minute during market hours. For each open position it:

- Checks whether current price has crossed the stop loss
- Checks whether current price has hit the take profit target
- Manages the trailing stop logic: once a position is up by a threshold amount, the stop moves to breakeven; once up further, the stop begins trailing behind at a fixed percentage
- Writes position monitoring state to `position_monitoring` so the executor and guardian stay in sync

The `position_monitoring` table is the shared state between these two modules. It holds the current stop level, whether the stop has moved to breakeven, whether trailing has activated, and the last checked price.

### The Pre-Close Sentinel

`src/core/sentinel.js` is the daily risk advisor. It runs every weekday at 3 PM ET (one hour before market close) and on Sunday evenings at 6 PM ET to prepare for the week ahead.

The Sentinel scans every open position — both Alpaca and Moomoo — against eight risk signals:

1. **Earnings within 2 days** — the most common cause of unexpected position moves
2. **Recent news** — negative headlines that could affect overnight positioning
3. **Prediction accuracy degraded** — if the system's forecasts for this stock have been consistently wrong, that is a signal to reduce confidence
4. **Sector concentration** — if more than 40% of the portfolio is in a single sector, that is undiversified risk
5. **Macro events in the next 24 hours** — FOMC, CPI, non-farm payrolls: events that move everything
6. **Unusual options activity** — large put sweeps on a position you are long (requires UW API key)
7. **Insider selling** — Form 4 sell filings from executives (requires UW API key)
8. **Congressional selling** — STOCK Act disclosures showing politicians selling a stock you own (requires UW API key)

For each risk found, the Sentinel generates a severity rating (critical, high, medium) and a human-readable explanation. Critical risks trigger one-click HMAC-signed trade proposals — links in the risk email that, when clicked, execute a specific trade action (reduce size, move stop, close position) without requiring you to log in.

**Important design principle:** Claude writes only the prose explanation. Every trade parameter — symbol, side, quantity, stop price — is computed entirely in Node.js code. The AI is never trusted to invent trade parameters, only to explain them in natural language.

The signed token system uses HMAC-SHA256 with a 30-minute expiry and a price drift check: if the stock has moved more than 2% from when the proposal was generated, the link refuses to execute. This prevents stale recommendations from being acted on in a very different market.

---

<a name="chapter-10"></a>
# Part IV — Where Data Comes From

## Chapter 10 — Broker Connections

The platform supports three brokers. Each has a different connection model and different capabilities.

### Alpaca

Alpaca is the primary broker. It offers a clean REST API, commission-free trading, paper trading that mirrors the live API, and fractional shares — which means bots can deploy exact dollar amounts rather than rounding to whole shares.

Alpaca credentials are stored encrypted (AES-256) in the `users` table. Each user can have separate paper and live credentials. The system-level credentials in `.env` serve as fallback; per-user credentials take precedence.

The Alpaca module in `src/brokers/alpaca.js` handles all REST calls: quotes, positions, orders, account balance, and the `/v2/assets` endpoint used for universe sync. It automatically selects paper vs. live credentials based on the current account context.

### Tiger Brokers

Tiger supports international markets and is the platform's secondary broker. It uses the `tigeropen-node` library, which communicates with Tiger's servers over HTTPS using RSA private key authentication.

Tiger has three environments: Demo (virtual money, Tiger's servers), Demo API (virtual money, local simulation), and Live. The platform stores separate credentials for demo and live accounts per user. The environment switcher in the Trading Desk UI lets you select which Tiger environment to trade against.

### Moomoo (Futu OpenD)

Moomoo is connected through Futu's OpenD client — a desktop application that must be running on the same machine as the server. The platform connects to OpenD over TCP (default port 11111). This is unlike the other brokers that connect over the internet; Moomoo requires the OpenD desktop app as a local proxy.

The Moomoo module in `src/brokers/moomoo-tcp.js` handles account listing, position queries, order placement, and order cancellation. Trades are in `simulate` mode by default; set `MOOMOO_TRADE_ENV=real` in `.env` to go live.

---

<a name="chapter-11"></a>
## Chapter 11 — Market Intelligence Sources

### Unusual Whales

Unusual Whales is the platform's most sophisticated data source. It provides institutional-grade options market data, insider transaction data, and congressional trading data — the same information that was previously available only to professional traders.

The integration in `src/core/unusual-whales.js` is built to be sustainable on a single personal API account. It implements:

- A **dual token bucket rate limiter** that respects both the per-minute limit (120 requests) and the daily limit (80,000 requests)
- An **in-memory TTL cache** that prevents redundant calls for the same data within a short window
- A **WebSocket connection** for real-time options flow streaming, with automatic reconnection and exponential backoff

The platform ingests UW data through several cron jobs:

- **Every 2 minutes (market hours):** Options flow alerts into `uw_flow_alerts`
- **Every 5 minutes (market hours):** Top movers into `uw_top_movers`
- **Every 15 minutes:** Insider trades into `uw_insider_trades`
- **Every hour:** Congressional trades into `uw_congressional_trades`
- **Daily at 6 AM ET:** Economic calendar and IPO calendar

A separate daily maintenance suite runs in the early morning: retention purge at 3 AM, quota alarm at 4 AM, schema linter at 7 AM, data quality report at 8 AM.

All UW features degrade gracefully if the `UW_API_KEY` environment variable is missing. The dashboard shows "Requires UW API key" rather than crashing.

### Benzinga

Benzinga provides news and earnings data. The `src/core/benzinga.js` module is the integration point. News articles are fetched for specific symbols and for the broad market, with articles scored for sentiment and stored in `benzinga_news`. The bot scanner uses Benzinga to identify stocks with recent catalyst coverage.

Benzinga is also used for the earnings calendar: what companies are reporting today, tomorrow, and this week. The pre-market earnings view in the dashboard pulls from Benzinga.

### Yahoo Finance

Yahoo Finance, via the `yahoo-finance2` npm package, is used in two contexts: universe sync enrichment (market cap, ADV, price, sector for 4,000–7,000 symbols daily), and real-time quote data for the scoring engine when a ticker is not available through Alpaca.

Yahoo Finance requires no API key, but it has rate limits. The universe sync handles this with concurrency throttling: it processes 20 symbols simultaneously in batches, and logs failures without crashing the sync.

### Anthropic Claude

Claude (`claude-sonnet-4-6`) is the conversational AI layer. It handles questions that require reasoning — trade analysis, "should I hold or sell?" decisions, post-mortem prose generation, and natural language bot rule editing. 

The chat routing system (`src/core/ai-chat.js`) is designed to minimize Claude API costs. Before calling Claude, it tries three cheaper alternatives: keyword match against the knowledge base (free), vector similarity search using Ollama's local embedding model (free), and direct database queries for trade history or fundamental screening questions (free). Only when these fail does it call Claude.

Claude is never allowed to invent trade parameters. All quantitative numbers in the system — position sizes, stop levels, limit prices, option strikes — come from deterministic Node.js code. Claude only writes prose.

---

<a name="chapter-12"></a>
# Part V — The Interface

## Chapter 12 — The Desktop Dashboard

The dashboard is a single-page application built in vanilla JavaScript with no framework dependencies. It loads entirely from `src/web/public/index.html` — one file that contains all the HTML, CSS, and JavaScript. This makes it fast and simple to debug: anything that renders in the browser lives in that file.

### The Navigation Tabs

The top navigation bar organizes the dashboard into distinct work areas. Each tab is designed around a specific job to be done:

**P&L Dashboard** is the home screen. It shows account balance, unrealized P&L, today's realized P&L, and a P&L chart. Nested widget tabs provide drill-down views: Open Positions, Recent Trades, Intraday Picks, Watchlist, Trade History, Notes, and the Unusual Whales panels (Options Flow, Insider Trades, Congressional Trades, Correlations, Flow History, Sentinel Activity).

**Market** shows the macro picture: market regime (risk-on, risk-off, neutral), VIX level, top gainers and losers, and recent market news.

**Signal Center** is the scanner view. It shows the real-time conviction scores for the stocks currently under evaluation, with their breakdown by signal. This is where you can see which stocks the bot is considering and why.

**Trading Desk** is the manual trading interface. It is styled after institutional trading terminals with a three-column layout: watchlist on the left, chart and order entry in the center, and signals/conviction scores on the right. Prices update via WebSocket in real-time.

**Calendar** shows the upcoming earnings calendar, FDA catalyst dates, and dividend dates.

**Research** gives access to the ML pipeline: run backtests, view model results, and inspect prediction accuracy by symbol.

**My Bots** is the bot management interface. Create, configure, pause, and monitor your automated trading bots. The "❓ How it works" button in the header opens a detailed explanation of the bot system.

**Stock Explorer** is a floating side panel accessible from any tab. Enter a ticker to see conviction score, prediction forecast, options flow, insider activity, analyst ratings, and news — everything the platform knows about that stock in one view.

### The Service Worker and Offline Support

`src/web/public/sw.js` is the service worker that makes the dashboard a Progressive Web App. It implements a tiered caching strategy:

- **Static shell** (HTML, CSS, JS): served cache-first, always fast even offline
- **Dashboard data** (`/api/dashboard`, `/api/forecast`, `/api/uw/flow-alerts`): stale-while-revalidate — you see the last-known data instantly while fresh data loads in the background
- **Other API calls**: network-first with 5-second timeout, falling back to cache
- **Trade orders**: queued in IndexedDB via background sync, replayed when connectivity returns

The cache is versioned (`trading-v25` as of this writing). Increment the version number whenever you push changes that users should pick up immediately. Never downgrade the version number — doing so would cause old clients to serve newer cached assets incorrectly.

---

<a name="chapter-13"></a>
## Chapter 13 — The Mobile Experience

`src/web/public/mobile.html` is the mobile PWA, deployed as a separate experience from the desktop dashboard. It is a fully independent 5-tab application optimized for touch interaction on iPhone and iPad, designed to be installed as a home screen app.

The five tabs are: Home (positions and quick actions), Trade (order placement), Bots (bot status and control), Portfolio (P&L history and charts), and AI (the Akshaya AI chat interface).

The mobile app uses the same backend API as the desktop. There is no separate server — it is the same Express instance, the same authentication, the same data. The difference is purely in the frontend: simpler layout, larger touch targets, bottom navigation, bottom sheet modals instead of overlays.

A backup copy is preserved at `mobile-v1.html` for emergency rollback. Do not edit `mobile-v1.html` — it is a snapshot only.

---

<a name="chapter-14"></a>
# Part VI — Deep Reference

## Chapter 14 — The Complete Database Schema

All tables are created idempotently by `initDb()` in `src/core/db.js` on every server start. You never need to run migrations manually — if a table does not exist, it will be created. If it already exists, the `CREATE TABLE IF NOT EXISTS` pattern leaves it untouched.

---

### Authentication and Session Tables

**`users`** — The master user record. Holds credentials, role (`admin`/`user`/`viewer`), plan, credit balance, per-user permission overrides, broker credentials (all encrypted at rest with AES-256), and consent timestamps.

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PK | |
| `username` | TEXT UNIQUE | Login handle |
| `email` | TEXT | |
| `password_hash` | TEXT | bcrypt |
| `role` | TEXT | admin / user / viewer |
| `plan` | TEXT | Subscription tier |
| `credits` | INT | API credit balance |
| `permissions` | JSONB | Per-user overrides |
| `suspended` | BOOLEAN | |
| `terms_accepted_at` | TIMESTAMPTZ | ToS consent |
| `auto_trade_consent_at` | TIMESTAMPTZ | Bot trading consent |
| `bot_config` | JSONB | Per-user bot defaults |
| `alpaca_api_key / secret / base_url` | TEXT | Encrypted Alpaca paper |
| `alpaca_live_api_key / secret` | TEXT | Encrypted Alpaca live |
| `moomoo_acc_id` | TEXT | |
| `tiger_id / account / private_key` | TEXT | Tiger live (encrypted) |
| `tiger_demo_id / account / private_key` | TEXT | Tiger demo (encrypted) |
| `disabled_sources` | TEXT[] | Blocked brokers for this user |
| `created_at / last_login` | TIMESTAMPTZ | |

**`otp_tokens`** — Email one-time passwords for passwordless login. Each code is bcrypt-hashed, expires in 15 minutes, and can only be used once.

**`http_sessions`** — Express session store backed by PostgreSQL. Sessions survive server restarts.

**`push_subscriptions`** — Web push registrations for PWA push notifications. One row per browser registration.

**`webauthn_credentials`** — Biometric authenticator registrations (Face ID, Touch ID, Windows Hello). The signature counter provides replay protection.

---

### Trading Tables

**`trades`** — The central trade record. Every order placed through any path — manual, quick order, bot, force trade — creates a row here when filled. Key fields to understand:

- `conviction_breakdown` (JSONB) — a snapshot of every signal value at the time the trade was placed, so you can always reconstruct *why* the system liked this stock
- `bot_id` (FK → bots) — NULL for manual trades, set for bot trades
- `account_source` — which broker executed this: `alpaca`, `moomoo`, `tiger`, or `tiger_demo`
- `peak_pnl_usd` — the highest unrealized P&L the trade reached, even if it later reversed (useful for identifying trades where you should have taken profit earlier)

**`conviction_scores`** — Historical record of every scoring run. The scanner logs each scored symbol with its full signal breakdown. Use this to audit why the bot targeted a specific stock on a given day.

**`daily_pnl`** — Aggregated P&L per user per broker per day. Pre-computed for fast dashboard loading.

**`account_daily_snapshots`** — Portfolio value snapshots. Used to draw the P&L history chart.

**`trade_rejections`** — Every trade the guard logic blocked, with the specific reason. Useful for debugging why the bot stopped trading.

**`position_monitoring`** — Live position tracking state for the guardian. One row per open symbol. Updated every minute.

---

### Market Intelligence Tables

**`stock_predictions`** — Weekly 5-day price forecasts. One row per symbol per forecast day. After each market day, the `actual_price` and `actual_change_pct` are filled in by the EOD cron. The `adjusted_change_pct` column is the calibration-corrected forecast. Note the `r_squared` column and the counterintuitive relationship described in Chapter 5: high R² does not mean high accuracy.

**`prediction_calibration`** — Per-symbol learned corrections: bias (systematic over/under-prediction), vol_scale (magnitude error), dir_accuracy (% of time direction was correct).

**`prediction_calibration_global`** — Global model statistics: R² bucket breakdowns and the global bullish bias correction.

**`prediction_errors`** — One row per filled prediction. Training data for the calibration model.

**`fundamentals`** — Quarterly financial statements per symbol: revenue, gross profit, operating income, net income, EPS. Sourced from Benzinga.

**`tradable_universe`** — Alpaca-authoritative asset master, enriched by Yahoo Finance. 4,000–7,000 NYSE/NASDAQ symbols with market cap, ADV, price, and sector. Refreshed daily at 8 AM ET. This is the base layer of the bot's candidate universe (Chapter 8).

---

### Unusual Whales Tables

These tables are all populated by background cron jobs and have automatic retention purges. If `UW_API_KEY` is not set, these tables will remain empty and the related dashboard widgets will gracefully indicate that UW data is unavailable.

**`uw_flow_alerts`** — The primary options flow table. Ingested every 2 minutes during market hours. Each row represents a notable options trade: ticker, side (call/put), strike, expiry, premium, volume, open interest, sentiment label. The bot scanner reads this table when building the candidate universe — high-premium bullish alerts get high priority bumps. Retention: 90 days.

**`uw_options_flow`** — Raw options flow data, slightly more granular than flow_alerts. Same retention.

**`uw_insider_trades`** — Form 4 SEC filings. CEO and director transactions. Ingested every 15 minutes. The Sentinel uses this table to flag if an insider has been selling a stock you are long.

**`uw_congressional_trades`** — STOCK Act disclosures from House and Senate members. Ingested hourly. Congressional trading patterns have proven historically informative — members of Congress have materially outperformed the market over long periods.

**`uw_top_movers`** — Top gainers and losers, updated every 5 minutes. Used by the bot scanner as a priority source. Retention: 30 days.

**`uw_economic_calendar`** — Upcoming macro events: FOMC meetings, CPI releases, non-farm payrolls, etc. Ingested daily at 6 AM ET. The Sentinel uses this to warn about overnight macro risk.

**`uw_ipo_calendar`** — Upcoming IPOs with price range and shares offered. Ingested daily.

**`uw_greek_exposure`** — Options Greek snapshots per symbol per day: gamma, delta, charm, vanna. Useful for understanding options dealer positioning.

**`uw_max_pain`** — Max pain strike per symbol per expiry. Max pain theory suggests stock prices gravitate toward the strike at which option sellers retain the most premium at expiry.

**`uw_options_volume`** — Put/call volume breakdown per symbol per day with premium flows.

---

### Bot System Tables

**`bots`** — One row per bot. The `rules` JSONB column is the complete configuration object (see Chapter 7 for the full schema). The `status` field tracks the bot's state: `active`, `paused`, `paused_today` (circuit breaker triggered), or `stopped`. The `current_trade_id` FK points to the currently open trade so the executor knows which position belongs to this bot.

**`bot_decisions`** — The decision audit log. Every five-minute scan writes a row: the action taken (`buy`, `hold`, `skip_no_candidate`, `skip_filtered`, `skip_circuit_breaker`, `skip_inflight`), the winning symbol (if any), its composite score, and the full factor breakdown showing every candidate considered. This is the most valuable debugging table in the bot system — if the bot is not trading when you expect it to, check `bot_decisions` to see exactly what it evaluated and why each candidate was rejected.

**`trade_postmortems`** — Exit analysis for each closed bot trade. Includes market state snapshots at entry and exit, the diff analysis, and an AI-written prose summary. Used for learning and performance review.

**`bot_rules_versions`** — Full history of rules changes per bot. Every time you edit a bot's rules, the previous rules are preserved here.

---

### System and Utility Tables

**`sentinel_runs`** — One row per Sentinel execution. Tracks how many risks were found, how many proposals were generated, and whether the email was sent.

**`pending_actions`** — HMAC-signed one-click trade proposals generated by the Sentinel. Expire after 30 minutes. Include a price drift check: if the stock has moved more than 2% from when the proposal was created, execution is refused.

**`system_alerts`** — Critical system-level alerts (API quota warnings, connection failures, etc.) surfaced in the admin panel.

**`knowledge_chunks`** — The trading education knowledge base. Text chunks with vector embeddings (from Ollama's `nomic-embed-text` model). The AI chat system searches this before calling Claude — matched chunks are served for free.

**`user_notes`** — Personal trade journal. Free-text notes with optional ticker association.

**`user_reminders`** — Scheduled reminders set via the AI chat (`set_reminder` tool) or the Notes tab.

**`trade_lessons`** — AI-generated reflections on closed trades. Categorized by outcome, market regime, and VIX level. The system prompt rebuilds the most relevant lessons before each Claude call, so the AI always has your recent trading history in context.

**`performance_patterns`** — Historical win rates by market regime and VIX bucket. The AI uses this to understand when you trade well and when you do not.

**`system_kv`** — Generic key-value store. Used for Yahoo Finance cookie jar persistence, UW WebSocket state, and other system-level values that do not need their own table.

**`agent_error_log`** — Structured error log from background processes and browser JS errors. Surfaced in the admin panel so you can see what failed and when.

**`bug_reports`** — User-submitted bug reports with admin response tracking.

---

<a name="chapter-15"></a>
## Chapter 15 — The Complete API Reference

All routes are served by `src/web/server.js`. Auth levels: **Public** (no auth), **Auth** (valid session required), **Admin** (role = admin required), **HMAC** (signed token, Sentinel one-click links only).

---

### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | Public | Password login, sets session cookie |
| POST | `/auth/logout` | Public | Destroys session |
| POST | `/auth/register` | Public | Self-service account creation |
| POST | `/auth/otp/request` | Public | Send 6-digit OTP to email |
| POST | `/auth/otp/verify` | Public | Verify OTP, create session |
| GET | `/auth/check` | Public | Returns current user, role, permissions, broker status |
| POST | `/api/client-error` | Public | Log browser JS errors |

---

### User Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/users/add` | Admin | Create user |
| POST | `/api/users/remove` | Admin | Delete user |
| GET | `/api/users/list` | Admin | All users with roles/credits/permissions |
| POST | `/api/users/permissions` | Admin | Set per-user permissions |
| POST | `/api/users/permissions/reset` | Admin | Reset to role defaults |
| POST | `/api/users/sources/disable` | Admin | Block user from specific brokers |
| POST | `/api/users/credits` | Admin | Adjust credit balance |
| GET | `/api/users/activity` | Admin | User audit log |
| GET | `/api/users/analytics` | Admin | Usage breakdown |

---

### Broker Credentials

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/alpaca/connect` | Auth | Store Alpaca paper key |
| POST | `/api/alpaca/disconnect` | Auth | Remove Alpaca paper credentials |
| POST | `/api/alpaca/disconnect-live` | Auth | Remove Alpaca live credentials |
| GET | `/api/moomoo/accounts` | Auth | List Moomoo accounts via OpenD |
| POST | `/api/moomoo/connect` | Auth | Link Moomoo account |
| POST | `/api/moomoo/disconnect` | Auth | Unlink Moomoo |
| POST | `/api/tiger/connect` | Auth | Store Tiger credentials |
| POST | `/api/tiger/disconnect` | Auth | Remove Tiger credentials |

---

### Market Data

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/home` | Auth | Dashboard summary: P&L, balance, top trades |
| GET | `/api/home-news` | Auth | Recent market headlines |
| GET | `/api/home-earnings` | Auth | Earnings today/tomorrow |
| GET | `/api/market-status` | Auth | Market open/closed, next open |
| GET | `/api/market` | Auth | Regime, direction, VIX, movers |
| GET | `/api/market/top-stocks` | Auth | Top gainers and losers |
| GET | `/api/scores` | Auth | Live conviction scores |
| GET | `/api/strong-buys` | Auth | Today's high-conviction picks |
| GET | `/api/intraday-picks` | Auth | Intraday setups |

---

### Trading Desk

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/td-symbols` | Auth | Full S&P500+NASDAQ100 symbol list |
| GET | `/api/td-names` | Auth | Company names + prices |
| GET | `/api/quote/:symbol` | Auth | Single quote |
| GET | `/api/quotes/batch` | Auth | Multiple quotes |
| GET | `/api/chart-data/:symbol` | Auth | OHLCV + indicators for charting |
| GET | `/api/mini-chart/:symbol` | Auth | Compact OHLCV |
| GET | `/api/search` | Auth | Symbol / company name search |

---

### Trades and P&L

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/trades` | Auth | List trades (open/closed/all) |
| GET | `/api/positions` | Auth | Current open positions, all brokers |
| POST | `/api/trade/force` | Auth | Manual trade (symbol, side, qty, stop, target) |
| POST | `/api/trade/quick` | Auth | Quick order by % of account |
| POST | `/api/trade/close` | Auth | Close a position |
| POST | `/api/trade/move-stop` | Auth | Move stop to breakeven |
| GET | `/api/pnl` | Auth | P&L history + chart |
| GET | `/api/pnl-debug` | Auth | P&L calculation diagnostics |

---

### Moomoo

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/moomoo/trade-status` | Auth | Order status |
| POST | `/api/moomoo/trade` | Auth | Place trade |
| POST | `/api/moomoo/cancel` | Auth | Cancel order |

---

### Earnings and Catalysts

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/earnings` | Auth | Earnings calendar (today/week) |
| GET | `/api/earnings/:symbol` | Auth | Earnings history for symbol |
| GET | `/api/catalysts` | Auth | Tomorrow's catalyst events |

---

### Forecasts and Predictions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/forecast` | Auth | Weekly 5-day forecasts (calibrated) |
| GET | `/api/forecast/:symbol` | Auth | Forecast for specific symbol |
| GET | `/api/forecast/failure-analysis` | Auth | Worst-performing symbols + R² bucket stats |
| POST | `/api/forecast/train-calibration` | Admin | Manually retrain calibration model |

---

### Chat and AI

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/chat` | Auth | SSE streaming chat (Akshaya AI) |
| GET | `/api/chat/history` | Auth | Last 20 messages for a chatId |
| POST | `/api/knowledge/add` | Admin | Add knowledge chunk |
| GET | `/api/knowledge/search` | Auth | Search knowledge base |

---

### Scanner

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/scanner/run` | Admin | Manual scan trigger |
| GET | `/api/scanner/results` | Auth | Latest scan results |

---

### Watchlist

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/watchlist` | Auth | User's watchlist |
| POST | `/api/watchlist/add` | Auth | Add symbol |
| DELETE | `/api/watchlist/:symbol` | Auth | Remove symbol |

---

### Unusual Whales

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/uw/flow-alerts` | Auth | Recent options flow alerts |
| GET | `/api/uw/flow-alerts-history` | Auth | DB-backed flow history (24h/7d) |
| GET | `/api/uw/market-tide` | Auth | Market-wide options sentiment |
| GET | `/api/uw/options-flow` | Auth | Options flow for specific symbol |
| GET | `/api/uw/insider` | Auth | Insider trades (Form 4) |
| GET | `/api/uw/congressional` | Auth | Congressional STOCK Act trades |
| GET | `/api/uw/movers` | Auth | Top movers |
| GET | `/api/uw/correlations` | Auth | 30d/90d correlations |
| GET | `/api/uw/quota` | Auth | API quota usage |

---

### Bot System

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/bots` | Auth | List user's bots |
| POST | `/api/bots` | Auth | Create bot |
| GET | `/api/bots/:id` | Auth | Bot detail + KPIs |
| PATCH | `/api/bots/:id` | Auth | Update bot rules |
| DELETE | `/api/bots/:id` | Auth | Soft-delete bot |
| POST | `/api/bots/:id/pause` | Auth | Pause bot |
| POST | `/api/bots/:id/resume` | Auth | Resume bot |
| GET | `/api/bots/:id/decisions` | Auth | Decision log for this bot |
| POST | `/api/bots/reconcile` | Auth | Reconcile open bot positions |

---

### Sentinel and Risk

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/sentinel/run` | Admin | Trigger Sentinel scan manually |
| GET | `/api/sentinel/recent` | Auth | Most recent Sentinel run result |
| GET | `/api/sentinel/runs/:id` | Auth | Specific Sentinel run detail |

---

### One-Click Actions (Sentinel)

These routes use HMAC token auth only — no session required. They are embedded in Sentinel email links.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/action/execute/:id` | HMAC | Execute a pending trade proposal |
| GET | `/api/action/ignore/:id` | HMAC | Mark proposal as ignored |

---

### Push, Biometric, Notes, Reminders

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/push/vapid-key` | Public | VAPID public key for push subscription |
| POST | `/api/push/subscribe` | Auth | Register push subscription |
| DELETE | `/api/push/unsubscribe` | Auth | Remove push subscription |
| POST | `/api/webauthn/register/begin` | Auth | Start WebAuthn registration |
| POST | `/api/webauthn/register/finish` | Auth | Complete registration |
| POST | `/api/webauthn/authenticate/begin` | Auth | Start biometric login |
| POST | `/api/webauthn/authenticate/finish` | Auth | Verify + set biometric session |
| GET | `/api/notes` | Auth | List notes newest-first |
| POST | `/api/notes` | Auth | Create note |
| DELETE | `/api/notes/:id` | Auth | Delete note |
| GET | `/api/reminders` | Auth | List reminders |
| POST | `/api/reminders` | Auth | Create reminder |
| PATCH | `/api/reminders/:id` | Auth | Update reminder |
| DELETE | `/api/reminders/:id` | Auth | Delete reminder |

---

### Admin Utilities

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/admin/universe-sync` | Admin | Trigger tradable universe sync (add `?force=true` to bypass guard) |
| GET | `/api/admin/db-status` | Admin | Database health check |
| GET | `/api/admin/agent-errors` | Admin | Recent background agent errors |
| POST | `/api/bug-report` | Auth | Submit bug report |

---

<a name="chapter-16"></a>
## Chapter 16 — Configuration and Environment Variables

All configuration is read from `.env` (production) or `.env.staging` (staging). Values are never committed to git. After changing `.env`, restart with `pm2 restart trading-dashboard --update-env` — a plain restart will not pick up the changes.

### Core Server

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `NODE_ENV` | No | development | `production` / `development` |
| `SESSION_SECRET` | Yes | — | Express session key (min 32 characters) |
| `DASHBOARD_PORT` | No | 3000 | HTTP listen port |
| `PUBLIC_URL` | Yes | — | Base URL for email links and WebAuthn (`https://yourdomain.com`) |
| `SECURE_COOKIE` | No | false | Set `true` behind an HTTPS reverse proxy |
| `CREDENTIAL_ENCRYPTION_KEY` | Yes | — | AES-256 key for encrypting broker credentials at rest |
| `ACTION_SIGNING_SECRET` | Yes | — | HMAC-SHA256 secret for Sentinel one-click trade links |

### AI

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `OLLAMA_URL` | No | http://localhost:11434 | Ollama server for local inference |
| `OLLAMA_MODEL` | No | llama3.2:latest | Ollama chat model |
| `OLLAMA_KNOWLEDGE_MODEL` | No | nomic-embed-text | Ollama embedding model |
| `DAILY_API_CAP_USD` | No | unlimited | Daily Claude spend limit |

### Brokers

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ALPACA_API_KEY` | No | — | System-level Alpaca paper key |
| `ALPACA_SECRET_KEY` | No | — | System-level Alpaca paper secret |
| `ALPACA_BASE_URL` | No | paper URL | Alpaca API base URL |
| `ALPACA_LIVE_API_KEY` | No | — | Alpaca live account key |
| `ALPACA_LIVE_SECRET_KEY` | No | — | Alpaca live secret |
| `MOOMOO_OPEND_HOST` | No | localhost | Futu OpenD TCP host |
| `MOOMOO_OPEND_PORT` | No | 11111 | Futu OpenD TCP port |
| `MOOMOO_TRADE_ENV` | No | simulate | `simulate` or `real` |
| `MOOMOO_TRADE_PASSWORD` | No | — | Moomoo trading password |
| `TIGER_ID` | No | — | Tiger system-level account ID |
| `TIGER_PRIVATE_KEY` | No | — | Tiger private key (PEM format) |

### Alternative Data

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `UW_API_KEY` | No | — | Unusual Whales API key. All UW features degrade gracefully without it |
| `UW_WS_URL` | No | UW default | Unusual Whales WebSocket URL |
| `UW_FLOW_RETENTION_DAYS` | No | 90 | Days to retain options flow data |
| `UW_MOVERS_RETENTION_DAYS` | No | 30 | Days to retain top movers data |
| `BENZINGA_API_KEY` | No | — | Benzinga news and earnings |
| `BENZINGA_API` | No | — | Benzinga API base URL |

### Notifications

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RESEND_API` | No | — | Resend email API key |
| `RESEND_FROM` | No | info@dlpinnovations.com | From address |
| `SENTINEL_EMAIL_TO` | No | — | Sentinel risk alert recipient |
| `SENTINEL_EMAIL_FROM` | No | — | Sentinel from address |
| `SENTINEL_DRIFT_TOLERANCE` | No | 0.02 | Price drift tolerance for one-click links (2%) |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token |
| `TELEGRAM_CHAT_ID` | No | — | Telegram chat ID |
| `TWILIO_ACCOUNT_SID` | No | — | Twilio SID for SMS |
| `TWILIO_AUTH_TOKEN` | No | — | Twilio auth token |
| `TWILIO_FROM / TWILIO_TO` | No | — | Twilio phone numbers |

### PWA and Security

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAPID_PUBLIC_KEY` | No | — | VAPID public key for web push (base64url) |
| `VAPID_PRIVATE_KEY` | No | — | VAPID private key (never commit) |
| `VAPID_SUBJECT` | No | — | `mailto:` or `https:` URL for push sender identity |
| `WA_RP_NAME` | No | Trading Dashboard | WebAuthn relying party name shown in biometric prompts |
| `SSL_CERT_PATH / SSL_KEY_PATH` | No | — | SSL certificate paths |
| `HTTPS_PORT` | No | 443 | HTTPS port |

---

<a name="chapter-17"></a>
## Chapter 17 — Scheduled Jobs and Cron Timetable

All crons are registered in `src/web/server.js` using `node-cron`. Times are in ET unless noted. Market hours crons only fire Monday–Friday.

### Market Hours (9:30 AM – 4:00 PM ET, Mon–Fri)

| Schedule | Job | Description |
|----------|-----|-------------|
| Every 5 min | `runBotEngineForAllBots()` | Scanner (B-2): builds universe, scores candidates, logs decisions |
| Every 1 min | `runBotExecutorForAllBots()` | Executor (B-3): acts on fresh buy decisions, manages open positions |
| Every 15 min | `runBotReconciler()` | Reconciler: sync bot state with broker reality |
| Every 2 min | UW flow alert ingest | Pull latest options flow into `uw_flow_alerts` |
| Every 5 min | UW top movers ingest | Pull top gainers/losers into `uw_top_movers` |
| Every 1 min | Position guardian | Watch all open positions for stop/target/trail |

### Pre-Market and Post-Market

| Schedule | Job | Description |
|----------|-----|-------------|
| 6 AM ET, Mon–Fri | UW economic + IPO calendar | Pull today's macro events and IPO calendar |
| 8 AM ET, Mon–Fri | `syncTradableUniverse()` | Refresh asset master from Alpaca + Yahoo Finance |
| 8:30 AM ET, Mon | Calibration retrain | Retrain prediction calibration model with week's actuals |
| 8:30 AM ET, Mon–Fri | Conviction snapshot | Score watchlist and portfolio for the day ahead |
| 3 PM ET, Mon–Fri | `runSentinel()` | Pre-close risk scan: 8 signals, email risk briefing |

### Evening and Overnight

| Schedule | Job | Description |
|----------|-----|-------------|
| 4:15 PM ET, Mon–Fri | EOD actuals fill | Fill `actual_price` in `stock_predictions` from Yahoo Finance |
| 4:30 PM ET, Mon–Fri | Calibration retrain | Same as Monday morning, but runs daily after actuals are filled |
| 6 PM ET, Mon–Fri | UW fundamentals warmup | Pre-cache fundamental data for held positions |
| Every 15 min | UW insider trades | Pull Form 4 insider filings |
| Every 1 hr | UW congressional trades | Pull STOCK Act disclosures |
| 2 AM ET | ML pipeline (nightly) | Download prices → compute scores → backtest → train model |

### Weekly and Maintenance

| Schedule | Job | Description |
|----------|-----|-------------|
| 3 AM ET, Mon–Fri | UW retention purge | Delete flow data older than retention period |
| 4 AM ET | UW quota alarm | Alert if daily quota is below safe threshold |
| 7 AM ET | UW schema linter | Validate data quality in UW tables |
| 8 AM ET | UW data quality report | Daily report on ingest health |
| Sat 10 PM ET | ML pipeline (weekly) | Full weekend training run with latest data |
| Sun 6 PM ET | `runSentinel()` | Sunday evening pre-week risk review |

---

<a name="changelog"></a>
## Appendix — Changelog

This section records significant changes to the platform. Update it whenever you add a major feature, change a core behavior, or make an architectural decision that future developers should know about.

---

### 2026-05-21 — Broker-Authoritative Universe + Bots Help

**Dynamic Tradable Universe (B-universe)**
The bot scanner's candidate universe was previously seeded from the user's personal watchlist — a small, manually maintained list that introduced personal bias and missed the broader market. The universe is now sourced from Alpaca's `/v2/assets` endpoint (all active NYSE/NASDAQ equities, typically 4,000–7,000 symbols) and enriched daily by Yahoo Finance with market cap, 30-day average daily volume, price, and sector data. Filters applied: market cap ≥ $5B, ADV ≥ $5M, price $5–$500, fractionable = true, top 800 by ADV.

This change was motivated by the observation that the watchlist-seeded universe was alphabetically biased and missed high-momentum stocks that the system had no prior reason to watch. The new priority pre-ranking system (UW flow +10–15, news +8–12, movers +5, base +1) ensures that catalyst-driven symbols naturally bubble to the top of the scoring queue, regardless of whether they were previously on any watchlist.

Files changed: `src/core/db.js` (new `tradable_universe` table), `src/core/universe-sync.js` (new file), `src/brokers/alpaca.js` (new `getAlpacaAssets()` export), `src/core/bot-engine.js` (replaced `_buildCandidateUniverse()`), `src/web/server.js` (new cron + admin route).

**Bot Help Documentation**
Added a "❓ How it works" button to the Bots page header. Opens a full documentation modal covering the bot system's scanner logic, scoring signals, decision log, executor behavior, and configuration parameters.

**Security fix:** The `/api/admin/universe-sync` route uses `requireAdmin` (not `requireAuth`) — the full universe rebuild is a global operation that should not be triggerable by any authenticated user.

**Scoring cap:** Increased from 30 candidates per scan to 50, to improve signal coverage when the priority pre-ranking surfaces many viable candidates.

---

### 2026-05-20 — Bot System B-2/B-3, Tiger Multi-Env, Sentinel One-Click

Bot scanner (B-2) and executor (B-3) shipped. Tiger multi-environment support added (Live/Demo/Demo API with env switcher in Trading Desk). Sentinel one-click trade links implemented with HMAC-SHA256 signing and price drift protection.

---

*End of document*
