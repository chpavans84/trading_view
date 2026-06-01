# 🔎 Screener — Morning notes for Pavan

Built overnight 2026-05-25, 22:44 → 23:35 ET (51 min). Two passes — first a Finviz clone, then upgraded with our edge data.

## What's actually special about it

This isn't a Finviz clone. **It surfaces signals Finviz can't see**, because we have data Finviz doesn't:

- 🐋 **UW options flow** ≥ $200K / $1M premium (last 7d, bullish)
- 👤 **Insider trades** net buying ≥ $250K / $1M (last 30d, from SEC Form 4 via UW)
- 🏛️ **Congressional trades** (last 90d, STOCK Act disclosures)
- 🐂 **Bot conviction grade A/B** (our scoring engine's verdict)
- 🚀 **Near 52w high** (within -3%)
- 📉 **Mean reversion** (RSI<30 + above 200-day MA → dip in confirmed uptrend)
- ⚡ **Volume spike** (day +5% on RVOL ≥ 1.5×)

Each row carries a **signal_score** (sum of weighted bullish signals). Rows with **score ≥ 50 get a green tint**, score ≥ 25 get amber. **Default sort is by signal_score desc** — most-interesting names bubble to the top.

## Live results right now

Top of the **🔥 Hot setups** preset (signal_score ≥ 30):

| Symbol | Score | Signals |
|---|---:|---|
| ABNB | 65 | 👤 insider_xl + 🐋 flow + 🏛️ congress |
| EOSE | 65 | 👤 insider + 🐋 flow + 🐂 grade_a |
| DRVN | 60 | 🐋 flow_xl + 🐂 grade_a + 🚀 52w_hi |
| IBM  | 60 | 🐋 flow_xl + 🏛️ congress + 🐂 grade_a |
| NBIS | 60 | 🐋 flow_xl + 🐂 grade_a + 🚀 52w_hi |
| SE   | 60 | 🐋 flow_xl + 🐂 grade_a + 🚀 52w_hi |
| VIK  | 60 | 🐋 flow + 🏛️ congress + 🐂 grade_a + 🚀 52w_hi |

132 names total qualify for "Hot setups." That's your real watchlist.

## What the screener has

### Smart-setup presets (use OUR edge)
- 🔥 **Hot setups** — composite score ≥ 30 (multi-signal stacks)
- 👤 **Insider $1M+** — insiders bought ≥$1M last 30d
- 👤 **Insider buys** — insiders bought ≥$250K last 30d
- 🐋 **Smart money $1M+** — bullish UW flow ≥$1M premium last 7d
- 🐋 **Smart money** — bullish UW flow ≥$200K
- 🏛️ **Congress active** — congressional trade last 90d
- 🐂 **Bot grade A** — conviction grade A names only
- 📉 **Mean reversion** — RSI<30 + above 200 SMA (dip in uptrend)
- ⚡ **Volume spike** — day +5% on RVOL ≥1.5×

### Classic presets (Finviz parity)
Mega/Large/Mid/Small caps · Oversold · Overbought · Near 52w hi · Golden cross · Momentum 30d · Value · High growth · ↺ Reset

### Filters
- Search (ticker or company name)
- Sector / Industry / Exchange dropdowns (populated from data, with counts)
- Numeric ranges (min+max for): Market cap ($B), Price, Day %, P/E, RSI, % from 52w high, 1mo return, Min div yield

### Table columns (toggle via ⚙ Columns)
**Default visible**: Symbol · Signals · 30d sparkline · Company · Sector · Mkt Cap · Price · Day % · Volume · RSI · %52w hi · 1mo · 3mo · YTD

**Available to enable**: P/E · EPS · Div % · Beta · Grade · Insider Net · Flow Premium · RVOL

Click any sortable column header to sort. Symbol column sticks while you scroll right in Compact mode.

### Power user
- **💾 Save** — name your current filter set, persists in localStorage
- **📋 Saved screens** dropdown — load a saved screen with one click
- **⚙ Columns** — toggle which columns show (persists)
- **📏 Compact / 📐 Comfy** density toggle (persists)
- **📥 CSV** — export current filter result to CSV

## Data layer

| Source | Where | Refreshed |
|---|---|---|
| Universe (8,333 tickers) | `tradable_universe` (Alpaca) | 8:00 AM ET weekdays |
| Sectors + industry + name (5,740) | Yahoo `assetProfile` | 1st of month 7 AM ET |
| Fundamentals — P/E, EPS, yield, beta (3,636 PE, 3,863 beta) | Yahoo modules | Sundays 8 AM ET |
| EOD snapshot — price, mcap, day chg, volume, 52w | Yahoo `quote` batch | 6:00 PM ET daily |
| Technicals — RSI, SMA, returns (2,996) | computed from `backtest_prices` | 6:30 PM ET daily |
| **Signals** — sparklines + tags + scores | DB query over UW + conviction tables | **6:45 PM ET daily** |

## Crons registered
- `0 18 * * 1-5` — Daily snapshot
- `30 18 * * 1-5` — Daily technicals  
- `45 18 * * 1-5` — Daily signals (NEW)
- `0 8 * * 0`    — Weekly fundamentals
- `0 7 1 * *`    — Monthly sectors

All gated to prod only.

## Manual commands
```bash
npm run screener:snapshot     # ~30s
npm run screener:technicals   # ~10s
npm run screener:signals      # ~5s (sparklines + tags from DB)
npm run screener:fundamentals # ~5min
npm run screener:sectors      # ~6min
npm run screener:prices       # ~12min (extends price coverage)
npm run screener:all          # sequential
```

## Files changed (uncommitted)
- `src/web/server.js` — `/api/screener` + `/api/screener/meta` endpoints; 11 smart-setup presets; 6 new filters; 4 new sortable cols; 5 crons
- `src/web/public/index.html` — Screener tab; ~600 lines of JS (column system, signal chips, sparklines, saved screens, density toggle, presets)
- `src/web/public/css/dashboard.css` — screener styles + signal chips + sparkline + hot-row highlights + column drawer + density modes (v40)
- `src/core/db.js` — 19 + 12 = 31 new columns on `tradable_universe`, new `screener_technicals` table
- `src/research/screener-backfill.js` — **NEW**, 6-mode backfill script
- `package.json` — 7 new screener:* npm scripts
- `SCREENER_MORNING_NOTES.md` — this file

## Current DB sizes
| Table | Rows | Size |
|---|---:|---:|
| `tradable_universe` | 8,333 | 5.0 MB |
| `backtest_prices` | ~970K | 216 MB |
| `screener_technicals` | 2,996 | 1 MB |

## Things I considered but skipped (low ROI)
- **Real-time prices via WebSocket** — wait until you've used it for a few days and decide if EOD is enough.
- **Saved-screens-shared-with-team** — needs DB table. localStorage is enough for solo.
- **Per-cell tooltips with the source data** — kept it clean; the chip title attribute handles the hover hint already.
- **"Sympathy" filter** — find peers of a symbol from Neo4j graph. Cool idea, separate feature.

## Known minor stuff
- yahoo-finance2 version warning `3.14.0 < 3.14.1` — harmless; bump with `npm install yahoo-finance2@latest` when convenient.
- Smart presets clear existing input fields when applied (by design). Hit ↺ Reset to clear the preset and edit filters fresh.
- Hot-setup row highlighting is subtle (left-side gradient) so it doesn't look gimmicky.

— Claude
