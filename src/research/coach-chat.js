// CLI for trading-coach v2. One-shot or interactive REPL.
//
//   node src/research/coach-chat.js "how am I doing this week?"   # one-shot
//   node src/research/coach-chat.js                               # interactive
//
// Shows which tools the coach called (so you can confirm it FETCHED the numbers
// rather than inventing them). Set VERBOSE=1 to see tool args inline.
import readline from 'node:readline';
import { askCoach, closeCoach } from '../core/trading-coach-agent.js';

const verbose = process.env.VERBOSE === '1';

async function ask(question, history) {
  process.stdout.write('\n🤔 thinking…\n');
  const { text, toolCalls } = await askCoach(question, { history, verbose });
  if (toolCalls.length) {
    const summary = toolCalls.map(t => `${t.name}→${t.row_count ?? '?'} rows`).join(', ');
    process.stdout.write(`🔧 tools: ${summary}\n`);
  } else {
    process.stdout.write('🔧 tools: (none — answered from rules/persona only)\n');
  }
  process.stdout.write(`\n🎯 ${text}\n`);
  // Keep the assistant turn in history for follow-ups.
  return [...history,
    { role: 'user', content: question },
    { role: 'assistant', content: text }];
}

async function main() {
  const oneShot = process.argv.slice(2).join(' ').trim();

  if (oneShot) {
    await ask(oneShot, []);
    await closeCoach();
    return;
  }

  console.log('trading-coach v2 — interactive. Type a question, or "exit" to quit.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let history = [];
  rl.prompt();
  rl.on('line', async (line) => {
    const q = line.trim();
    if (!q) return rl.prompt();
    if (q === 'exit' || q === 'quit') return rl.close();
    try { history = await ask(q, history); }
    catch (err) { console.error(`\n❌ ${err.message}`); }
    rl.prompt();
  });
  rl.on('close', async () => { await closeCoach(); process.exit(0); });
}

main().catch(async (err) => { console.error(err); await closeCoach(); process.exit(1); });
