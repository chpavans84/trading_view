# AI Trading Bot

An autonomous trading system that monitors market news, earnings results, and sentiment to execute trades automatically. Built on top of TradingView Desktop integration with a Telegram-based AI analyst powered by Claude.

---

## What It Does

- **Reads earnings data** from SEC EDGAR and Nasdaq — no paid data feed needed
- **Analyses market sentiment** using VIX, sector ETF rotation, and trending stocks
- **Monitors news** from Yahoo Finance for geopolitical and macro events
- **Connects to your Moomoo portfolio** to read positions and P&L
- **Executes trades automatically** via Alpaca with stop loss and take profit built in
- **Sends alerts and analysis** to your Telegram — interactive AI analyst available 24/7

---

## Architecture

```
Telegram (you) ←→ Claude AI Brain ←→ Live Market Data
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
- Automatic morning briefing at 9 AM ET (Mon–Fri)
- Hourly auto-scan during market hours (10 AM–3 PM ET)
- Trade notifications: entry price, stop loss, take profit
- Commands: `/calendar`, `/watchlist`, `/scan`, `/earnings`, `/news`, `/financials`, `/stats`

### Claude AI (Anthropic)
- Brain of the system — reasons about news, earnings, and sentiment
- Connects geopolitical events to specific stocks and sectors
- Proposes and executes trades when high-conviction setups are found
- Remembers conversation context across messages
- Model: Claude Haiku (fast, cheap — ~$0.001 per message)

### Alpaca (Trade Execution)
- Paper trading by default — $100,000 virtual account for testing
- Bracket orders: entry + stop loss + take profit placed simultaneously
- Default parameters: **-3% stop loss, +7% take profit, $200 per trade**
- Max 3 open positions at once
- Switch to live trading by changing one URL in `.env`

### Moomoo (Portfolio Reading)
- Connects via Futu OpenD TCP API (local port 11111)
- Reads real account positions, P&L, and buying power
- Supports US stocks market (margin account)
- Requires OpenD API access enabled in Moomoo app

### SEC EDGAR (Earnings & Financials)
- Free, authoritative financial data — same source as Bloomberg
- EPS history (last 4 quarters), revenue, net income, profit margins
- YoY revenue growth calculation
- No API key required

### Nasdaq Earnings Calendar
- Daily earnings calendar — all companies reporting on any given date
- EPS estimates, last year's EPS, call time (BMO/AMC)
- No API key required

### Yahoo Finance
- Real-time news headlines per ticker
- VIX, S&P 500, Nasdaq, Dow Jones, ES/NQ futures
- Sector ETF performance (XLK, XLF, XLE, etc.)
- Trending stocks
- No API key required

### TradingView Desktop (via Chrome DevTools Protocol)
- Read live chart state: symbol, timeframe, indicators
- Read Pine Script indicator output (lines, labels, tables, boxes)
- Control chart: change symbol, timeframe, add/remove indicators
- Take screenshots, manage alerts, control replay mode

---

## Trade Logic

### Entry Signal (all must be true)
1. Market is open
2. Fewer than 3 open positions
3. VIX < 30 (not extreme fear)
4. One of:
   - Earnings beat: actual EPS > estimate by >3%
   - Strong sector rotation into the stock's sector
   - Positive news catalyst with revenue growth trend

### Exit (automatic, set at order time)
- **Stop loss: -3%** below entry price
- **Take profit: +7%** above entry price
- Early exit: `/close_SYMBOL` command in Telegram

### Risk per trade
- $200 per trade (paper trading default)
- Max loss per trade: $6 (3% of $200)
- Max gain per trade: $14 (7% of $200)
- Risk/reward ratio: 1:2.3

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

| Service | Where to get it | Cost |
|---|---|---|
| Telegram Bot Token | @BotFather on Telegram | Free |
| Anthropic API Key | console.anthropic.com | ~$0.001/message |
| Alpaca API Key | alpaca.markets | Free (paper), $0 commission (live) |
| Moomoo OpenD | Moomoo app → Me → Settings → Open API | Free |

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
- **9:00 AM ET** — Morning briefing: today's earnings + watchlist scan
- **10 AM–3 PM ET (hourly)** — Auto-scan for trade setups, executes if conviction is high

### Interactive (Telegram chat)
Just type naturally:

```
"What's the impact of the US-China trade war on semiconductors?"
"Should I buy MRVL before earnings?"
"What defense stocks benefit from current geopolitical tensions?"
"Scan my watchlist for this week"
"What's the market sentiment today?"
"Show my portfolio"
```

### Commands
```
/calendar            — today's full earnings calendar
/calendar 2026-05-01 — earnings on a specific date
/watchlist           — scan all 20 watchlist stocks (30-day window)
/scan AAPL NVDA      — scan specific tickers
/earnings MRVL       — last 4 quarters EPS + revenue
/news TSLA           — latest headlines
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
│   ├── news.js            # SEC EDGAR, Nasdaq, Yahoo Finance data
│   ├── sentiment.js       # VIX, sectors, trending stocks
│   ├── trader.js          # Alpaca trade execution engine
│   ├── moomoo-tcp.js      # Moomoo OpenD TCP client
│   └── moomoo.js          # Moomoo high-level API
├── tools/                 # MCP tool registrations (for Claude Code)
│   ├── news.js
│   ├── moomoo.js
│   └── analysis.js
├── cli/                   # CLI commands (tv news earnings --symbol MRVL)
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

- [ ] Post-earnings 8-K auto-detection (buy signal within minutes of filing)
- [ ] EPS surprise scoring (actual vs estimate comparison)
- [ ] Moomoo live trade execution (once OpenD API access enabled)
- [ ] Backtesting engine for strategy validation
- [ ] Web dashboard for trade history and performance metrics
