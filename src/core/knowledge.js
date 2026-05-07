import { searchKnowledge, saveKnowledgeChunk, countKnowledgeChunks, countKnowledgeChunksByTopic, query } from './db.js';

const OLLAMA_URL             = process.env.OLLAMA_URL             || 'http://localhost:11434';
const OLLAMA_MODEL           = process.env.OLLAMA_MODEL           || 'llama3.1:8b';
const OLLAMA_KNOWLEDGE_MODEL = process.env.OLLAMA_KNOWLEDGE_MODEL || 'llama3.2:3b';

export async function getEmbedding(text) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.embedding ?? null;
  } catch {
    return null;
  }
}

function searchKnowledgeByKeyword(query) {
  // Only match substantive words (>= 5 chars) — filters out "with", "one",
  // "are", "the" etc. that cause false-positive scores on generic follow-ups
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 5);
  return KNOWLEDGE_BASE
    .map(chunk => {
      const hay = `${chunk.topic} ${chunk.title} ${chunk.content} ${(chunk.keywords ?? []).join(' ')}`.toLowerCase();
      const score = words.filter(w => hay.includes(w)).length;
      return { ...chunk, score };
    })
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

export async function answerKnowledgeQuestion(userQuestion, { onChunk } = {}) {
  try {
    // Fast path — keyword match on local KB (instant, no API call)
    const localChunks = searchKnowledgeByKeyword(userQuestion);
    if (localChunks.length && localChunks[0].score >= 2) {
      const answer = localChunks.map(c => `**${c.title}**\n${c.content}`).join('\n\n');
      return { answer, source: 'local_db', model: 'Knowledge Base', chunks_used: localChunks.length };
    }

    // Vector similarity path — use embeddings for semantic match
    const embedding = await getEmbedding(userQuestion);
    if (embedding) {
      const results = await searchKnowledge({ embedding, limit: 3 });
      const relevant = results.filter(r => r.similarity > 0.55);
      if (relevant.length) {
        const answer = relevant.map(r => `**${r.title}**\n${r.content}`).join('\n\n');
        return { answer, source: 'local_db', model: 'Knowledge Base', chunks_used: relevant.length };
      }
    }

    // No good local match — return error so caller falls through to Claude Sonnet
    return { source: 'error' };
  } catch {
    return { source: 'error' };
  }
}

