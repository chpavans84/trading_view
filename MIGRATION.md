# Mac-to-Mac Migration Guide

Step-by-step checklist for moving the trading dashboard to a new Mac (e.g., Mac Ultra).
Estimated time: 30–45 minutes.

---

## 1. On the OLD Mac — back up secrets

Copy your `.env` file somewhere safe (AirDrop, iCloud Drive, USB). It contains all credentials.

```bash
cp ~/Documents/Claude_Projects/trading_view/tradingview-mcp/.env ~/Desktop/tradingbot.env
```

Also export the PostgreSQL database:

```bash
pg_dump tradingbot > ~/Desktop/tradingbot_backup.sql
```

---

## 2. On the NEW Mac — install prerequisites

### 2a. Xcode Command Line Tools (required for native modules)

```bash
xcode-select --install
```

Wait for the installer to finish before continuing. This is required for `node-pty`.

### 2b. Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the prompts to add Homebrew to your PATH.

### 2c. Node.js v25 via nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.zshrc          # or ~/.bashrc
nvm install 25
nvm use 25
nvm alias default 25
node --version           # should print v25.x.x
```

### 2d. PostgreSQL

```bash
brew install postgresql@16
brew services start postgresql@16
echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Create the database and user:

```bash
psql postgres -c "CREATE USER postgres WITH SUPERUSER PASSWORD 'change-this-db-password';"
psql postgres -c "CREATE DATABASE tradingbot OWNER postgres;"
```

Use the same password you have in your `.env` → `DB_PASSWORD`.

### 2e. Restore database backup

```bash
psql -U postgres tradingbot < ~/Desktop/tradingbot_backup.sql
```

---

## 3. Clone the project

```bash
git clone https://github.com/chpavans84/trading_view.git \
  ~/Documents/Claude_Projects/trading_view/tradingview-mcp
cd ~/Documents/Claude_Projects/trading_view/tradingview-mcp
```

---

## 4. Copy .env and install dependencies

```bash
cp ~/Desktop/tradingbot.env .env
npm install
```

`npm install` automatically compiles `node-pty` from source (which is why Xcode CLI tools must be installed first). If it fails with a compilation error, run:

```bash
npm rebuild node-pty
```

---

## 5. Install Moomoo OpenD

1. Download OpenD from [moomoo.com/openapi](https://www.moomoo.com/openapi) (same version as before)
2. Install and launch it
3. Log in with your Moomoo account credentials
4. Confirm it's listening: the `.env` default is `MOOMOO_OPEND_HOST=127.0.0.1`, `MOOMOO_OPEND_PORT=11111`

Test connectivity:

```bash
node --env-file=.env -e "import('./src/core/moomoo-tcp.js').then(m => m.getQuote('AAPL').then(console.log))"
```

---

## 6. Install TradingView Desktop (optional — needed for live CDP features)

Download from [tradingview.com](https://www.tradingview.com/desktop/) and install as normal.

To enable Chrome DevTools Protocol (required for chart reading):

```bash
/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222
```

Or use the helper script already in the repo:

```bash
bash scripts/launch_tv_debug_mac.sh
```

---

## 7. Start the dashboard

```bash
npm run dashboard
```

Open `http://localhost:3000` (or whatever `DASHBOARD_PORT` is set to).

---

## 8. Verify everything works

| Check | Command / URL |
|-------|--------------|
| Dashboard loads | `http://localhost:3000` |
| Market data showing | Open Market tab — should show VIX, indices, sectors |
| AI chat responds | Open Chat tab — ask "what is AAPL price?" |
| Moomoo connected | Check server log — no "Moomoo TCP error" messages |
| TradingView connected (if using) | `http://localhost:9222/json/list` — should list TV pages |
| DB working | AI chat history persists across page reloads |

---

## 9. Optional — set up scheduled jobs (cron)

The dashboard auto-runs scans when accessed. If you want background cron jobs (e.g., morning briefing), check the existing Telegram bot setup and re-register any system crontabs:

```bash
crontab -l      # view current crontabs on old Mac first
crontab -e      # recreate on new Mac
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `node-pty` compilation fails | Run `xcode-select --install` first, then `npm rebuild node-pty` |
| `ECONNREFUSED 127.0.0.1:11111` | Start Moomoo OpenD and log in |
| `ECONNREFUSED 5432` | Run `brew services start postgresql@16` |
| Dashboard password rejected | Check `DASHBOARD_PASSWORD` in `.env` matches what you set |
| Chat history blank | DB connection issue — check `DATABASE_URL` in `.env` |
| TradingView tools return `available: false` | Launch TradingView with `--remote-debugging-port=9222` |
| `node: command not found` | Run `nvm use 25` or `source ~/.zshrc` |

---

## Environment Variables Reference

All vars required for full functionality:

| Variable | Required | Where to get it |
|----------|----------|-----------------|
| `ANTHROPIC_API_KEY` | Yes | console.anthropic.com |
| `TELEGRAM_BOT_TOKEN` | Yes | @BotFather on Telegram |
| `TELEGRAM_CHAT_ID` | Yes | @userinfobot on Telegram |
| `DATABASE_URL` | Yes | matches your PostgreSQL setup |
| `DB_PASSWORD` | Yes | same password as in DATABASE_URL |
| `DASHBOARD_PASSWORD` | Yes | choose any password |
| `SESSION_SECRET` | Yes | `openssl rand -hex 32` |
| `MOOMOO_OPEND_HOST` | Yes | `127.0.0.1` if OpenD is local |
| `MOOMOO_OPEND_PORT` | Yes | `11111` (OpenD default) |
| `MOOMOO_TRADE_ENV` | Yes | `SIMULATE` or `REAL` |
| `MOOMOO_TRADE_PASSWORD` | Yes | 6-digit Moomoo trading PIN |
| `RESEND_API` | Optional | resend.com (for email alerts) |
| `RESEND_FROM` | Optional | verified sender domain on Resend |
| `OLLAMA_URL` | Optional | `http://localhost:11434` if running Ollama locally |
| `OLLAMA_MODEL` | Optional | `llama3.1:8b` or any pulled model |
| `DASHBOARD_PORT` | Optional | default `3000` |
