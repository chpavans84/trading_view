import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../brokers/index.js';

export function registerMoomooTools(server) {
  server.tool(
    'moomoo_get_accounts',
    'List all Moomoo brokerage accounts connected via OpenD. Returns account IDs, environment (real/simulate), and market.',
    {},
    async () => {
      try { return jsonResult(await core.getAccounts()); }
      catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Make sure your broker is running and configured in broker.config.json and you are logged in.' }, true); }
    }
  );

  server.tool(
    'moomoo_get_funds',
    'Get account balance and buying power from Moomoo. Returns cash, total assets, market value, buying power, and P&L.',
    {
      acc_id: z.coerce.number().optional().describe('Account ID (auto-detects US account if omitted)'),
    },
    async ({ acc_id }) => {
      try { return jsonResult(await core.getFunds({ acc_id })); }
      catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Make sure your broker is running and configured in broker.config.json.' }, true); }
    }
  );

  server.tool(
    'moomoo_get_positions',
    'Get current portfolio holdings from Moomoo. Returns all positions with symbol, quantity, average cost, current price, market value, and P&L.',
    {
      acc_id: z.coerce.number().optional().describe('Account ID (auto-detects US account if omitted)'),
    },
    async ({ acc_id }) => {
      try { return jsonResult(await core.getPositions({ acc_id })); }
      catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Make sure your broker is running and configured in broker.config.json.' }, true); }
    }
  );

  server.tool(
    'moomoo_get_orders',
    'Get orders from Moomoo. Use status="active" for open orders or status="history" for past orders.',
    {
      acc_id: z.coerce.number().optional().describe('Account ID (auto-detects US account if omitted)'),
      status: z.enum(['active', 'history']).optional().describe('active = open orders, history = past orders (default: active)'),
    },
    async ({ acc_id, status }) => {
      try { return jsonResult(await core.getOrders({ acc_id, status })); }
      catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Make sure your broker is running and configured in broker.config.json.' }, true); }
    }
  );
}
