#!/usr/bin/env node
/**
 * scripts/bot-digest-run.mjs — manual digest trigger.
 *
 *   npm run bot:digest             # generate + send email + telegram
 *   npm run bot:digest:preview     # generate only, print text to stdout
 *
 * The 4:30 PM ET cron in src/web/server.js fires `sendDigest()` automatically;
 * this script is for ad-hoc previews and testing.
 */

import { initDb } from '../src/core/db.js';
import { generateDigest, sendDigest } from '../src/core/bot-digest.js';

const preview = process.argv.includes('--preview');

try {
  await initDb();
  if (preview) {
    const r = await generateDigest();
    if (r.error) {
      console.error('❌', r.error);
      process.exit(2);
    }
    console.log(`Subject: ${r.subject}\n`);
    console.log(r.text);
    console.log(`\n(HTML body: ${r.html.length} bytes — not printed in preview mode)`);
  } else {
    const r = await sendDigest();
    if (r.error) {
      console.error('❌', r.error);
      process.exit(2);
    }
    console.log('Channels:', r.channels);
    console.log('\n--- preview text ---\n' + r.text);
  }
} catch (e) {
  console.error('💥 fatal:', e.message);
  process.exit(1);
} finally {
  // initDb opens a pool that prevents process exit; force close.
  process.exit(0);
}
