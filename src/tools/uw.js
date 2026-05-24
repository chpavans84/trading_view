/**
 * src/tools/uw.js
 *
 * MCP tools for raw Unusual Whales + Benzinga data access.
 *
 * All reads from PostgreSQL (populated by crons in src/web/server.js).
 * No live UW API calls from MCP — avoids rate-limit risk on the shared
 * 80k-req/day quota.
 *
 * Tools:
 *   uw_flow_get       — options flow alerts for a symbol (uw_flow_alerts table)
 *   uw_insider_get    — insider trades for a symbol (uw_insider_trades table)
 *   uw_congress_get   — congressional trades for a symbol (uw_congressional_trades)
 *   uw_top_movers_get — today's UW top movers (uw_top_movers table)
 *   benzinga_news_get — Benzinga sentiment + articles for a symbol from DB
 *
 * Added 2026-05-24 (user request: "did you include Benzinga and UW flow to MCP?").
 * DB lazy-init pattern follows portfolio-advisor.js.
 */

import { z } from 'zod';
import { jsonResult } from './_format.js';
import { initDb, query as dbQuery, isDbAvailable } from '../core/db.js';

// ── Lazy DB init ─────────────────────────────────────────────────────────────
let _dbReady = false;
async function ensureDb() {
  if (_dbReady) return true;
  try { await initDb(); _dbReady = isDbAvailable(); return _dbReady; }
  catch { return false; }
}

