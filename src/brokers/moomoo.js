/**
 * Moomoo broker adapter.
 * Wraps src/core/moomoo-tcp.js to conform to the standard broker interface.
 * Requires moomoo OpenD running locally (default: 127.0.0.1:11111).
 */
export { getAccounts, getFunds, getPositions, getOrders } from '../core/moomoo-tcp.js';
