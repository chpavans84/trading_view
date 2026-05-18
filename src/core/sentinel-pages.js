// HTML pages for one-click action links in sentinel emails

function base(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #0f1117; color: #e2e8f0; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #1a1d27; border-radius: 12px; padding: 32px 28px;
          max-width: 420px; width: 100%; border: 1px solid #2d3148; }
  .icon { font-size: 48px; text-align: center; margin-bottom: 16px; }
  h1 { font-size: 20px; font-weight: 700; text-align: center; margin-bottom: 8px; }
  .sub { font-size: 14px; color: #94a3b8; text-align: center; margin-bottom: 24px; line-height: 1.5; }
  .detail { background: #12151f; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .row { display: flex; justify-content: space-between; align-items: center;
         padding: 6px 0; font-size: 14px; border-bottom: 1px solid #1e2235; }
  .row:last-child { border-bottom: none; }
  .label { color: #64748b; }
  .value { font-weight: 600; }
  .value.green { color: #22c55e; }
  .value.red { color: #ef4444; }
  .value.yellow { color: #f59e0b; }
  .btn { display: block; width: 100%; padding: 14px; border-radius: 8px; border: none;
         font-size: 16px; font-weight: 700; cursor: pointer; text-align: center;
         text-decoration: none; }
  .btn-success { background: #22c55e; color: #fff; }
  .btn-danger  { background: #ef4444; color: #fff; }
  .btn-muted   { background: #2d3148; color: #94a3b8; }
  .ts { font-size: 11px; color: #475569; text-align: center; margin-top: 16px; }
</style>
</head>
<body>
<div class="card">${body}</div>
</body>
</html>`;
}

export function pageSuccess({ symbol, side, qty, price, executedAt }) {
  const sideLabel = side === 'sell' ? 'SOLD' : 'BOUGHT';
  const colorClass = side === 'sell' ? 'red' : 'green';
  const ts = new Date(executedAt).toLocaleString('en-US', { timeZone: 'America/New_York' });
  return base('Trade Executed', `
<div class="icon">✅</div>
<h1>Trade Executed</h1>
<p class="sub">Your order has been placed successfully.</p>
<div class="detail">
  <div class="row"><span class="label">Symbol</span><span class="value">${symbol}</span></div>
  <div class="row"><span class="label">Action</span><span class="value ${colorClass}">${sideLabel}</span></div>
  <div class="row"><span class="label">Quantity</span><span class="value">${qty} shares</span></div>
  <div class="row"><span class="label">Price</span><span class="value">$${Number(price).toFixed(2)}</span></div>
  <div class="row"><span class="label">Time</span><span class="value">${ts} ET</span></div>
</div>
<p class="ts">You can close this tab.</p>`);
}

export function pageExpired({ symbol, side, qty, expiresAt }) {
  const ts = new Date(expiresAt).toLocaleString('en-US', { timeZone: 'America/New_York' });
  return base('Link Expired', `
<div class="icon">⏰</div>
<h1>Link Expired</h1>
<p class="sub">This action link expired at ${ts} ET and can no longer be used.</p>
<div class="detail">
  <div class="row"><span class="label">Symbol</span><span class="value">${symbol}</span></div>
  <div class="row"><span class="label">Action</span><span class="value yellow">${side?.toUpperCase()} ${qty} shares</span></div>
</div>
<p class="sub">If you still want to act on this risk, place the trade manually in your broker.</p>
<p class="ts">Links expire 30 minutes after the sentinel email is sent.</p>`);
}

export function pageAlreadyActioned({ symbol, status, actionedAt }) {
  const ts = actionedAt
    ? new Date(actionedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })
    : 'unknown';
  const statusLabel = status === 'executed' ? 'already executed' : 'already ignored';
  const icon = status === 'executed' ? '🔁' : '🚫';
  return base('Already Actioned', `
<div class="icon">${icon}</div>
<h1>Already Actioned</h1>
<p class="sub">This proposal for <strong>${symbol}</strong> was ${statusLabel} at ${ts} ET.</p>
<p class="sub" style="margin-top:12px;">Each proposal can only be acted on once. Check your broker for the current position.</p>
<p class="ts">You can close this tab.</p>`);
}

export function pagePriceMoved({ symbol, side, qty, proposedPrice, currentPrice }) {
  const pctMove = (((currentPrice - proposedPrice) / proposedPrice) * 100).toFixed(1);
  const direction = currentPrice > proposedPrice ? 'up' : 'down';
  return base('Price Moved', `
<div class="icon">📉</div>
<h1>Price Moved Too Much</h1>
<p class="sub">The current price of <strong>${symbol}</strong> has moved ${Math.abs(pctMove)}% ${direction} since this proposal was generated. Executing at this price would deviate too far from the intended risk level.</p>
<div class="detail">
  <div class="row"><span class="label">Symbol</span><span class="value">${symbol}</span></div>
  <div class="row"><span class="label">Proposed</span><span class="value">$${Number(proposedPrice).toFixed(2)}</span></div>
  <div class="row"><span class="label">Current</span><span class="value yellow">$${Number(currentPrice).toFixed(2)}</span></div>
  <div class="row"><span class="label">Move</span><span class="value yellow">${pctMove > 0 ? '+' : ''}${pctMove}%</span></div>
  <div class="row"><span class="label">Requested</span><span class="value">${side?.toUpperCase()} ${qty} shares</span></div>
</div>
<p class="sub">Review the position manually and decide whether the risk still applies at the current price.</p>
<p class="ts">No trade was placed. You can close this tab.</p>`);
}

export function pageConfirmExecute({ id, token, symbol, side, qty, limitPrice, currentPrice }) {
  const sideLabel = side === 'sell' || side === 'trim' ? 'SELL' : 'BUY';
  const colorClass = sideLabel === 'SELL' ? 'red' : 'green';
  const priceRow = limitPrice
    ? `<div class="row"><span class="label">Limit Price</span><span class="value">$${Number(limitPrice).toFixed(2)}</span></div>`
    : '';
  const curRow = currentPrice
    ? `<div class="row"><span class="label">Current Price</span><span class="value">$${Number(currentPrice).toFixed(2)}</span></div>`
    : '';
  return base('Confirm Trade', `
<div class="icon">⚠️</div>
<h1>Confirm Trade</h1>
<p class="sub">Review the details below before confirming. This will place a live order.</p>
<div class="detail">
  <div class="row"><span class="label">Symbol</span><span class="value">${symbol}</span></div>
  <div class="row"><span class="label">Action</span><span class="value ${colorClass}">${sideLabel}</span></div>
  <div class="row"><span class="label">Quantity</span><span class="value">${qty} shares</span></div>
  ${priceRow}${curRow}
</div>
<form method="POST" action="/api/action/execute/${id}?token=${encodeURIComponent(token)}" style="margin-bottom:12px">
  <button type="submit" class="btn btn-danger">✓ Confirm — Place Order</button>
</form>
<a href="/api/action/ignore/${id}?token=${encodeURIComponent(token)}" class="btn btn-muted" style="display:block;text-align:center;padding:12px;border-radius:8px;text-decoration:none;color:#94a3b8">Cancel — Ignore this proposal</a>
<p class="ts">Clicking Confirm will immediately place a live order with your broker.</p>`);
}

export function pageConfirmIgnore({ id, token, symbol, side, qty }) {
  return base('Ignore Proposal', `
<div class="icon">🚫</div>
<h1>Ignore this Proposal?</h1>
<p class="sub">The sentinel suggested acting on <strong>${symbol}</strong>. Confirm below to dismiss it.</p>
<div class="detail">
  <div class="row"><span class="label">Symbol</span><span class="value">${symbol}</span></div>
  <div class="row"><span class="label">Proposed</span><span class="value">${side?.toUpperCase()} ${qty} shares</span></div>
</div>
<form method="POST" action="/api/action/ignore/${id}?token=${encodeURIComponent(token)}">
  <button type="submit" class="btn btn-muted">Yes, ignore this proposal</button>
</form>
<p class="ts">No trade will be placed.</p>`);
}

export function pageTokenInvalid() {
  return base('Invalid Link', `
<div class="icon">🔒</div>
<h1>Invalid or Tampered Link</h1>
<p class="sub">This action link is invalid. It may have been modified, copied incorrectly, or already invalidated.</p>
<p class="sub" style="margin-top:12px;">No trade was placed. If you believe this is an error, check your email for the original sentinel alert and use that link.</p>
<p class="ts">Security check failed. No action was taken.</p>`);
}
