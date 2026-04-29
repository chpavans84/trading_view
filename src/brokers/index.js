/**
 * Active broker loader.
 * Reads broker.config.json at project root and exports the configured broker's functions.
 * Change "broker" in broker.config.json to switch platforms — no code changes needed.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getActiveBroker() {
  try {
    const configPath = join(__dirname, '..', '..', 'broker.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return (config.broker || 'moomoo').toLowerCase().trim();
  } catch {
    return 'moomoo';
  }
}

const BROKERS = {
  moomoo: () => import('./moomoo.js'),
  alpaca: () => import('./alpaca.js'),
};

const brokerName = getActiveBroker();
const loader = BROKERS[brokerName];

if (!loader) {
  throw new Error(`Unknown broker "${brokerName}" in broker.config.json. Valid options: ${Object.keys(BROKERS).join(', ')}`);
}

const broker = await loader();

export const getAccounts = broker.getAccounts;
export const getFunds = broker.getFunds;
export const getPositions = broker.getPositions;
export const getOrders = broker.getOrders;
export const BROKER_NAME = brokerName;
