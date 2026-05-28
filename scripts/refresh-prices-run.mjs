#!/usr/bin/env node
/**
 * scripts/refresh-prices-run.mjs — manual trigger for the daily price refresh.
 *
 *   npm run bot:refresh-prices            # refresh whole universe (12K symbols, ~75 sec)
 *   npm run bot:refresh-prices -- --dry   # fetch but don't write to DB (smoke test)
 *   npm run bot:refresh-prices -- --few   # smoke test on 10 popular symbols only
 *
 * The 5 PM ET cron in src/web/server.js fires `refreshPrices()` automatically Mon-Fri.
 */

import { initDb } from '../src/core/db.js';
import { refreshPrices } from '../src/research/refresh-prices.js';

const isDry = process.argv.includes('--dry');
const isFew = process.argv.includes('--few');

const fewSymbols = ['AAPL','MSFT','GOOGL','AMZN','NVDA','TSLA','META','AMD','ASML','TTMI'];

try {
  await initDb();
  const result = await refreshPrices({
    dryRun:       isDry,
    daysBack:     5,
    symbolFilter: isFew ? fewSymbols : null,
  });
  console.log('\n=== Summary ===');
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('💥 fatal:', e.message);
  process.exit(1);
} finally {
  process.exit(0);
}
