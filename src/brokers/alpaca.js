/**
 * Alpaca broker adapter.
 * Uses Alpaca REST API v2. Works for both paper and live accounts.
 * Config (broker.config.json):
 *   alpaca.api_key    — your Alpaca API key
 *   alpaca.api_secret — your Alpaca API secret
 *   alpaca.paper      — true = paper trading, false = live (default: true)
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = join(__dirname, '..', '..', 'broker.config.json');
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  const cfg = raw.alpaca || {};
  const paper = cfg.paper !== false;
  const baseUrl = paper
    ? 'https://paper-api.alpaca.markets'
    : 'https://api.alpaca.markets';
  return { apiKey: cfg.api_key || '', apiSecret: cfg.api_secret || '', baseUrl };
}

async function alpacaFetch(path) {
  const { apiKey, apiSecret, baseUrl } = loadConfig();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      'APCA-API-KEY-ID': apiKey,
      'APCA-API-SECRET-KEY': apiSecret,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca API error ${res.status}: ${body}`);
  }
  return res.json();
}

export async function getAccounts() {
  const account = await alpacaFetch('/v2/account');
  return {
    success: true,
    account_count: 1,
    accounts: [{
      acc_id: account.id,
      trd_env: account.status === 'ACTIVE' ? 'real' : 'inactive',
      acc_type: 'alpaca',
      markets: ['US'],
      status: account.status,
    }],
  };
}

export async function getFunds() {
  const account = await alpacaFetch('/v2/account');
  return {
    success: true,
    acc_id: account.id,
    currency: 'USD',
    cash: parseFloat(account.cash),
    total_assets: parseFloat(account.portfolio_value),
    market_val: parseFloat(account.long_market_value),
    buying_power: parseFloat(account.buying_power),
    frozen_cash: parseFloat(account.pending_transfer_out || 0),
    unrealized_pl: parseFloat(account.unrealized_pl || 0),
    realized_pl: parseFloat(account.realized_pl || 0),
  };
}

export async function getPositions() {
  const positions = await alpacaFetch('/v2/positions');
  const mapped = positions.map(p => ({
    symbol: p.symbol,
    name: p.symbol,
    market: 'US',
    qty: parseFloat(p.qty),
    avg_cost: parseFloat(p.avg_entry_price),
    current_price: parseFloat(p.current_price),
    market_val: parseFloat(p.market_value),
    unrealized_pl: parseFloat(p.unrealized_pl),
    unrealized_pl_pct: parseFloat(p.unrealized_plpc) * 100,
    realized_pl: parseFloat(p.realized_pl || 0),
  }));
  return {
    success: true,
    acc_id: 'alpaca',
    position_count: mapped.length,
    positions: mapped,
  };
}

export async function getOrders({ status = 'active' } = {}) {
  const alpacaStatus = status === 'history' ? 'all' : 'open';
  const orders = await alpacaFetch(`/v2/orders?status=${alpacaStatus}&limit=50`);
  const mapped = orders.map(o => ({
    order_id: o.id,
    symbol: o.symbol,
    name: o.symbol,
    side: o.side,
    qty: parseFloat(o.qty),
    filled_qty: parseFloat(o.filled_qty || 0),
    price: parseFloat(o.limit_price || o.stop_price || 0),
    filled_avg_price: parseFloat(o.filled_avg_price || 0),
    status: o.status,
    create_time: o.created_at,
    update_time: o.updated_at,
  }));
  return {
    success: true,
    acc_id: 'alpaca',
    status_filter: status,
    order_count: mapped.length,
    orders: mapped,
  };
}
