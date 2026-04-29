import { register } from '../router.js';
import * as core from '../../brokers/index.js';

register('moomoo', {
  description: 'Moomoo portfolio tools (accounts, funds, positions, orders)',
  subcommands: new Map([
    ['accounts', {
      description: 'List all connected Moomoo accounts',
      handler: () => core.getAccounts(),
    }],
    ['funds', {
      description: 'Get account balance and buying power',
      options: {
        'acc-id': { type: 'string', short: 'a', description: 'Account ID (auto-detects if omitted)' },
      },
      handler: (opts) => core.getFunds({ acc_id: opts['acc-id'] ? Number(opts['acc-id']) : undefined }),
    }],
    ['positions', {
      description: 'Get current portfolio holdings',
      options: {
        'acc-id': { type: 'string', short: 'a', description: 'Account ID (auto-detects if omitted)' },
      },
      handler: (opts) => core.getPositions({ acc_id: opts['acc-id'] ? Number(opts['acc-id']) : undefined }),
    }],
    ['orders', {
      description: 'Get orders (active or history)',
      options: {
        'acc-id': { type: 'string', short: 'a', description: 'Account ID (auto-detects if omitted)' },
        status: { type: 'string', short: 's', description: 'active or history (default: active)' },
      },
      handler: (opts) => core.getOrders({
        acc_id: opts['acc-id'] ? Number(opts['acc-id']) : undefined,
        status: opts.status || 'active',
      }),
    }],
  ]),
});
