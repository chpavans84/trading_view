# AI Trading Bot

An autonomous trading system that monitors market news, earnings results, and sentiment to execute trades automatically. Built on top of TradingView Desktop integration with a Telegram-based AI analyst powered by Claude.

---

## What It Does

- **Reads earnings data** from SEC EDGAR and Nasdaq — no paid data feed needed
- **Analyses market sentiment** using VIX, sector ETF rotation, and trending stocks
- **Monitors news** from Alpaca (real-time) and Yahoo Finance — merged, most recent first
- **Scores every trade** using a multi-factor conviction engine before executing
- **Sizes stops dynamically** using ATR-14 — adapts to each stock's volatility
- **Connects to your Moomoo portfolio** to read positions and P&L
- **Executes trades automatically** via Alpaca with ATR-based stop loss and take profit
- **Sends alerts and analysis** to your Telegram — interactive AI analyst available 24/7

---

## Architecture

```
Telegram (you) ←→ Claude AI Brain ←→ Live Market Data
                        ↓
              Conviction Scoring Engine
              (earnings + drift + RS + insider)
                        ↓
              Alpaca Trading Engine
                (paper / live)
                        ↓
              Moomoo Portfolio Reader
                (OpenD TCP API)
```

---

## Integrations

### Telegram Bot
- Interactive AI analyst — ask anything in plain English
- Automatic morning briefing at 9 AM ET / 9 PM SGT (Mon–Fri)
- Hourly auto-scan during market hours (10 AM–3 PM ET / 10 PM–3 AM SGT)
- Trade notifications with entry price, ATR-sized stop loss, take profit, and SGT timestamp
- Commands: `/calendar`, `/watchlist`, `/scan`, `/earnings`, `/news`, `/financials`, `/stats`

### Claude AI (Anthropic)
- Brain of the system — reasons about news, earnings, and sentiment
- Connects geopolitical events to specific stocks and sectors
- Runs conviction scoring before every trade — only executes grade B or higher
- Remembers conversation context across messages
- Model: Claude Haiku (fast, cheap — ~$0.001 per message)

### Conviction Scoring Engine (`src/core/scoring.js`)
Every trade candidate is scored 0–100 before execution:

| Factor | Points |
|---|---|
| 3+ consecutive quarters of EPS growth | +25 |
| EPS AND revenue both grew YoY (strong quality) | +20 |
| "Raises guidance" in recent news | +15 |
| Stock drifting up in last 5 days | +15 |
| Outperforming its sector ETF (5-day RS) | +15 |
| 2+ insider Form 4 filings in 60 days | +10 |
| VIX > 25 | −20 |
| "Lowers guidance" in recent news | −15 |
| Opening volatility / lunch chop window | −10 |
| Stock lagging sector ETF | −10 |
| Stock drifting down | −10 |

- **Score < 60** → skip, explain why
- **Score 60–79 (grade B/C)** → trade $200
- **Score ≥ 80 (grade A)** → trade $400

### Alpaca (Trade Execution + News)
- Paper trading by default — $100,000 virtual account for testing
- Bracket orders: entry + stop loss + take profit placed simultaneously
- **ATR-14 dynamic sizing**: stop = 1.5× ATR%, target = 3× ATR% (adapts to volatility)
- Max 3 open positions at once
- **News API**: ~1-2 minute latency via Benzinga feed (much faster than Yahoo)
- Switch to live trading by changing one URL in `.env`

### News Sources (merged, most recent first)
| Source | Latency | Used for |
|---|---|---|
| Alpaca / Benzinga | ~1-2 min | Primary — real-time headlines |
| Yahoo Finance | 15-30 min | Fallback + fills gaps |

Both sources are fetched in parallel. Results are deduplicated and sorted newest first.

### Moomoo (Portfolio Reading)
- Connects via Futu OpenD TCP API (local port 11111)
- Reads real account positions, P&L, and buying power
- Supports US stocks market (margin account)
- Requires OpenD API access enabled in Moomoo app

### SEC EDGAR (Earnings & Financials)
- Free, authoritative financial data — same source as Bloomberg
- EPS history (last 8 quarters), revenue, net income, profit margins
- YoY earnings quality scoring (strong / moderate / weak) per quarter
- Insider activity via Form 4 filing count (60-day window)
- No API key required

