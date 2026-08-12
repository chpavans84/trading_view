# GOTCHAS — read this FIRST (high-signal, low-noise)

Invariants + every past mistake, so none recurs. Keep this SHORT. When a new bug is found:
add a one-line entry here **and** a regression test. A mistake should only be possible once.

## Deploy / ops discipline (financial system — be careful)
- **NEVER `pm2 restart` without explicit go-ahead.** Code can land on disk; deploy is separate.
- **NEVER `pkill`.** Use `pm2 restart trading-dashboard trading-staging` (3 procs: bot + dashboard + staging).
- After editing `.env`: `pm2 restart <app> --update-env` (plain restart won't re-read env).
- Bootstrap files (sw.js etc.) MUST send no-cache headers — Cloudflare caches 24h (burned us 2026-05-21).

## Web security
- **App shells are auth-gated server-side** (added 2026-06-11): `/`, `/index.html`, `/mobile.html`,
  `/mobile-v1.html` → 302 `/login.html` unless `req.session.authenticated`. Before: the full 1.6MB
  dashboard (all logic/endpoints inline) shipped pre-login; index.html only bounced client-side after
  download. Gate lives in server.js right after the mobile redirect, BEFORE express.static. Keep
  login/register/terms/sw.js/manifest/css/icons public (login page + PWA need them). Regression tests
  in registry-contract.test.js ("pre-auth shell gate"). Don't add new HTML shells without gating them.
- **yahoo-finance2 spams `console.error(url)`** (with the crumb token!) on every non-OK response —
  server.js wraps console.error at boot to drop bare query1/query2.finance.yahoo.com URL lines (the lib
  also throws; callers log real errors). If Yahoo debugging is ever needed, comment out the filter.

## Code-change discipline
- **Read before edit. One file at a time.** Don't guess code state; grep before removing CSS/JS.
- Stay in request scope. No speculative "while I'm here" fixes. No faith-based changes — backtest before ship.
- **New tab/widget → add it to `src/web/registry.js`** (single source of truth: ALL_TABS / ALL_WIDGETS /
  DEFAULT_PERMISSIONS + ENDPOINT_CONTRACTS). server.js imports these; the contract test walks them.
  Don't redeclare permission lists anywhere else. Run `npm run test:contract` after dashboard changes.
- Never silently drop user-visible rows to "clean up" — enrich/soft-delete/ask instead (sell-rows-vanished bug).

## State correctness (the "how can I sell?" class — DB is NOT authoritative)
- **`sentiment.js market_status` is a DISPLAY STRING** ('🟢 Market OPEN' / '🟡 Pre-market' / '🔴 After
  hours' / 'Market closed (weekend)') — never a bare enum. Compare with `.includes('OPEN')`, NOT
  `=== 'open'`. The Home pill did the latter and showed MARKET CLOSED 24/7 from 2026-05-25 to
  2026-06-12 before anyone noticed. If a status compare looks exact-match, check what the API really returns.
- **Cross-check the BROKER for any position / cash / P&L assertion** (Alpaca /v2/positions, Tiger, Moomoo).
  Phantom-position bug: DB said 5 open, broker said 0 → bot paralyzed.
- **Cross-check `NOW()` for any date/time assertion.** Wrong-"today" bug shipped once.
- Earnings/market-hours: half-days & off-by-one (entry vs exit) have bitten — verify against calendar.
- **An account-wide liquidation MUST be strategy-scoped.** `eodFlatten` (3:50 PM ET, `server.js`) closed
  EVERY Alpaca position with no bot/strategy filter — so it liquidated bot 4's `insider_director_cluster`
  20-DAY swing hold the same afternoon it opened, every day (FISV: bought 09:31 ET, sold 15:50 ET, 15
  round-trips, −$19.81; 141 round-trips account-wide = −$293.86 since 2026-06-20). It killed the ONLY
  strategy with a proven edge and nobody saw it because the flatten closed at the BROKER without writing
  to Postgres → the row was swept up as a phantom and booked at entry price = **$0.00 P&L**, so the DB
  ledger looked flat while the account bled. Fixed 2026-07-14 → `src/core/eod-flatten.js`: positions
  backing an open `bot_advance_trades` row with `time_stop_days >= 2` are PROTECTED; fails CLOSED (DB
  down ⇒ flatten nothing rather than risk liquidating a swing hold). Tests: `tests/eod-flatten.test.js`.
  ⚠️ Same unscoped pattern still lives in the VIX circuit breaker (`server.js` `runPositionMonitor`) —
  it is a deliberate catastrophic backstop, but it does not know a swing hold from a day trade.
- **Every scheduled job must be gated on `BOT_CRON_OWNER`.** `eodFlatten` was a bare module-scope
  `setInterval` with no gate, so `trading-staging` registered it too and could double-fire on the same
  Alpaca account. If you add a `setInterval`/`cron.schedule` that touches the broker or DB, gate it.

## Bot-advance exits + mark-to-market (2026-08-12)
- **`trail_pct: 0` did NOT disable the trailing stop — it made it maximally tight.** The exit used
  `currentPnl < peakPnl * (1 - trailFraction)`; with `trailFraction=0` that is `currentPnl < peakPnl`,
  so it exited on ANY tick below peak. The insider rule sets trail_pct:0 meaning "hold to the 20-day
  time stop" — instead ARTV/ENR/NTSK churned daily (sell 09:31 open / rebuy 13:41), the swing thesis
  never developed, real Alpaca went slightly negative. Fix: `decideMechanicalExit` treats
  `trailFraction <= 0` as NO trail (only hard_stop + time_stop apply). Tests: bot-advance-trail-disable.
- **Exit P&L was booked off the ASK quote, not the real fill — fabricating phantom wins.** The exit
  fell back to `px = getLatestPrice().ask`; on thin small-caps the IEX ask sits far above where a
  market SELL fills (ARTV booked at $12.32 ask vs $10.74 real fill → +$185 phantom). DB read +$2,721
  while the broker was −$173. Fix: poll the actual fill (`pollOrderFill` — closePosition now returns
  `order_id`); estimate at the BID only if polling fails, never the ask.
- **IEX single-exchange quotes on thin names are frequently BROKEN** (a 0 leg → corrupted mid; e.g.
  PFE ask=0 → getLatestPrice mid=$12.78 for a $25 stock; 30-37% spreads). Never value a long off the
  raw mid. `_saneQuotePrice`: both legs valid → mid, unless spread >25% → bid; one leg → that leg;
  none → null (last-close fallback). Mark-to-market (`_getLivePrice`) now uses it; ALWAYS reconcile
  bot P&L against the broker (this is the DB-is-not-authoritative class again — DB overstated by ~$2.9k).

## Bot candidate universe — index filter vs the insider edge (2026-07-24)
- **The S&P500/NDX100 `index_only` filter kneecaps the insider strategy — its edge lives OFF-index.**
  Bot 4 (`insider_director_cluster` only) went 7 days with ZERO picks: the rule found 8-9 valid
  cluster-buys every scan but `_index_filter` dropped all of them (`8 → 0 (S&P500/NDX100 only)`).
  Backtest (2026-07-24, survivorship-free, 226 signals, 20d hold): off-index insider signals
  **+11.4% excess vs SPY** (60% win) vs index-only **−1.0% excess** (n=13 in 2.5y — the filter left
  the bot almost nothing to trade). The filter was added 2026-06-19 to exclude junk micro-caps/funds,
  but it also excludes the exact mid/small caps where the edge is.
- **Fix = liquidity+quality gate, NOT naive filter removal.** `entry-rules.js` `applyQualityGate` /
  `classifyForGate`: exclude funds/CEFs/BDCs (`industry ~ 'Asset Management'` — asset_class is 100%
  NULL so it's useless), sub-$min_price names, and <$min_adv_usd trailing-ADV names. Backtested PASS
  bucket = **+11.0% excess / 70% win / 57% excess-win** (edge preserved, hit-rate improved); the
  excluded buckets (funds +2%, illiquid −0.5%) are weak. Config: `rules.universe.quality_gate=true`
  + `index_only=false` (defaults: min_price 5, min_adv_usd 3M, exclude ['Asset Management']).
  Tests: `tests/insider-quality-gate.test.js`.
- **`index_only=false` is UNSAFE on old code.** Old engine.js reads `index_only` but not
  `quality_gate`, so `index_only=false` alone = NO filter = buys funds/micro-caps. DEPLOY ORDER:
  pm2 restart with the new code FIRST (bot stays safe on default index_only ON), THEN flip
  `rules.universe` config. Never set index_only=false before the quality-gate code is live.
- Missing price/ADV in tradable_universe → `classifyForGate` DROPS the name (fail-closed on
  liquidity), but the reason is logged in the decision breakdown (`_quality_dropped`), never silent.
  A legit name with stale/NULL ADV (e.g. HDSN) self-heals when the 06:00 universe sync repopulates it.

## Vendor / fallback discipline (Benzinga retired 2026-07-14)
- **A fetch wrapper guarded by `.catch(() => fallback)` MUST THROW on failure — never `return null`.**
  A resolved `null` FULFILS the promise, so the `.catch()` is skipped and the fallback never runs.
  `scoring.js` `getBenzingaNews` did `if (!r.ok) return null`, and `getBenzingaEarnings` swallowed
  errors in an internal `allSettled` and still returned a non-null object. When the Benzinga sub was
  cancelled (HTTP 401) that silently zeroed `beat_streak` (+25) and guidance (+15) on EVERY scored
  symbol, with the working Yahoo fallback sitting one line away, unreachable. Scores were SKEWED
  DOWN, not merely uninformed. Fixed + guarded by `tests/benzinga-retirement.test.js`.
  (Note: `getRVOL`/`getWeeklyTrend` DO correctly `return null` — they have no fallback chain.)
- **When you swap a data source, check the FIELD NAMES and the SEMANTICS, not just the shape.**
  Benzinga `beat_streak` = quarters beating the ANALYST ESTIMATE. The EDGAR fallback silently
  redefined it as YoY EPS GROWTH — a different signal on the same +25 weight. And Benzinga returns
  `next_earnings_date` while the fallback returns `earnings_date`, so `isEarningsPlay` went
  permanently false. Earnings-surprise is now Yahoo-primary (`getEarningsSurpriseYahoo`), which
  restores beat-vs-estimate semantics and needs no CIK.
- **`www.sec.gov` rate-limits by IP (429 "Request Rate Threshold Exceeded"); `data.sec.gov` and
  `efts.sec.gov` do not.** `getCIK()` re-fetched the 1 MB `company_tickers.json` per cold start, so a
  throttled window made it throw → BOTH earnings factors zeroed, even though the XBRL data endpoint
  was answering 200. The map is now cached to disk (24 h TTL, stale-on-throttle — CIKs are immutable).
- A RETIRED vendor is not an outage: `health-checks.js` `checkBenzingaNews` reports `ok` when no key
  is configured. A permanent red trains you to ignore the Health tab.

## Data / timezone / shell
- **ET vs UTC:** bars & "business day" partitions use America/New_York. Set session TZ; `window_start`/
  `participant_timestamp` are nanoseconds (`/1e9`).
- **macOS bash is 3.2** — no `declare -A` (assoc arrays), no GNU `timeout`. Write portable shell.
- **BSD `date`: `-v` adjustments MUST come BEFORE `-f`** on Darwin 25 (Mac Studio). `date -j -f %F X -v+1d +%F`
  silently ignores -v AND the output format (worked on the old Intel macOS) → next_day() returned long-format
  → lexical date compares failed → ALL daily pulls (minute/day/trades/news) froze at 2026-06-08 for 3 days,
  saying "up to date". Correct order: `date -j -v+1d -f %Y-%m-%d "$1" +%Y-%m-%d`. After ANY migration/OS
  update, smoke-test date math in cron scripts.
- **Do NOT `source .env` in bash** — `DASHBOARD_PASSWORD` contains a `$`-sequence that `set -u` aborts on.
  Node scripts load `.env` via dotenv themselves; in bash read single vars with `grep|cut`.
- Polygon REST single-object endpoints (ticker details) return one object, not an array — handle both,
  or files write empty `[]` (silent-empty bug). Verify a sample file has content after any backfill.
- A backtick inside a SQL comment inside a JS template literal crashes the file (screener freeze, 6 days).

## DuckDB / lake
- DuckDB reserved words bite as column aliases: **`dec`, `rows`** (and others). Alias as `decile`,
  `n_rows`, etc. — `SELECT count(*) rows` → Parser Error.
- DuckDB is EMBEDDED (no host:port). SQL interface: catalog `/Volumes/Archive/lake.duckdb` (83 views);
  `duckdb <file>` CLI, `duckdb <file> -ui` browser UI, or DBeaver (DuckDB driver must be ≥1.5.x to open
  a 1.5.3 file). SINGLE-WRITER — open read-only for shared/GUI access.
- Cross-source validation: DuckDB `ATTACH 'postgresql://localhost/tradingbot' AS pg (TYPE POSTGRES,
  READ_ONLY)` then join lake views vs `pg.public.*`. See `validation.sql` (OLTP↔lake parity, split
  continuity, survivorship, freshness — all verified).
- Postgres conn (DBeaver): localhost:5432 / db `tradingbot` / user `pavan` / no password (local trust).

## Index constituents
- S&P 500 + NASDAQ-100 membership lives in `index_membership` (symbol, in_sp500, in_ndx100), built by
  `scripts/etl/ingest-index-membership.mjs`: S&P500 from datahub CSV (503), NASDAQ-100 from Wikipedia (~101).
  The old `src/research/sp500.js` lists are STALE/incomplete (361/79) — don't use them for membership.
  Class shares normalize to DOTS here (BRK.B / BF.B, not BRK-B). The screener (`/api/screener/ownership`)
  INNER JOINs this table → restricted to ~516 names. Refresh anytime for reconstitutions (wired daily).

## MCP chat tools (fixed 2026-06-12)
- `benzinga_news_get` queried `conviction_scores.factor_breakdown` — a column that NEVER existed
  (it's `breakdown`, and neither it nor `signals` holds news_* keys). The tool errored on every call
  since it shipped. Now reads the live `benzinga_news` table (per-article sentiment aggregate) +
  `signals->bz_*` enrichment. LESSON: when adding an MCP tool, run it once against real data — a
  tool that never worked looks identical to one that "rarely has data".
- `chart_set_symbol`/`quote_get` returned a UNISWAP token for "NVDA": bare tickers resolve
  ambiguously in TradingView AND the user's chart can be parked on anything. Fix: tools/chart.js
  `resolveEquitySymbol()` pins bare 1-5 letter tickers found in tradable_universe to NASDAQ:/NYSE:.
  ETFs (ARCA/BATS), futures (ES1!), prefixed and crypto symbols pass through untouched.

## Data sources
- **`backtest_prices.volume` IEX-contamination — FIXED 2026-06-19.** History: the 5 PM `refresh-prices`
  cron (`src/research/refresh-prices.js`) wrote volume from Alpaca's free **IEX** feed (`feed=iex`) ≈ **3%
  of consolidated** (NVDA ~5M vs real ~150M, ~30× low for recent days). This 30×-deflated the bot's ADV /
  rvol (`getLiquidityProfile` in `bot-indicators.js`, `bot-setup-classifier.js`) and wrongly tripped the
  ≥$5M liquidity gate. FIX (two parts): (1) `refresh-prices.js` now writes **OHLC/close only** — `volume`
  column is left untouched on conflict, NULL on insert; (2) `polygon-daily-incremental.sh` syncs the
  trailing 15d of `backtest_prices.volume` FROM THE LAKE `market_bars_daily` (Polygon consolidated, same
  source `screener_volume` uses). ⇒ `backtest_prices.volume` is now correct for days the lake covers;
  the **latest 1-2 days are NULL** until the next nightly flatfile lands (lake lags 1 day) — readers must
  treat NULL volume as "unknown", never 0. SIP feed needs paid Alpaca ($99/mo); user is no-API-spend, so
  IEX was structural — hence lake-as-authority rather than upgrading the feed.
- **Moomoo OpenD is the PRIMARY fundamentals source** (broker, free, local) via `getSnapshots()` in
  `moomoo-tcp.js` (Qot_GetSecuritySnapshot 3203) → `moomoo_fundamentals` table. Gives TRAILING PE
  (`peTTMRate`), EPS, PB, shares, market cap. **NO forward PE in the protocol** — the Moomoo *app*
  computes forward PE from analyst estimates the API doesn't expose, so forward PE stays Yahoo/universe
  (won't match the app's number). Loss-making names return negative PE → stored as is_loss=true ("Loss").
  Screener PE COALESCE order: Moomoo → Yahoo → tradable_universe. OpenD must be up for the daily ingest;
  the COALESCE fallback makes a down OpenD degrade gracefully. Snapshot is rate-limited (~400 syms/30s).
- **Lake `market_bars_daily` LAGS by date** (Polygon flatfiles publish late; Polygon being dropped). It's
  correct in *magnitude* but its newest row can be 2-3 days old → never use it for a "latest day" value
  (close, today's volume). For latest close use `tradable_universe.last_price` (Alpaca daily, matches
  Moomoo curPrice to the cent); for latest day volume use Moomoo `getSnapshots().day_volume` (fresh +
  consolidated). Keep the lake only for historical aggregates (e.g. 30d avg volume). Bit the ownership
  screener twice (stale 208 close, stale day-vol) — caught by a broker-truth audit.
- `yahoo-finance2` is **v3**: default export is a CLASS — `import YahooFinance from 'yahoo-finance2'; const yf = new YahooFinance({suppressNotices:['yahooSurvey']});` then `yf.quoteSummary(...)`. The old `yahooFinance.quoteSummary(...)` throws "Call `const yahooFinance = new YahooFinance()` first". (Also: `.historical()` is deprecated/flaky for split-adjustment — use the lake's `build_adjusted` for adjusted prices.)
- Float + institutional %: `quoteSummary(sym,{modules:['defaultKeyStatistics','majorHoldersBreakdown']})` → floatShares, sharesOutstanding, heldPercentInstitutions, institutionsFloatPercentHeld, heldPercentInsiders. Institutional data is QUARTERLY (13F)/snapshot — no true daily series. ETF-holdings-of-a-stock: NOT available in stack.

## Migrations
- `node-pg-migrate` v8 exports the runner as a NAMED export `mod.runner` (NOT `mod.default`).
  migration-runner.js resolves `mod.runner ?? mod.default ?? mod` — auto-migrate-on-boot was silently
  dead before this (fixed 2026-06-09). If migrations stop auto-applying after a pkg upgrade, check this.
- Auto-migrate runs `direction: 'up'` on boot → any unapplied migration file applies on next restart.
  Before deploying/restarting, check `comm -23 <files> <pgmigrations>` for surprises (esp. parked migs).

## Scheduling (macOS)
- **Every data table needs a SCHEDULED writer — "built once in a session" = silently frozen.**
  The 2026-06-12 audit found earnings_calendar 12d stale, intraday_bars_1m/daily_intraday_features/
  sector_rotation/stock_correlations 11d (one-shot scripts never cron'd; sector_rotation's writer
  wasn't even committed). All now run in polygon-daily-incremental.sh. RULE: when a new table ships,
  its refresh goes into the daily job IN THE SAME COMMIT, or it doesn't ship.
- `cron` is unreliable + can't reach `/Volumes/Archive` (TCC). Use **launchd** user agents.
- A launchd/cron-spawned process needs **Full Disk Access on `/bin/bash`** to write `/Volumes/Archive`.
- launchd `StandardOutPath` must be in `~/Library/Logs`, NOT the external volume (else exit 78).
- After editing a `.plist`: `launchctl unload && load` (start alone uses cached config).

## Backtest / ML correctness (see memory: audit-backtest-correctness)
- Keep feature windows **backward-only** (UW/insider leakage was fixed in v_ml_training_set v3 — don't regress).
- Live model trains on only ~1yr (recent bull) → regime overfit. Use the 10yr Silver lake for retrains.
- Use the survivorship-free universe (backtest_prices, 25k incl delisted) — not the 525-symbol set.
- `stock_predictions` can contain target_dates on weekends/holidays (generation artifact) and symbols
  that left backtest_prices (renames, e.g. SQ→XYZ) — those rows can NEVER fill actual_price. The
  `stale_preds` health check excludes non-trading-day targets (fixed 2026-06-12 after a 2,310-row
  backlog; 2,050 backfilled via the same SQL as the 17:30 ET fallback cron, which only looks back 21d).
- **The PWA service worker (sw.js, scope `/`) intercepts ALL same-origin /api/* GETs with a 5s
  abort** — any endpoint slower than 5s gets killed and replaced with `'{}'` 503 → desktop tabs show
  "Error: fetch failed" (burned 2026-06-12: /api/health/checks takes ~6s). Slow admin endpoints must
  be in sw.js `SW_BYPASS`. When adding an endpoint that can exceed 5s, add it there + bump CACHE ver.

## Desktop AI chat (claude CLI) — keychain/session trap (fixed 2026-06-12)
- **Chat history is per-username with a 40-row DB cap** (conversation_history) + 20-msg memory window.
  Diagnostic chat calls as 'admin' TRIMMED the user's real conversations out (burned 2026-06-12).
  ALL test/verification calls to /api/chat/desktop MUST send `X-Chat-Test: 1` (answers normally,
  skips history writes). Never run chat tests against a real user's history without it.
- The chat shells out to `claude -p` using the user's Max-sub OAuth from the macOS KEYCHAIN.
  **If the PM2 daemon was spawned by launchd** (boot hook), its children get NO keychain session →
  CLI prints "Not logged in · Please run /login" **to STDOUT** (stderr empty → looked like a silent
  exit 1 until 2026-06-12 instrumentation). FIX used: `pm2 save && pm2 kill && pm2 resurrect` from an
  interactive (keychain-capable) shell. ⚠️ AFTER EVERY REBOOT the launchd hook re-owns pm2 → chat
  breaks again until either (a) daemon restarted from a terminal, or (b) THE DURABLE FIX: user runs
  `claude setup-token` once and puts CLAUDE_CODE_OAUTH_TOKEN in .env (the chat spawner passes env
  through; it only strips ANTHROPIC_API_KEY/AUTH_TOKEN).
- Diagnosing CLI failures: -p mode errors often go to STDOUT. claude-desktop-chat.js now surfaces both.

## Local AI (Ollama) — fixed 2026-06-12 after being dead since 2026-05-27
- **Homebrew's ollama formula (0.30.x) ships NO llama-server runner** on this machine → every
  /api/generate returned HTTP 500 ("llama-server binary not found") while /api/tags worked, so
  `isOllamaAvailable()` lied. Every localAI call silently fell back to the Anthropic API → dead on
  exhausted credits (user is no-API-spend) → EOD summaries, briefings, coach chat all dark.
  FIX: runner binaries are COPIED from /Applications/Ollama.app/Contents/Resources into
  /opt/homebrew/Cellar/ollama/<ver>/libexec/lib/ollama/. ⚠️ A `brew upgrade ollama` creates a new
  keg WITHOUT them — re-copy (llama-server, llama-quantize, lib*.dylib, lib*.so, mlx_metal_*) after
  any upgrade, then `brew services restart ollama`, then test /api/generate (NOT just /api/tags).
- Ollama.app can't be used headless: quarantined (Gatekeeper needs one GUI launch) and xattr -d
  on /Applications needs App-Management TCC the shell doesn't have. `cp` out of the bundle works.
- `localAI()` (src/core/ollama.js): 90s timeout (cold 20GB trading-coach takes ~30s; old 15s
  timeout guaranteed fallback), tries OLLAMA_MODEL → llama3.2:3b → Anthropic, and NEVER throws —
  returns {text:null, source:'unavailable'}; callers must skip-on-null (EOD does).
- Health check for "is local AI really working": curl POST /api/generate with a tiny prompt.
  /api/tags returning 200 proves nothing.

## Logging (streamlined 2026-06-12 — keep it that way)
- **pm2-logrotate is installed** (10MB cap, keep 14, compressed, midnight rotate). If pm2 is ever
  reinstalled, re-run: `pm2 install pm2-logrotate` + the `pm2 set pm2-logrotate:*` settings.
- **Dead integrations must circuit-break, not retry-and-log.** Anthropic calls go through
  `src/core/anthropic-breaker.js` (trips 6h on credit/auth errors, logs ONE line); Benzinga has a
  per-host 401 breaker in `src/core/benzinga.js` (5 consecutive 401s → 12h quiet). Before this,
  thousands of identical 400/401 lines made the error log unreadable (restart #8 cause was unfindable).
- **Never log URLs containing tokens** — benzinga logs leaked `token=...` for weeks; `_redact()` now
  strips token/apiKey query params. Apply the same rule to any new client.
- yahoo-finance2 instances need `validation: { logErrors: false }` (schema dumps were most of the
  22MB out-log). All 13 `new YahooFinance(...)` sites have it — copy that pattern for new ones.
- New code: use `makeLog(tag)` from `src/core/log.js` (timestamp + level + module tag; DEBUG gated
  by LOG_DEBUG=1) instead of bare console.*. PM2 processes are started with `--time` so stdout gets
  timestamps; keep that flag if a process is ever re-created.
- Long-running batch jobs (Python multiprocessing!): a finished/killed parent can leave a
  resource_tracker holding the log file open — `rm` won't free the space. `lsof <log>` before delete.
- `log_growth` health check watches ~/.pm2/logs + ~/Library/Logs (warn >500MB, fail >2GB).
- Daily script trims `polygon-incremental_*.log` older than 14 days.
- **Log Monitor**: 📜 panel on the Health tab + MCP `log_sources`/`log_tail` tools — BOTH wrap
  `src/core/log-monitor.js` (whitelisted roots pm2:/jobs:, tail reads max 1MB from file END, never
  the whole file). Add new log locations THERE, not in the route/tool. Claude Desktop must be
  restarted to see newly added MCP tools.

## Bot decision quality (retrospective + fixes 2026-06-19)
- **Universe restricted to S&P500∪NDX100** (~516 names) in `buildAdvanceCandidateUniverse`
  (entry-rules.js) — cached index_membership filter, default ON, per-bot opt-out via
  `rules.universe.index_only=false`. Stops the bot scanning 8k+ junk micro-caps/ETFs.
- **Platform charges now booked**: `src/core/bot-advance/costs.js` (alpaca ~0.10% RT, tiger ~0.20%,
  override `rules.costs.round_trip_pct`). Close records NET pnl_usd (gross − est cost) + `est_cost_usd`
  column. NOTE: historical pnl is GROSS, new trades NET — mixed when comparing across 2026-06-19.
- **Cost-aware trailing stop (THE scalping fix):** old trail armed at +1% peak then exited on a 30%
  give-back of tiny profit → 42-min scalps (retrospective: bot 4 = 53/56 trail exits, +0.4% avg that
  loses to fees). Now arms only after peak clears max(4% notional, 3× round-trip cost) — executor.js
  `_manageOnePosition`. Tunable `rules.exits.trail_arm_pct`. Modeled: 60% of last week's scalps → holds.
- Trail trails on P&L not price; entries (ml_v2/insider/52w) are ~flat-positive — the EXIT was the
  problem. Bot 2 (tiger) was PAUSED 2026-06-19 (left paused; Tiger API also throttled).

## Data quality + health checks (fixed 2026-06-17)
- **Split-adjustment glitches in backtest_prices:** the nightly Yahoo refresh can leave a few
  UNADJUSTED rows among split-adjusted ones (KLAC 06-10/06-11 were ~10× the neighbors → 898% fake
  move on the heatmap). Detector: rows >4× or <0.25× the symbol's 11-day median. Fix: ÷ split ratio
  on OHLC, × ratio on volume for the offending rows. WATCH: the refresh may re-introduce them — a
  systematic split-aware fix in the refresh is the real follow-up.
- The heatmap (/api/market/sp500-heatmap) is PREVIOUS-CLOSE grade (last completed session, 10-min
  cache) — not live intraday. Looking "stale" during market hours is by design.
- **The 5 PM ET price refresh is an IN-PROCESS cron in trading-dashboard** — a restart at/around
  5 PM ET silently skips that day (left backtest_prices stuck at 06-16 → "old numbers" 2026-06-17).
  FIX: a startup catch-up (server.js, ~45s after boot, prod only) re-runs refreshPrices if
  backtest_prices.max(price_date) < the most recent closed weekday. Manual catch-up:
  `node -e "import('./src/research/refresh-prices.js').then(m=>m.refreshPrices({daysBack:5}))"`.
  Real long-term fix would be moving it to a launchd job (independent of process restarts).
- **bot_scan health check** now unions bot_decisions (legacy, dormant) + bot_advance_decisions
  (active fleet). It used to watch only the legacy table → false FAIL after the legacy fleet was
  stopped while the active bots scanned fine. Always point heartbeat checks at the ACTIVE table.

## Bot-advance slippage metric (fixed 2026-06-14, order-path #2)
- `slippage_cents` must be measured against the executor's OWN live quote (`price`, the
  divergence-validated `_getLivePrice` at ~executor.js:290 that the order was sized on), NOT
  `rawOrder.estimated_price` — that is a SEPARATE quote re-fetched inside trader.js/placeQuickTrade
  and was stale/wrong for some names (NUVL −1750¢ = −14%/share, GLXY −6% on 2026-06-13). It was
  measuring decision-anchor drift, not execution. Fix at executor.js:~364.
- slippage_cents is a PURE METRIC — never used in any trade decision; safe to change/clamp.
- New code clamps |fill−ref|/ref > 5% to null (honest "unknown" beats a fictional number).

## Bot-advance market regime gate (deployed 2026-06-14, from BOT_SIM)
- `src/core/bot-advance/regime-gate.js` blocks NEW entries when SPY < its 200-day SMA
  (risk-off, regimes R3/R4). Validated in sim: turned COVID −12%→−5%, 2022 bear −7%→0%.
- It can ONLY block — never places a trade. Fails OPEN on missing SPY data (won't freeze the bot).
- Per-bot opt-out: `rules.risk.regime_gate_enabled = false`. Logs `skip_regime_gate` decisions.
- Computes from backtest_prices SPY (needs the daily refresh current). Cached per SPY session.
- Wired in engine.js right after the daily-loss circuit breaker; runs in trading-dashboard process.

## Platform facts (current)
- Compute is the **Mac Studio M3 Ultra (28-core/96GB)** since 2026-06-08. Apple Silicon `/opt/homebrew`.
- Lake: Bronze (Node) `/Volumes/Archive/bronze/oltp`; Silver/Gold (Python `lake/`, DuckDB) `/Volumes/Archive/{silver,gold}`.
- Engine is **DuckDB-first** (no Spark — slower single-node).

## Bot-advance exit floor + phantom accounting (2026-07-07, from Alpaca retrospective)
- RETROSPECTIVE FINDING: on the Alpaca paper account (live acct unfunded/$0) the bot-advance
  fleet round-tripped 163 names for ~flat P&L, but every entry rule was net-negative because
  exits fired at a ~34-min AVERAGE hold (trail_stop 0.7h, thesis_broken 0.0h) — the 5–14d swing
  thesis never developed. The 2026-06-19 trail-arm fix did NOT change avg hold (0.57h before AND
  after). Root cause was the EXIT layer scalping, not the entries.
- FIX A — min-hold floor: `shouldVetoExit()` (executor.js) vetoes NON-risk exits (trail_stop,
  thesis_broken) until a trade ages past `rules.exits.min_hold_hours` (default **6h**, 0 disables).
  hard_stop / catastrophic / stop_loss ALWAYS bypass so downside is never trapped. time_stop is
  naturally > floor.
- BOT_SIM CALIBRATION (2026-07-07 sweep, R1 window, min_hold wired into sim broker.mjs/_shared.mjs):
  a SMALL floor (≤12h) is ~free (−0.1pp); LARGE floors (≥24h) monotonically HURT in calm bull
  (72h = −1.1pp, win 63→61%) — lengthening holds into R1 loses, matching the −5.6% learning lesson.
  ⇒ default set to 6h (kills sub-hour scalping, negligible cost). CAVEAT: sim can't model the live
  `thesis_broken` 0h-exit, so it proves "no harm at 6h", NOT that the floor fixes the live scalping.
- FIX B — phantom accounting: 119 of 170 `alpaca_reconcile_phantom` rows HAD a real fill
  (dollars_invested>0) but were dumped as status='failed', zeroing pnl_usd → this is why the DB
  ledger (−$1,605) disagreed with the Alpaca account (−$592). `bookPhantomRow()` /
  `phantomTerminalStatus()` (drift-detector.js) now book filled phantoms as real 'closed' with
  P&L at last price + exit_reason='reconciled_missing_from_broker'; never-filled ($0) stay 'failed'.
  Scoped to bot_advance_trades ONLY — the legacy `trades` table has ambiguous dup columns
  (entry_price vs entry_px, qty twice) so its P&L math is left untouched.
- STRUCTURAL: two independent order paths (legacy trader.js `bot_<sym>` + bot-advance) trade the
  SAME Alpaca paper account — a prime source of phantom collisions. Consolidate to one path/account.
- Regression tests: tests/bot-advance-exit-floor.test.js (11 pure-function cases, no DB).

## Lake self-sync after Polygon cancellation (2026-07-07)
- ROOT CAUSE (why the lake wasn't self-syncing): `lake/sync_daily.py sync_market_daily()` appended
  `market_bars_daily` ONLY from Polygon flat-files (`FLATFILES/day_aggs_v1/*.csv.gz`). The live daily
  source (`backtest_prices`, Yahoo-fed, current to yesterday, 25k syms) was EXCLUDED from the lake
  sync (BRONZE_DEFER + MARKET_COPIES gate). So forward market data was 100% Polygon-dependent — the
  lake could not sustain itself from live data. This is the gap POLYGON_EXIT_PLAN.md flagged.
- FIX (2 parts):
  1. `scripts/etl/refresh-volume-yahoo.mjs` — fills `backtest_prices.volume` from Yahoo CONSOLIDATED
     volume (full tape). refresh-prices.js writes OHLC from Alpaca IEX and leaves volume NULL (IEX =
     ~3% of tape). Wired into polygon-daily-incremental.sh BEFORE lake.sync_daily. Scoped to recent
     NULL-volume rows; idempotent/self-healing. Replaces the old lake→backtest_prices volume patch.
  2. `lake/sync_daily.py sync_market_daily_from_oltp()` (STEP 2b) — forward-fills `market_bars_daily`
     from OLTP `backtest_prices` for trading days STRICTLY AFTER the last Polygon flat-file. Polygon
     stays authoritative for archived days; OLTP (Yahoo) covers everything forward → lake self-syncs
     after cancellation. source='yahoo_oltp'. Guard: OLTP_MIN_SYMBOLS=500 skips holiday/partial days
     (2026-07-03 had 1 stray row). Fails OPEN (missing DATABASE_URL/attach just skips).
- GOTCHA — pg DATE→UTC display shift: pg returns DATE as local-midnight; `.toISOString()` rolls it
  back a day IN LOGS ONLY. The UPDATE matching (Yahoo row.date ↔ price_date) is exact — verified
  A/AA July-6 volume landed on the correct price_date.
- OVERLAP CAVEAT (pre-cancellation only): a day Yahoo publishes before Polygon's T+1 file is filled
  from OLTP and not later upgraded to Polygon. Harmless (1 day's volume source); gone once cancelled.
- Splits/divs still have no forward source (Polygon REST) → market_bars_daily_adj won't apply NEW
  splits forward (history already adjusted; backtests unaffected). Separate follow-up if needed.

## Bronze daily-append: lagging-event tables lose back-dated rows (fixed 2026-07-08)
- `dump-oltp-to-bronze.mjs` MODE=daily dumps `WHERE <partition_col> = yesterday`. Auto-picked partition
  col preferred EVENT dates (filed_at/traded_at) over ingested_at. For tables where the event date lags
  ingestion (Congress files STOCK-Act disclosures 30-45d late; Form-4 a few days late), a row that ARRIVES
  today with an event date weeks ago lands in a partition whose daily run already happened → PERMANENTLY
  LOST. Audit found uw_congressional_trades lake missing 190 rows (pg 2097 / bronze 1907).
- FIX: `ARRIVAL_PARTITION` set in dump-oltp-to-bronze.mjs = {uw_congressional_trades, uw_insider_trades}
  → these partition by `ingested_at` (arrival) so daily capture is complete. Scoped to small signal tables
  ONLY — market tables (intraday_bars_1m etc.) must stay event-date partitioned for backfill. Recovered via
  one-time MODE=backfill ONLY=... (rebuilds clean, no double-count — backfill wipes the table dir).
- If you add a UW/event table whose rows arrive after their event date, add it to ARRIVAL_PARTITION.