export function registerUwTools(server) {

  // ── UW Options Flow ────────────────────────────────────────────────────────

  server.tool(
    'uw_flow_get',
    'Get Unusual Whales options flow alerts for a stock from the DB (populated every 2 min during market hours). Returns recent flow alerts with contract details, premium, volume vs open interest, and sentiment label (bullish/bearish/neutral). Use this to see what smart money is doing in the options market for a specific ticker. Pass symbol="market" or omit symbol to see top cross-market flow.',
    {
      symbol: z.string().optional().describe('Stock ticker, e.g. "NVDA", "TSLA". Omit for all symbols.'),
      hours:  z.coerce.number().min(1).max(168).optional().describe('Lookback window in hours (default 24, max 168 = 1 week)'),
      limit:  z.coerce.number().min(1).max(100).optional().describe('Max rows to return (default 25)'),
      min_premium: z.coerce.number().min(0).optional().describe('Minimum premium in USD to filter by (default 0 = all). Use 100000 to see 6-figure+ flows.'),
      sentiment: z.enum(['bullish', 'bearish', 'neutral']).optional().describe('Filter by sentiment label'),
    },
    async ({ symbol, hours = 24, limit = 25, min_premium = 0, sentiment }) => {
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      try {
        const sym = symbol?.trim().toUpperCase();
        const { rows } = await dbQuery(
          `SELECT ticker, alert_type, side, strike, expiry, premium, volume, open_interest, sentiment, alerted_at
           FROM uw_flow_alerts
           WHERE alerted_at > NOW() - ($1 * INTERVAL '1 hour')
             AND ($2::text IS NULL OR ticker = $2)
             AND ($3 = 0 OR premium >= $3)
             AND ($4::text IS NULL OR sentiment = $4)
           ORDER BY alerted_at DESC
           LIMIT $5`,
          [hours, sym || null, min_premium, sentiment || null, limit]
        );
        const summary = rows.length ? {
          total: rows.length,
          bullish: rows.filter(r => r.sentiment === 'bullish').length,
          bearish: rows.filter(r => r.sentiment === 'bearish').length,
          total_premium: rows.reduce((s, r) => s + Number(r.premium ?? 0), 0),
        } : null;
        return jsonResult({
          symbol: sym || 'ALL',
          window_hours: hours,
          count: rows.length,
          summary,
          flows: rows.map(r => ({
            ticker:     r.ticker,
            side:       r.side,
            alert_type: r.alert_type,
            strike:     r.strike,
            expiry:     r.expiry,
            premium:    r.premium != null ? `$${Number(r.premium).toLocaleString()}` : null,
            volume:     r.volume,
            open_interest: r.open_interest,
            sentiment:  r.sentiment,
            alerted_at: r.alerted_at,
          })),
          note: rows.length === 0
            ? 'No flow alerts found. UW flow is ingested every 2 min during market hours (9:30–16:00 ET). Check outside market hours: data may be from prior session.'
            : null,
        });
      } catch (err) {
        return jsonResult({ error: `UW flow query failed: ${err.message}` }, true);
      }
    }
  );

  // ── UW Insider Trades ─────────────────────────────────────────────────────

  server.tool(
    'uw_insider_get',
    'Get insider trading activity for a stock from the DB (populated every 15 min from Unusual Whales / SEC Form 4 filings). Returns insider name, role (CEO/CFO/Director/etc.), transaction type (buy/sell), shares, price, and total value. Useful for checking whether executives are buying or selling before a trade decision.',
    {
      symbol: z.string().describe('Stock ticker, e.g. "NVDA", "AAPL"'),
      days:   z.coerce.number().min(1).max(365).optional().describe('Lookback window in days (default 30)'),
      limit:  z.coerce.number().min(1).max(50).optional().describe('Max rows to return (default 20)'),
      transaction_type: z.enum(['buy', 'sell']).optional().describe('Filter to only buys or only sells'),
    },
    async ({ symbol, days = 30, limit = 20, transaction_type }) => {
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      try {
        const sym = symbol.trim().toUpperCase();
        const { rows } = await dbQuery(
          `SELECT insider_name, role, transaction_type, shares, price, value, filed_at
           FROM uw_insider_trades
           WHERE ticker = $1
             AND filed_at > NOW() - ($2 * INTERVAL '1 day')
             AND ($3::text IS NULL OR LOWER(transaction_type) = $3)
           ORDER BY filed_at DESC
           LIMIT $4`,
          [sym, days, transaction_type || null, limit]
        );
        const totalBuyValue  = rows.filter(r => r.transaction_type?.toLowerCase() === 'buy').reduce((s, r) => s + Number(r.value ?? 0), 0);
        const totalSellValue = rows.filter(r => r.transaction_type?.toLowerCase() === 'sell').reduce((s, r) => s + Number(r.value ?? 0), 0);
        return jsonResult({
          symbol: sym,
          window_days: days,
          count: rows.length,
          summary: rows.length ? {
            buy_count:   rows.filter(r => r.transaction_type?.toLowerCase() === 'buy').length,
            sell_count:  rows.filter(r => r.transaction_type?.toLowerCase() === 'sell').length,
            net_buy_value: `$${(totalBuyValue - totalSellValue).toLocaleString()}`,
            sentiment: totalBuyValue > totalSellValue ? 'net_buying' : totalSellValue > totalBuyValue ? 'net_selling' : 'neutral',
          } : null,
          trades: rows.map(r => ({
            insider:  r.insider_name,
            role:     r.role,
            type:     r.transaction_type,
            shares:   r.shares != null ? Number(r.shares).toLocaleString() : null,
            price:    r.price  != null ? `$${Number(r.price).toFixed(2)}` : null,
            value:    r.value  != null ? `$${Number(r.value).toLocaleString()}` : null,
            filed_at: r.filed_at,
          })),
          note: rows.length === 0
            ? `No insider trades found for ${sym} in the last ${days} days. Data is from UW / SEC Form 4 filings, ingested every 15 min.`
            : null,
        });
      } catch (err) {
        return jsonResult({ error: `Insider query failed: ${err.message}` }, true);
      }
    }
  );

  // ── UW Congressional Trades ───────────────────────────────────────────────

  server.tool(
    'uw_congress_get',
    'Get congressional trading disclosures for a stock from the DB (STOCK Act filings via Unusual Whales, updated hourly). Returns member name, party, chamber, transaction type, dollar amount range, and trade date. Useful for following "smart money" from Washington. Omit symbol to see recent congressional activity across all stocks.',
    {
      symbol: z.string().optional().describe('Stock ticker, e.g. "NVDA". Omit for all recent congressional trades.'),
      days:   z.coerce.number().min(1).max(365).optional().describe('Lookback window in days (default 90)'),
      limit:  z.coerce.number().min(1).max(50).optional().describe('Max rows to return (default 20)'),
      party:  z.enum(['Democrat', 'Republican', 'Independent']).optional().describe('Filter by party'),
    },
    async ({ symbol, days = 90, limit = 20, party }) => {
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      try {
        const sym = symbol?.trim().toUpperCase();
        const { rows } = await dbQuery(
          `SELECT ticker, member_name, party, chamber, transaction_type, amount_range, traded_at, filed_at
           FROM uw_congressional_trades
           WHERE ($1::text IS NULL OR ticker = $1)
             AND traded_at > NOW() - ($2 * INTERVAL '1 day')
             AND ($3::text IS NULL OR party = $3)
           ORDER BY traded_at DESC
           LIMIT $4`,
          [sym || null, days, party || null, limit]
        );
        return jsonResult({
          symbol: sym || 'ALL',
          window_days: days,
          count: rows.length,
          trades: rows.map(r => ({
            ticker:     r.ticker,
            member:     r.member_name,
            party:      r.party,
            chamber:    r.chamber,
            type:       r.transaction_type,
            amount:     r.amount_range,
            traded_at:  r.traded_at,
            filed_at:   r.filed_at,
          })),
          note: rows.length === 0
            ? `No congressional trades found${sym ? ` for ${sym}` : ''} in the last ${days} days. Data via Unusual Whales / STOCK Act disclosures.`
            : null,
        });
      } catch (err) {
        return jsonResult({ error: `Congressional trade query failed: ${err.message}` }, true);
      }
    }
  );

  // ── UW Top Movers ─────────────────────────────────────────────────────────

  server.tool(
    'uw_top_movers_get',
    'Get today\'s top-moving stocks from Unusual Whales (updated every 5 min). Returns symbols ranked by price change %, with direction (up/down), price, and volume. Use this for a quick market scan of what is moving most right now.',
    {
      direction: z.enum(['up', 'down']).optional().describe('Filter to only gainers or only losers. Omit for both.'),
      limit: z.coerce.number().min(1).max(50).optional().describe('Max results (default 20)'),
    },
    async ({ direction, limit = 20 }) => {
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      try {
        const { rows } = await dbQuery(
          `SELECT ticker, direction, change_pct, price, volume, captured_at
           FROM uw_top_movers
           WHERE captured_at > NOW() - INTERVAL '8 hours'
             AND ($1::text IS NULL OR direction = $1)
           ORDER BY ABS(change_pct) DESC NULLS LAST
           LIMIT $2`,
          [direction || null, limit]
        );
        return jsonResult({
          direction: direction || 'all',
          count: rows.length,
          movers: rows.map(r => ({
            ticker:      r.ticker,
            direction:   r.direction,
            change_pct:  r.change_pct != null ? `${Number(r.change_pct) > 0 ? '+' : ''}${Number(r.change_pct).toFixed(2)}%` : null,
            price:       r.price != null ? `$${Number(r.price).toFixed(2)}` : null,
            volume:      r.volume,
            as_of:       r.captured_at,
          })),
          note: rows.length === 0 ? 'No movers data. UW top movers are captured every 5 min during market hours.' : null,
        });
      } catch (err) {
        return jsonResult({ error: `Top movers query failed: ${err.message}` }, true);
      }
    }
  );

  // ── Benzinga Sentiment ────────────────────────────────────────────────────

  server.tool(
    'benzinga_news_get',
    'Get Benzinga news sentiment for a stock from the DB (the same signal the bot uses as its 22%-weight news factor). Returns the aggregated sentiment label (bullish/bearish/neutral), confidence score, article count, and the sentiment used in the bot\'s most recent composite score for this ticker. This is the actual Benzinga signal, not Yahoo Finance headlines. Pass raw=true to see individual article details.',
    {
      symbol: z.string().describe('Stock ticker, e.g. "NVDA", "AAPL"'),
      hours:  z.coerce.number().min(1).max(72).optional().describe('Lookback window in hours for aggregation (default 24)'),
      raw:    z.boolean().optional().describe('If true, include individual conviction_score rows that contain the benzinga_news signal. Default false.'),
    },
    async ({ symbol, hours = 24, raw = false }) => {
      if (!await ensureDb()) return jsonResult({ error: 'Database unreachable from MCP server.' }, true);
      try {
        const sym = symbol.trim().toUpperCase();

        // Pull from conviction_scores which stores the news signal as part of factor_breakdown
        const { rows: scoreRows } = await dbQuery(
          `SELECT scored_at, score, grade,
                  factor_breakdown->>'news_sentiment' AS news_sentiment,
                  factor_breakdown->>'news_label'     AS news_label,
                  factor_breakdown->>'news_confidence' AS news_confidence,
                  factor_breakdown->>'news_article_count' AS article_count
           FROM conviction_scores
           WHERE symbol = $1
             AND scored_at > NOW() - ($2 * INTERVAL '1 hour')
           ORDER BY scored_at DESC
           LIMIT 10`,
          [sym, hours]
        );

        // Also look for bot_decisions factor_breakdown for this symbol (richer data)
        const { rows: decRows } = await dbQuery(
          `SELECT scanned_at, composite_score,
                  factor_breakdown->>'news' AS news_score,
                  factor_breakdown->>'news_label' AS news_label,
                  factor_breakdown->>'news_sentiment' AS news_sentiment,
                  notes
           FROM bot_decisions
           WHERE symbol = $1
             AND scanned_at > NOW() - ($2 * INTERVAL '1 hour')
             AND factor_breakdown IS NOT NULL
           ORDER BY scanned_at DESC
           LIMIT 5`,
          [sym, hours]
        );

        const latest = decRows[0] || scoreRows[0];
        const newsLabel = latest?.news_label || latest?.news_sentiment || 'unknown';
        const newsScore = decRows[0]?.news_score;
        const articleCount = scoreRows[0]?.article_count;

        return jsonResult({
          symbol: sym,
          window_hours: hours,
          benzinga_signal: {
            label:      newsLabel,
            score:      newsScore != null ? Number(newsScore).toFixed(1) : null,
            confidence: scoreRows[0]?.news_confidence != null ? Number(scoreRows[0].news_confidence).toFixed(2) : null,
            article_count: articleCount != null ? Number(articleCount) : null,
            bot_weight: '22% of composite score',
            interpretation: newsLabel === 'bullish' ? 'Benzinga is reading positive sentiment — adds to composite score'
              : newsLabel === 'bearish' ? 'Benzinga is reading negative sentiment — subtracts from composite score'
              : 'Neutral or insufficient articles — minimal impact on composite',
          },
          recent_scores: raw ? scoreRows : scoreRows.slice(0, 2),
          recent_bot_decisions: raw ? decRows : decRows.slice(0, 1),
          note: !latest
            ? `No Benzinga data found for ${sym} in the last ${hours} hours in conviction_scores or bot_decisions. The symbol may not have been scanned recently.`
            : null,
        });
      } catch (err) {
        return jsonResult({ error: `Benzinga signal query failed: ${err.message}` }, true);
      }
    }
  );
}