### Nasdaq Earnings Calendar
- Daily earnings calendar — all companies reporting on any given date
- EPS estimates, last year's EPS, call time (BMO/AMC)
- Used for upcoming earnings date + forward EPS estimate in surprise scoring
- No API key required

### Yahoo Finance
- VIX, S&P 500, Nasdaq, Dow Jones, ES/NQ futures
- Sector ETF performance (XLK, XLF, XLE, etc.) with rotation signal
- 5-day relative strength vs sector ETF per stock
- Pre-earnings price drift (5-day momentum)
- Trending stocks
- No API key required

### TradingView Desktop (via Chrome DevTools Protocol)
- Read live chart state: symbol, timeframe, indicators
- Read Pine Script indicator output (lines, labels, tables, boxes)
- Control chart: change symbol, timeframe, add/remove indicators
- Take screenshots, manage alerts, control replay mode

---

## Trade Logic

### Entry Signal
1. Market is open
2. Fewer than 3 open positions
3. VIX < 30 (not extreme fear)
4. Not in opening volatility (9:30–10:00 AM ET) or lunch chop (12–2 PM ET)
5. **Conviction score ≥ 60** across: earnings quality, pre-earnings drift, relative strength, insider activity, news sentiment

### Stop Loss & Take Profit (ATR-based, automatic)
- Calculated from 14-day Average True Range of the stock
- Stop loss = 1.5 × ATR% (min 1.5%, max 8%)
- Take profit = 3.0 × ATR% (min 3%, max 20%)
- Low-volatility stock example: ATR 1.5% → stop −2.25%, target +4.5%
- High-volatility stock example: ATR 4% → stop −6%, target +12%

### Early exit
- `/close_SYMBOL` command in Telegram closes position immediately

### Risk per trade
- $200 per trade (conviction B) or $400 (conviction A)
- Risk/reward ratio always ~1:2 (enforced by ATR sizing)

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Create `.env` file
```env
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_CHAT_ID=your_chat_id
ANTHROPIC_API_KEY=sk-ant-...
ALPACA_API_KEY=PK...
ALPACA_SECRET_KEY=...
ALPACA_BASE_URL=https://paper-api.alpaca.markets
```

### 3. Get API keys

#### Telegram (free — 5 minutes)

**Step 1 — Create your bot and get the token:**
1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a name (e.g. `My Trading Bot`)
4. Choose a username ending in `bot` (e.g. `mytradingbot`)
5. BotFather replies with your token — looks like:
   ```
   8782535341:AAGDfhpl7FBXfLEHmmoECCvBHeHncUIYfCk
   ```
6. Copy this into `TELEGRAM_BOT_TOKEN` in your `.env`

**Step 2 — Get your Chat ID:**
1. Search for **@userinfobot** on Telegram
2. Send `/start`
3. It replies with your user ID — looks like `8341283742`
4. Copy this into `TELEGRAM_CHAT_ID` in your `.env`

> The Chat ID tells the bot which account to send alerts to. Only messages from this ID will be accepted.

---

#### Anthropic / Claude AI (~$0.001 per message)
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up and add $5 credit (enough for thousands of messages)
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-`) into `ANTHROPIC_API_KEY`

---

#### Alpaca — Paper Trading (free, no real money)
1. Go to [alpaca.markets](https://alpaca.markets) and create a free account
2. In the dashboard, go to **Paper Trading** (top-left toggle)
3. Click **API Keys** → **Generate New Key**
4. Copy the API Key (`PK...`) into `ALPACA_API_KEY`
5. Copy the Secret Key into `ALPACA_SECRET_KEY`
6. Leave `ALPACA_BASE_URL=https://paper-api.alpaca.markets` as-is for paper trading

> To switch to live trading later, generate Live API keys and change the URL to `https://api.alpaca.markets`

---