export async function isKnowledgeQuestion(text) {
  // Action/portfolio questions — never route to knowledge base
  const actionPatterns = [
    /what (are|is) (the |my )?(trades?|positions?|stocks?|picks?) (to buy|to sell|today|now)/i,
    /what (should|can) i (buy|sell|trade|do)/i,
    /\b(find|scan|show|get|give) (me )?(a |some |the )?(trade|pick|setup|signal|stock to buy)/i,
    /\b(buy|sell) (today|now|signal)/i,
    /\b(my |open )?(positions?|portfolio|balance|p.?l|pnl)\b/i,
    /\b(execute|place|enter|open|close) (a |the )?(trade|position|order)\b/i,
    /\b(our|my|the bot'?s?)\s+(trade\s+rules?|trading\s+rules?|rules|config|settings|setup)\b/i,
    /\b(what are|what is|tell me)\s+(our|my|the)\s+(rules?|trade\s+rules?|limits?)\b/i,
    /\b(check|show|find|analyse?|analyze?|review|look at)\b.*(my|last).*(trade|pattern|result|performance)/i,
    /\b(last\s+(friday|monday|tuesday|wednesday|thursday|saturday|week|month|yesterday))\b/i,
    /\b(auto.?execut|book.?trade|execut.*automatically|scan.*execut|take.*profit.*auto)/i,
    /\bhow (much|did) i (made?|got?|earned?|profit)/i,
    /\bi (made?|got?|earned?)\s+\$?\d/i,
    /\b(predict|prediction|forecast|price target|day by day|next \d+ days?|target price|where.*headed|how high|how low)\b/i,
  ];
  if (actionPatterns.some(p => p.test(text))) return false;

  const knowledgePatterns = [
    /what is\b/i, /what are\b/i, /what does\b/i,
    // "explain" must be followed by a subject — not a bare follow-up like "explain with one example"
    /explain\s+\w{4,}/i,
    /how does\b/i, /how do i\b/i, /how to\b/i,
    /teach me\b/i, /define\b/i, /meaning of\b/i, /tell me about\b/i,
    /difference between\b/i, /when (should|do) i\b/i,
    /\b(rsi|macd|ema|sma|vwap|atr|bollinger|fibonacci|candlestick|divergence|breakout|pullback|support|resistance|trend|momentum|reversal|volume|float|short squeeze|gap up|gap down|pre.?market|after.?hours|position sizing|stop loss|take profit|risk reward|r:r|chart pattern|candlestick pattern|bull flag|bear flag|cup and handle|setup|strategy|indicator|order type|market order|limit order|stop limit)\b/i,
    /\b(option|options|call option|put option|calls|puts|strike price|expiry|expiration|implied volatility|iv rank|theta|delta|gamma|vega|greeks|covered call|protective put|iron condor|straddle|strangle|otm|itm|atm|derivatives|contracts)\b/i,
  ];
  return knowledgePatterns.some(p => p.test(text));
}

// ── Knowledge Base ────────────────────────────────────────────────────────────

const KNOWLEDGE_BASE = [
  // ── Indicators ──────────────────────────────────────────────────────────────
  {
    topic: 'RSI basics', category: 'indicators', title: 'What is RSI (Relative Strength Index)',
    content: 'RSI is a momentum oscillator that measures the speed and magnitude of recent price changes on a 0–100 scale. A reading above 70 is considered overbought and may signal a pullback; below 30 is oversold and may signal a bounce. It is typically calculated over 14 periods. RSI works best in ranging markets and can give false signals in strong trends.',
  },
  {
    topic: 'RSI overbought oversold', category: 'indicators', title: 'RSI Overbought and Oversold Levels',
    content: 'RSI above 70 means the asset is overbought — sellers may soon take control. RSI below 30 means oversold — buyers may step in. In a strong uptrend, RSI can stay above 70 for extended periods (bullish momentum), so avoid shorting just because RSI is overbought. Always confirm with price action and volume.',
  },
  {
    topic: 'RSI divergence', category: 'indicators', title: 'RSI Divergence',
    content: 'Bullish divergence: price makes a lower low but RSI makes a higher low — signals weakening selling pressure and potential reversal up. Bearish divergence: price makes a higher high but RSI makes a lower high — signals weakening buying pressure and potential reversal down. Divergences are early warning signals, not entry triggers on their own; wait for confirmation.',
  },
  {
    topic: 'MACD crossover', category: 'indicators', title: 'MACD Crossover Signals',
    content: 'MACD (Moving Average Convergence Divergence) uses two EMAs (typically 12 and 26 period) and a 9-period signal line. A bullish crossover occurs when the MACD line crosses above the signal line — potential buy signal. A bearish crossover occurs when MACD crosses below the signal line — potential sell signal. Crossovers near the zero line are stronger than those far from it.',
  },
  {
    topic: 'MACD histogram', category: 'indicators', title: 'MACD Histogram Explained',
    content: 'The MACD histogram shows the distance between the MACD line and the signal line. Growing histogram bars mean momentum is accelerating in that direction. Shrinking bars warn that momentum is fading before a crossover happens. Histogram divergence (price makes new high but histogram bars are smaller) is an early reversal signal.',
  },
  {
    topic: 'EMA vs SMA', category: 'indicators', title: 'EMA vs SMA — Which to Use',
    content: 'SMA (Simple Moving Average) gives equal weight to all periods; EMA (Exponential Moving Average) gives more weight to recent prices and reacts faster. For intraday trading, EMAs (9, 20, 50) are preferred because they respond quickly to price changes. The 20 EMA acts as dynamic support in uptrends; a pullback to the 20 EMA that holds is a common long entry.',
  },
  {
    topic: '20 50 EMA strategy', category: 'indicators', title: 'Using the 20 and 50 EMA',
    content: 'When the 20 EMA is above the 50 EMA, the trend is bullish. When price pulls back to the 20 EMA and bounces in an uptrend, that is a high-probability long entry. A cross of the 20 EMA below the 50 EMA (death cross) signals a trend shift to bearish. These levels are watched by institutional traders making them self-fulfilling.',
  },
  {
    topic: 'Bollinger Bands', category: 'indicators', title: 'Bollinger Bands — How to Use Them',
    content: 'Bollinger Bands consist of a 20-period SMA (middle band) and upper/lower bands 2 standard deviations away. When bands contract (squeeze), it signals low volatility and an impending breakout. When price rides the upper band, the trend is strongly up. A close outside the bands followed by a close back inside often signals a reversal. Price tends to revert to the middle band.',
  },
  {
    topic: 'Bollinger squeeze breakout', category: 'indicators', title: 'Bollinger Band Squeeze Breakout',
    content: 'A Bollinger squeeze occurs when the bands tighten to their narrowest range. This is caused by low volatility and typically precedes a large directional move. To trade: wait for the squeeze, then enter when price breaks out of the bands with volume confirmation. The direction of the breakout determines your trade side — do not anticipate the direction.',
  },
  {
    topic: 'VWAP', category: 'indicators', title: 'VWAP — Volume Weighted Average Price',
    content: 'VWAP is the average price weighted by volume throughout the trading day, resetting each session. Institutional traders use VWAP as a benchmark — buyers want to buy below VWAP, sellers above it. Price above VWAP signals bullish intraday bias; below VWAP is bearish. A stock reclaiming VWAP after a dip with strong volume is a bullish intraday signal.',
  },
  {
    topic: 'ATR', category: 'indicators', title: 'ATR — Average True Range for Stop Sizing',
    content: 'ATR measures the average daily price range over a set period (typically 14 bars). A higher ATR means more volatility. For stop placement, set your stop 1–1.5× ATR below your entry — this keeps you outside normal noise. For position sizing, divide your max dollar risk per trade by the ATR-based stop distance to get share count.',
  },

  // ── Risk Management ──────────────────────────────────────────────────────────
  {
    topic: 'position sizing', category: 'risk_management', title: 'Position Sizing — Risk 1-2% Per Trade',
    content: 'Never risk more than 1–2% of your account on a single trade. If you have a $10,000 account, max risk per trade is $100–$200. Calculate shares as: (max dollar risk) ÷ (entry price − stop price). This ensures a string of losses does not blow your account and lets you recover from drawdowns.',
  },
  {
    topic: 'stop loss placement', category: 'risk_management', title: 'Stop Loss Placement — ATR-Based and Structure-Based',
    content: 'Place stops below a key structure level (support, swing low, VWAP) rather than at an arbitrary percentage. ATR-based stops: set stop 1–1.5× ATR below entry. Structure-based stops: set stop just below the nearest support level. Never place a stop at a round number where everyone else puts theirs — it gets hunted. Tight stops below structure give the best risk/reward.',
  },
  {
    topic: 'risk reward ratio', category: 'risk_management', title: 'Risk/Reward Ratio — Minimum 2:1',
    content: 'A 2:1 risk/reward means you target $2 profit for every $1 risked. At a 50% win rate, you still profit with 2:1 R:R. Before entering any trade, identify your stop (risk) and your target (reward) — if the ratio is less than 2:1, skip the trade. High-conviction setups should target 3:1 or better.',
  },
  {
    topic: 'daily loss limit', category: 'risk_management', title: 'Daily Loss Limit — Stop After 2 Losses',
    content: 'Set a daily max loss (e.g., 3–5% of account) and stop trading the moment you hit it. Many professional traders stop after 2 consecutive losses regardless of dollar amount — this prevents revenge trading spirals. A bad day with discipline is recoverable; a runaway loss day can take weeks to dig out of. Protecting capital is job #1.',
  },
  {
    topic: 'averaging down', category: 'risk_management', title: 'Never Average Down on a Losing Trade',
    content: 'Averaging down (adding to a losing position) increases your size and risk just as the trade is going against you. The market is telling you the thesis is wrong. If price hit your stop, exit — do not buy more. The only exception is a planned scaling strategy defined before entry, with a pre-set second entry level and a wider stop already accounted for in your position sizing.',
  },

  // ── Options Trading ──────────────────────────────────────────────────────────
  {
    topic: 'options basics calls puts', category: 'options', title: 'What Are Options — Calls and Puts',
    content: 'An option is a contract that gives the buyer the right (but not the obligation) to buy or sell 100 shares of a stock at a set price before a specific date. A call option gives the right to BUY — you profit if the stock rises above the strike price. A put option gives the right to SELL — you profit if the stock falls below the strike price. The buyer pays a premium for this right; the seller collects the premium and takes on the obligation.',
  },
  {
    topic: 'options strike price expiry', category: 'options', title: 'Strike Price and Expiration Date',
    content: 'The strike price is the fixed price at which the option can be exercised (buying or selling the underlying stock). The expiration date is the last day the option can be used — after that it expires worthless if not exercised. Options closer to expiry (0–7 DTE) are cheaper but lose value rapidly (theta decay). Longer-dated options (30–90 DTE) cost more but give the trade time to work and decay slower.',
  },
  {
    topic: 'options ITM ATM OTM', category: 'options', title: 'In the Money, At the Money, Out of the Money',
    content: 'ITM (In the Money): a call is ITM when the stock price is above the strike price; a put is ITM when below. ITM options have intrinsic value and cost more. ATM (At the Money): strike price equals current stock price — highest theta decay, popular for selling strategies. OTM (Out of the Money): a call is OTM when stock is below strike; a put when above — no intrinsic value, all time value, cheaper but lower probability of profit.',
  },
  {
    topic: 'implied volatility IV options', category: 'options', title: 'Implied Volatility (IV) and What It Means',
    content: 'Implied Volatility (IV) reflects the market\'s expectation of how much a stock will move. High IV = expensive options (e.g., pre-earnings). Low IV = cheap options. When IV is high, selling options (collecting premium) is more profitable; when IV is low, buying options is better value. IV Crush happens after earnings when IV drops sharply and option prices collapse even if the stock moves in your direction — a common trap for options buyers.',
  },
  {
    topic: 'options greeks delta theta gamma', category: 'options', title: 'Options Greeks — Delta, Theta, Gamma, Vega',
    content: 'Delta: how much the option price moves per $1 move in the stock (call delta 0–1, put delta 0 to -1). An ATM option has delta ~0.5. Theta: daily time decay — the option loses this much value each day, accelerating near expiry. Gamma: rate of change of delta — high for near-term ATM options. Vega: sensitivity to IV — a rise in IV increases option price. For simple directional trades, focus on delta and theta; selling options benefits from theta, buying from delta.',
  },
  {
    topic: 'options strategies covered call protective put', category: 'options', title: 'Basic Options Strategies',
    content: 'Buying a call: bullish bet with limited downside (only the premium paid). Buying a put: bearish bet or portfolio hedge. Covered call: own 100 shares and sell a call above current price to collect premium — reduces upside but generates income. Protective put: own shares and buy a put to cap downside (like insurance). Long straddle: buy both a call and put at the same strike when expecting a big move but unsure of direction.',
  },
  {
    topic: 'options vs stocks leverage risk time decay', category: 'options', title: 'Options vs Stocks — Leverage, Risk, Time Decay',
    content: 'Options give leverage: controlling 100 shares for a fraction of the stock price. A $2 option on a $100 stock lets you control $10,000 in stock for $200. But options have time decay (theta) — every day the option loses value even if the stock does not move. Options can expire worthless (total loss of premium). Stocks can always recover; options have an expiry date that works against buyers. For most day traders, stocks offer better risk control.',
  },
  {
    topic: 'options risky for day traders', category: 'options', title: 'Why Options Are Risky for Day Traders',
    content: 'Options pricing involves multiple variables: stock price, strike, time to expiry, IV, and interest rates. You can be right about the direction and still lose money if IV compresses or time decay erodes your position. Wide bid/ask spreads in illiquid options can cost 10–20% of premium instantly. Expiry pressure forces rushed decisions. Beginners should paper trade options extensively before using real capital, and start with defined-risk strategies (buying calls/puts) rather than selling naked options.',
  },
  {
    topic: 'put call ratio options sentiment', category: 'options', title: 'Put/Call Ratio — Options Sentiment Indicator',
    content: 'The put/call ratio divides the number of put options traded by the number of call options traded. A ratio above 1.0 means more puts than calls — bearish sentiment. A ratio below 0.7 means excessive optimism and can signal a contrarian short. Extreme readings (above 1.3 or below 0.5) are often contrarian signals — when everyone is bearish via puts, a reversal up is likely. Track the CBOE Put/Call Ratio daily for broad market sentiment.',
  },

  // ── Patterns ─────────────────────────────────────────────────────────────────
  {
    topic: 'cup and handle', category: 'patterns', title: 'Cup and Handle Pattern',
    content: 'The cup and handle is a bullish continuation pattern. The "cup" forms a rounded bottom after a pullback, followed by a smaller consolidation (the "handle") near the prior high. Buy when price breaks above the handle\'s resistance with volume. The target is the depth of the cup added to the breakout point. It signals institutional accumulation.',
  },
  {
    topic: 'bull flag', category: 'patterns', title: 'Bull Flag Pattern',
    content: 'A bull flag forms after a sharp, strong move up (the pole) followed by a tight, low-volume consolidation that drifts slightly downward or sideways (the flag). Entry is when price breaks above the upper flag boundary with a volume spike. Target is the length of the pole added to the breakout. It signals a brief pause before continuation.',
  },
  {
    topic: 'bear flag', category: 'patterns', title: 'Bear Flag Pattern',
    content: 'A bear flag is the inverse of a bull flag — a sharp drop (pole) followed by a low-volume consolidation drifting up (flag). Enter short on the break below the flag\'s lower boundary. Target is the pole length subtracted from the breakdown point. Volume should be low during the flag and spike on the breakdown.',
  },
  {
    topic: 'double top double bottom', category: 'patterns', title: 'Double Top and Double Bottom',
    content: 'A double top is a bearish reversal pattern: price hits resistance twice and fails to break through, forming two peaks. Enter short on the break of the neckline (the low between the two tops) with a target equal to the pattern height. A double bottom is the bullish mirror — two lows at the same level, enter long on the neckline break. Confirmation requires volume on the breakdown or breakout.',
  },
  {
    topic: 'morning star evening star', category: 'patterns', title: 'Morning Star and Evening Star Candlesticks',
    content: 'Morning star (bullish reversal): a large bearish candle, followed by a small-bodied doji or spinning top, followed by a large bullish candle. It signals a bottom reversal. Evening star (bearish reversal): large bullish candle, small doji, large bearish candle — signals a top reversal. These are 3-candle patterns and strongest at key support/resistance levels.',
  },
  {
    topic: 'hammer shooting star', category: 'patterns', title: 'Hammer and Shooting Star',
    content: 'A hammer has a small body at the top and a long lower wick — buyers rejected the lows and pushed back up. It is bullish at support. A shooting star has a small body at the bottom and a long upper wick — sellers rejected the highs and pushed back down. It is bearish at resistance. The longer the wick relative to the body, the stronger the signal.',
  },
  {
    topic: 'gap up volume', category: 'patterns', title: 'Gap Up with Volume — Continuation vs Exhaustion',
    content: 'A gap up on high volume after a catalyst (earnings beat, news) that holds above the gap and continues higher is a continuation gap — strong bullish signal. A gap up that immediately fades back into the prior day\'s range on high volume is an exhaustion gap — the move is likely over. The first 15–30 minutes tell you which type it is: holds = continuation, fades = trap.',
  },

  // ── Strategy ─────────────────────────────────────────────────────────────────
  {
    topic: 'momentum trading', category: 'strategy', title: 'Momentum Trading — High RVOL + News Catalyst',
    content: 'Momentum trading targets stocks with a fresh news catalyst (earnings beat, FDA approval, analyst upgrade) combined with high relative volume (RVOL > 2×). The catalyst explains why it is moving; the RVOL confirms institutions are buying. Entry is typically on the first pullback after the initial spike, or on a breakout above a key intraday level, not at the highs of the spike.',
  },
  {
    topic: 'breakout trading', category: 'strategy', title: 'Breakout Trading with Volume Confirmation',
    content: 'A breakout occurs when price moves above a defined resistance level (prior high, consolidation top, round number) on above-average volume. Volume is the key — a breakout on low volume often fails and reverses. Wait for the candle to close above the level, enter on the retest of the breakout level as new support, and set your stop just below that level.',
  },
  {
    topic: 'pullback to EMA', category: 'strategy', title: 'Pullback to EMA Entry',
    content: 'In an established uptrend, wait for price to pull back to the 20 or 50 EMA before entering long. This gives a better risk/reward than chasing at highs. Look for the candle to touch the EMA and show a rejection (hammer, bullish engulfing) on lower volume. The stop goes just below the EMA. This strategy trades with the trend and avoids top-buying.',
  },
  {
    topic: 'pre-market gap strategy', category: 'strategy', title: 'Pre-Market Gap Strategy',
    content: 'Stocks gapping up 5%+ pre-market on strong volume and a clear catalyst are prime intraday momentum candidates. Watch the first 5-minute candle after the open. If price holds above the pre-market high and volume is strong, buy the breakout. If price fades below the open, stay out — it may fill the gap. Set target at the next resistance level and stop below the open.',
  },

  // ── Psychology ───────────────────────────────────────────────────────────────
  {
    topic: 'revenge trading', category: 'psychology', title: 'Revenge Trading — Why to Avoid It',
    content: 'Revenge trading is jumping back into the market after a loss to "make it back" immediately. It is emotionally driven, skips proper setup analysis, and leads to bigger losses. The market does not owe you back what it took. After a loss, step away for at least 30 minutes, review what went wrong, and only re-enter if a valid setup appears — not to recover losses.',
  },
  {
    topic: 'FOMO', category: 'psychology', title: 'FOMO — Fear of Missing Out',
    content: 'FOMO causes traders to chase stocks already up 10–20% because they fear missing further gains. Chasing extends your risk (stop must be wider) while reducing reward (target is closer). There is always another trade. If you missed the entry, mark it, study it, and wait for the next similar setup. Disciplined traders profit from having entries, not from being in every move.',
  },
  {
    topic: 'cutting losses', category: 'psychology', title: 'Cutting Losses Quickly',
    content: 'The hardest habit in trading is taking a small loss before it becomes a large one. Holding a losing trade hoping it comes back wastes capital, opportunity cost, and mental energy. If price hits your stop level, exit without hesitation — it is not failure, it is risk management working as intended. Traders who cut losses quickly preserve capital to trade another day.',
  },
  {
    topic: 'letting winners run', category: 'psychology', title: 'Letting Winners Run',
    content: 'Traders often exit winning trades too early out of fear of giving back gains. Instead: take partial profit at 1:1 or 1.5:1 R:R to reduce emotional pressure, then let the remaining position run to your full target. Use a trailing stop on the remainder. Move your stop to breakeven once the trade is 50% to target. This captures big moves without needing to be perfect.',
  },

  // ── Market Structure ─────────────────────────────────────────────────────────
  {
    topic: 'support resistance', category: 'market_structure', title: 'Support and Resistance',
    content: 'Support is a price level where buyers have historically stepped in and prevented further decline. Resistance is where sellers have historically prevented further advance. These levels come from prior swing highs/lows, round numbers, VWAP, and moving averages. The more times a level is tested without breaking, the stronger it is — but also the more likely to break when it finally does.',
  },
  {
    topic: 'uptrend downtrend', category: 'market_structure', title: 'Higher Highs / Higher Lows — Trend Structure',
    content: 'An uptrend is defined by higher highs and higher lows — each rally goes higher than the last, and each pullback holds above the prior pullback. A downtrend is lower highs and lower lows. When a stock makes a lower low in an uptrend, the trend structure is broken — consider exiting longs. Trade in the direction of the trend; fighting a clear trend is a low-probability strategy.',
  },
  {
    topic: 'market open volatility', category: 'market_structure', title: 'Market Open (9:30–10 AM ET) Volatility',
    content: 'The first 30 minutes after the market opens (9:30–10 AM ET) are the most volatile of the day. Institutional orders flood in, gaps fill or extend, and moves are often sharp and fast. Many experienced traders wait for the first 5-minute candle to close before entering, or wait until 9:45–10 AM for the initial volatility to settle. This window has the highest volume and widest spreads.',
  },
  {
    topic: 'midday chop', category: 'market_structure', title: 'Midday Chop (11:30 AM – 2 PM ET)',
    content: 'Between roughly 11:30 AM and 2 PM ET, trading volume drops sharply and price action becomes choppy and directionless as institutional traders break for lunch. Breakouts during this window frequently fail; trends started in the morning often stall. Many intraday traders reduce size or stop trading entirely during this window, resuming at the 2 PM "power hour" session.',
  },

  // ── Bot-Specific ──────────────────────────────────────────────────────────────────
  {
    topic: 'pre-market gap trading', category: 'strategy', title: 'Pre-Market Gaps: Gap-and-Go vs Gap Fill',
    keywords: ['premarket', 'gap', 'gapper', 'gap-and-go', 'gap fill', 'overnight', 'catalyst'],
    content: 'A pre-market gap occurs when a stock opens significantly higher or lower than the prior day\'s close due to overnight news, earnings, or a catalyst. Two opposite strategies apply: gap-and-go and gap fill. Gap-and-go: if a stock gaps up 5%+ on high volume with a genuine catalyst (earnings beat, FDA approval, M&A), the move often continues after open — traders buy the breakout above the pre-market high. Gap fill: without a strong catalyst, stocks often pull back to fill the gap before continuing. Key rules: gaps above 10% on a low-float stock (<20M shares) tend to run further. Gaps on heavy volume (≥3× average) are more likely to hold. Avoid chasing gaps that have already moved 30%+ before market open — the risk/reward is poor. The bot\'s catalyst scanner flags pre-market movers above 5% with volume ≥ 100K shares as potential gap-and-go setups.',
  },
  {
    topic: 'low float momentum', category: 'strategy', title: 'Low Float Stocks: Why They Move Fast',
    keywords: ['low float', 'float', 'shares outstanding', 'squeeze', 'short squeeze', 'momentum', 'CNSP', 'SKK', 'GBTG'],
    content: 'Float is the number of shares available for public trading — it excludes shares held by insiders or locked up. Low-float stocks have fewer than 20 million shares available. When buying pressure hits a low-float stock, supply is limited, so price moves up sharply with relatively little volume. A 1-million-share buy on a 5-million-float stock is a 20% float turnover — massive. This is why low-float names like CNSP, SKK, and GBTG can move 50–200% in a single session. The squeeze mechanic: short sellers who bet against these stocks are forced to buy back shares to cover losses, adding more buying pressure on top of organic demand. Risks are equally large: these stocks drop just as fast when momentum reverses. Key filters the bot uses: float ≤ 20M shares, RVOL ≥ 1.5× average, price ≥ $1. Low-float trades require tight stops and quick exits — they are not suitable for overnight holds.',
  },
  {
    topic: 'RVOL relative volume', category: 'indicators', title: 'RVOL: Relative Volume and Why It Matters',
    keywords: ['rvol', 'relative volume', 'volume ratio', 'unusual volume', 'volume spike', 'float turnover'],
    content: 'Relative Volume (RVOL) compares today\'s current volume to the average volume for the same time of day over the past 20 sessions. An RVOL of 2.0 means twice the normal trading activity — institutional or retail interest is abnormally high. RVOL is calculated as: current_volume / (average_daily_volume × (minutes_elapsed / 390)). An RVOL above 2× at market open is a strong signal that a move has momentum behind it and is not a low-volume fake-out. The bot requires RVOL ≥ 1.5 for low-float catalyst setups. Above 3×, volume is exceptional and suggests a major catalyst is driving the move. RVOL alone is not enough — it must be paired with a catalyst (earnings, FDA, 8-K news) and a clean chart setup. High RVOL on a declining stock can signal panic selling — in that case, it warns against buying, not for it.',
  },
  {
    topic: '8-K SEC filing catalyst', category: 'strategy', title: 'SEC 8-K Filings: What They Signal for Traders',
    keywords: ['8-K', 'SEC', 'EDGAR', 'filing', 'material event', 'acquisition', 'merger', 'FDA', 'press release', 'guidance'],
    content: 'An 8-K is a form public companies file with the SEC to report material events that shareholders must know about immediately. Unlike quarterly reports (10-Q) or annual reports (10-K), 8-Ks are filed within 4 business days of the triggering event. High-impact items for traders: Item 2.01 (completion of acquisition or disposition) — M&A deals that often cause 20–50% gaps. Item 1.01 (entry into a material agreement) — major contracts or partnerships. Items 7.01/8.01 (Regulation FD disclosure / other events) — press releases with earnings guidance or strategic announcements. Items 3.02/5.02 — stock issuance or executive changes that may signal dilution risk. The bot\'s SEC scanner monitors EDGAR in real-time for these item types during market hours. When a high-impact 8-K is detected, it appears in the Catalyst Scan panel. Not all 8-Ks are bullish — read the content, not just the filing.',
  },
  {
    topic: 'ATR position sizing', category: 'risk_management', title: 'ATR-Based Position Sizing in This Bot',
    keywords: ['ATR', 'average true range', 'position size', 'stop loss', 'risk per trade', 'volatility sizing'],
    content: 'Average True Range (ATR) measures a stock\'s average daily price swing over the past 14 days. The bot uses ATR to set stop-loss distances and calculate position size automatically. Formula: stop_distance = 1.5 × ATR14. Position size = risk_per_trade / stop_distance, where risk_per_trade is capped at 1% of portfolio value or $200, whichever is lower. Example: AAPL with ATR of $2.50 → stop distance = $3.75. If your portfolio is $10,000 and max risk is $100, position size = $100 / $3.75 = 26 shares. This keeps your dollar risk constant regardless of the stock\'s price or volatility. High-volatility stocks get smaller positions automatically — you can\'t override ATR sizing manually in automated mode. For paper trading, the same formula applies but no real money is at risk. ATR position sizing prevents outsized losses on any single trade and is one of the most important risk controls in the system.',
  },
  {
    topic: 'conviction scoring system factors', category: 'strategy', title: 'Conviction Score: How the 0–100 Score Is Built',
    keywords: ['conviction', 'score', 'scoring', 'factors', 'RSI', 'MACD', 'EMA', 'VIX', 'earnings', 'sentiment', 'ML model'],
    content: 'The conviction score is a composite 0–100 signal built from 15 factors across 5 categories. Technical (40 pts): RSI positioning (above/below 50), MACD signal crossover direction, EMA alignment (price above/below EMA9/20/50), Bollinger Band position, volume trend vs 20-day average. Fundamental (20 pts): earnings surprise direction, revenue growth trend, EPS momentum over last 4 quarters. Sentiment (15 pts): relative strength vs SPY over 5 days, VIX regime (above 25 is bearish adjustment), news sentiment score from last 48 hours. ML adjustment (±10 pts): logistic regression model trained on 3 years of S&P500/NASDAQ100 data; adjusts score by grade (+8 for A, +3 for B, -2 for C, -9 for F). Catalyst (15 pts): insider buying signal, earnings within 5 days flag, sector momentum. Important: the ML model has an AUC of ~0.52 — barely above random chance. Use conviction scores as a screening filter to narrow candidates, not as a buy/sell signal. Scores above 60 favor longs; below 35 avoid.',
  },
  {
    topic: 'daily loss limit bot guard', category: 'risk_management', title: 'Daily Loss Limit: How the $200 Guard Works',
    keywords: ['daily loss', 'loss limit', 'drawdown', 'guard', 'block', 'circuit breaker', 'max loss'],
    content: 'The bot enforces a hard daily loss limit of $200 (configurable in Bot Rules settings). Once realized losses for the day hit this threshold, the bot stops executing new trades for the remainder of the trading session. How it works: after each trade closes, the bot sums all realized P&L from today\'s closed positions. If total is ≤ -$200, the guard activates and any new trade attempt is logged to trade_rejections with reason "daily_loss_limit". The limit resets automatically at midnight ET. Manual trades placed directly through the Quick Trade panel or Force Trade do NOT bypass this guard — they also check the daily loss total. If you want to override for testing, temporarily raise the limit in Bot Rules or switch to paper trading mode. The $200 default represents 0.5% of a $40K portfolio — keeping any single bad day from causing serious damage. You can see the current day\'s P&L and whether the guard is active in the Dashboard → Positions panel.',
  },
  {
    topic: 'time filters trading hours', category: 'risk_management', title: 'Time Filters: When the Bot Blocks Trading',
    keywords: ['time filter', 'trading hours', 'market open', 'market close', 'after hours', 'block', 'schedule', '9:30', '4:00'],
    content: 'The bot applies time-based filters to avoid the most dangerous trading windows. Blocked periods: pre-market (before 9:30 AM ET) — liquidity is thin and spreads are wide, making fills unpredictable. First 5 minutes (9:30–9:35 AM ET) — extreme volatility as overnight orders fill; most reversals happen here. Last 5 minutes (3:55–4:00 PM ET) — closing auction volatility can cause sudden gaps. After-hours (after 4:00 PM ET) — no automated trades; only manual overrides. Midday soft block (11:30 AM – 1:30 PM ET) — this is not a hard block, but the bot reduces its conviction threshold by 5 points during this window to account for lower-quality breakouts. The bot uses New York time (America/New_York) for all time checks, so it handles daylight saving automatically. These filters are enforced before ATR sizing or conviction checks — a trade that would otherwise pass all checks is still rejected if it falls in a blocked window. The rejection is logged to trade_rejections with reason "time_filter".',
  },
  {
    topic: 'bracket orders OTO Alpaca', category: 'strategy', title: 'Bracket Orders: How the Bot Protects Every Trade',
    keywords: ['bracket', 'OTO', 'take profit', 'stop loss', 'order', 'Alpaca', 'limit order', 'stop order', 'one-triggers-other'],
    content: 'The bot places every trade as a bracket order on Alpaca — a primary market buy paired with two contingent exits: a take-profit limit order and a stop-loss stop order. This is implemented as an OTO (One-Triggers-Other) or bracket order in the Alpaca API: `order_class: "bracket"`, `take_profit: { limit_price }`, `stop_loss: { stop_price }`. Stop-loss distance is 1.5 × ATR14 below entry. Take-profit is 3 × ATR14 above entry — a 2:1 reward-to-risk ratio. Once the primary buy fills, Alpaca automatically manages both exit legs. If the stop is hit, the take-profit cancels automatically (OCO — One-Cancels-Other). This means you do not need to babysit positions — exits are handled server-side by Alpaca even if the bot crashes. In paper trading mode, bracket orders use the paper trading API base URL (`paper-api.alpaca.markets`). Important: Alpaca does not support bracket orders on fractional shares — the bot rounds position sizes to whole shares before submitting.',
  },
  {
    topic: 'paper trading live trading switch', category: 'strategy', title: 'Paper vs Live Trading: How to Switch',
    keywords: ['paper', 'live', 'paper trading', 'real money', 'Alpaca', 'API key', 'switch', 'mode', 'simulation'],
    content: 'Paper trading uses Alpaca\'s simulated environment with fake money — no real capital is at risk. Live trading connects to your real Alpaca brokerage account and executes real orders. To switch between them: go to Settings → Broker Config → Alpaca and enter the appropriate API key and secret. Paper trading uses keys from Alpaca\'s paper portal (`paper-api.alpaca.markets`); live trading uses keys from the live portal (`api.alpaca.markets`). The bot automatically uses the correct base URL based on whether your key begins with `PK` (paper) or `AK` (live). What changes between modes: (1) All trade data is isolated — paper trades do not appear in live history and vice versa. (2) Paper orders fill instantly at mid-price; live orders fill at market price with real slippage. (3) Paper account starts with $100,000 simulated cash. (4) The daily loss limit and all other guards apply equally in both modes. Recommendation: always test any new Bot Rule configuration on paper trading for at least one week before switching to live.',
  },
];

export function isTradeHistoryQuestion(text) {
  const livePatterns = [
    /should i (buy|sell|hold|close)/i,
    /right now/i, /current price/i,
    /place.*order/i, /scan for trade/i,
  ];
  if (livePatterns.some(p => p.test(text))) return false;

  const patterns = [
    /why.*i.*(profit|win|made money)/i,
    /why.*i.*(los[st]|fail|went wrong)/i,
    /why.*(profit|loss|win|lose)/i,
    /what went (wrong|right)/i,
    /my.*last.*trade/i, /recent.*trade/i,
    /trade.*history/i, /trade.*pattern/i,
    /how.*i.*perform/i, /my.*win rate/i,
    /best.*trade/i, /worst.*trade/i,
    /my.*p&?l/i, /my.*pnl/i,
    /how much.*made/i, /how much.*lost/i,
    /average.*profit/i, /average.*loss/i,
    /what.*mistake/i, /compare.*trade/i,
    /day \d.*day \d/i, /first day.*third day/i,
    /which.*trade.*profit/i, /which.*trade.*los[st]/i,
  ];
  return patterns.some(p => p.test(text));
}

export async function answerTradeHistoryQuestion(userQuestion) {
  try {
    const { rows } = await query(`
      SELECT
        symbol, side,
        TO_CHAR(created_at AT TIME ZONE 'America/New_York', 'Mon DD YYYY') AS trade_date,
        TO_CHAR(created_at AT TIME ZONE 'America/New_York', 'HH12:MI AM')  AS entry_time,
        entry_price, exit_price, qty,
        ROUND(pnl_usd::numeric, 2)  AS pnl_usd,
        ROUND(pnl_pct::numeric, 2)  AS pnl_pct,
        conviction_score, conviction_grade,
        conviction_breakdown
      FROM trades
      WHERE status = 'closed' AND pnl_usd IS NOT NULL
      ORDER BY created_at DESC LIMIT 30
    `);

    if (!rows.length) {
      return {
        answer: 'No closed trades in the database yet. Start trading and I can analyse your patterns.',
        source: 'local_db',
      };
    }

    const wins     = rows.filter(t => t.pnl_usd > 0).length;
    const losses   = rows.filter(t => t.pnl_usd <= 0).length;
    const totalPnl = rows.reduce((s, t) => s + parseFloat(t.pnl_usd), 0).toFixed(2);
    const winRate  = ((wins / rows.length) * 100).toFixed(1);
    const avgWin   = (rows.filter(t => t.pnl_usd > 0)
                        .reduce((s, t) => s + parseFloat(t.pnl_usd), 0) / (wins || 1)).toFixed(2);
    const avgLoss  = (rows.filter(t => t.pnl_usd <= 0)
                        .reduce((s, t) => s + parseFloat(t.pnl_usd), 0) / (losses || 1)).toFixed(2);

    const tradeLines = rows.map((t, i) => {
      const result = parseFloat(t.pnl_usd) > 0 ? 'WIN' : 'LOSS';
      const regime = t.conviction_breakdown?.regime ?? 'unknown';
      return `Day ${i + 1} | ${t.trade_date} ${t.entry_time} | ${t.symbol} | ${result} | P&L: $${t.pnl_usd} (${t.pnl_pct}%) | Conviction: ${t.conviction_score ?? 'n/a'}/${t.conviction_grade ?? 'n/a'} | Regime: ${regime}`;
    }).join('\n');

    const summary = `${rows.length} trades | Wins: ${wins} | Losses: ${losses} | Win Rate: ${winRate}% | Total P&L: $${totalPnl} | Avg Win: $${avgWin} | Avg Loss: $${avgLoss}`;

    const prompt = `You are a personal trading coach analysing a trader's real trade history.

Summary: ${summary}

Trades (newest first):
${tradeLines}

Question: "${userQuestion}"

Answer using only the data above. Reference specific dates, symbols, P&L, conviction scores, and regimes. Compare winning vs losing trade conditions. Give 3-5 sentences with specific observations then 1-2 actionable recommendations. No generic advice.`;

    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:    OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream:   false,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
    const data   = await resp.json();
    const answer = data.message?.content?.trim() ?? 'Could not analyse trades.';

    return { answer, source: 'ollama', model: OLLAMA_MODEL };
  } catch (err) {
    console.error('[trade-history]', err.message);
    return { answer: 'Could not load trade history right now.', source: 'error' };
  }
}

export async function seedKnowledge() {
  const existing = await countKnowledgeChunks();

  // Always ensure options entries exist regardless of total count
  const optionsCount = await countKnowledgeChunksByTopic('options');
  const needsOptions = optionsCount === 0;

  // If already fully seeded and options are present, skip
  if (existing >= 50 && !needsOptions) return { seeded: 0 };

  const toSeed = existing === 0
    ? KNOWLEDGE_BASE
    : KNOWLEDGE_BASE.filter(c => c.category === 'options' && needsOptions);

  let count = 0;
  for (let i = 0; i < toSeed.length; i++) {
    const { topic, category, title, content } = toSeed[i];
    const embedding = await getEmbedding(`${title} ${content}`);
    if (embedding) {
      await saveKnowledgeChunk({ topic, category, title, content, embedding });
      count++;
    }
    console.log(`[knowledge] seeded ${i + 1}/${toSeed.length}: ${title}`);
  }

  return { seeded: count };
}