| Service | Cost |
|---|---|
| Telegram Bot | Free |
| Anthropic API | ~$0.001/message (Claude Haiku) |
| Alpaca Paper Trading | Free, $100K virtual account |
| Alpaca Live Trading | Free account, $0 commission |
| Alpaca News API | Free with Alpaca account |
| All other market data (SEC, Nasdaq, Yahoo) | Free, no API key needed |

### 4. Start the AI bot
```bash
npm run bot:ai
```

### 5. Start the MCP server (for TradingView integration)
```bash
npm start
```

---

## Usage

### Automated (no input needed)
The bot runs on its own schedule:
- **9:00 AM ET (9:00 PM SGT)** — Morning briefing: today's earnings + watchlist scan
- **10 AM–3 PM ET (10 PM–3 AM SGT), hourly** — Auto-scan: scores candidates, executes if conviction ≥ 60

### Interactive (Telegram chat)
Just type naturally:

```
"What's the impact of the US-China trade war on semiconductors?"
"Should I buy MRVL before earnings?"
"What defense stocks benefit from current geopolitical tensions?"
"Scan my watchlist for this week"
"What's the market sentiment today?"
"Show my portfolio"
"What's the conviction score for NVDA?"
```

### Commands
```
/calendar            — today's full earnings calendar
/calendar 2026-05-01 — earnings on a specific date
/watchlist           — scan all 20 watchlist stocks
/scan AAPL NVDA      — scan specific tickers
/earnings MRVL       — last 4 quarters EPS + revenue + quality score
/news TSLA           — latest headlines (Alpaca + Yahoo merged)
/financials NVDA     — income statement
/stats               — API usage and cost dashboard
/close_SYMBOL        — exit a position early
/clear               — reset conversation history
```

---

## Watchlist (default)

`MRVL NVDA AMD AAPL MSFT GOOGL META AMZN TSLA NFLX INTC QCOM MU AVGO TSM SMCI RTX LMT XOM JPM`

Edit `DEFAULT_WATCHLIST` in `src/bot/telegram-ai.js` to customise.

---

## Project Structure

```
src/
├── bot/
│   ├── telegram-ai.js     # AI analyst bot (Claude + Telegram + Alpaca)
│   └── telegram.js        # Basic data bot (no AI)
├── core/
│   ├── news.js            # SEC EDGAR, Nasdaq, Alpaca + Yahoo news
│   ├── sentiment.js       # VIX, sectors, relative strength, trending stocks
│   ├── trader.js          # Alpaca trade execution + ATR sizing + time filter
│   ├── scoring.js         # Multi-factor conviction scoring engine
│   ├── moomoo-tcp.js      # Moomoo OpenD TCP client
│   └── moomoo.js          # Moomoo high-level API
├── tools/                 # MCP tool registrations (for Claude Code)
│   ├── news.js
│   ├── moomoo.js
│   └── analysis.js
├── cli/                   # CLI commands
│   └── commands/
│       ├── news.js
│       └── moomoo.js
└── server.js              # MCP server entry point
```

---

## Switching to Live Trading

1. Fund your Alpaca account at alpaca.markets
2. Generate Live API keys (separate from paper keys)
3. Update `.env`:
   ```env
   ALPACA_API_KEY=your_live_key
   ALPACA_SECRET_KEY=your_live_secret
   ALPACA_BASE_URL=https://api.alpaca.markets
   ```
4. Restart the bot — everything else is identical

---

## Important Notes

- **Paper trading by default** — no real money at risk during testing
- **PDT Rule**: US accounts under $25K are limited to 3 day trades per 5 business days
- **Moomoo OpenD** must be running locally on port 11111 for portfolio reading
- **TradingView Desktop** must be running with `--remote-debugging-port=9222` for chart tools
- This is an experimental personal project — not financial advice

---

## Roadmap

- [ ] Moomoo OpenD API access for Margin Account (enable in app or call 1-888-782-1299)
- [ ] Moomoo live trade execution once OpenD enabled
- [ ] Moomoo real-time news via OpenD quote API
- [ ] Post-earnings 8-K auto-detection (buy signal within minutes of SEC filing)
- [ ] Backtesting engine for strategy validation
- [ ] Cloud deployment (DigitalOcean) — remove dependency on Mac staying on
- [ ] Web dashboard for trade history and performance metrics
