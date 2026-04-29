/**
 * Standard broker adapter interface.
 * Every broker module must export these 4 functions with these signatures.
 *
 * getAccounts()                    → { success, account_count, accounts[] }
 * getFunds({ acc_id? })            → { success, acc_id, cash, total_assets, buying_power, currency, unrealized_pl, realized_pl }
 * getPositions({ acc_id? })        → { success, acc_id, position_count, positions[] }
 * getOrders({ acc_id?, status? })  → { success, acc_id, order_count, orders[], status_filter }
 *
 * positions[] shape:
 *   { symbol, name, market?, qty, avg_cost, current_price, market_val, unrealized_pl, realized_pl }
 *
 * orders[] shape:
 *   { order_id, symbol, side, qty, filled_qty, price, filled_avg_price, status, create_time }
 *
 * Adding a new broker:
 *   1. Create src/brokers/<name>.js implementing all 4 exports above
 *   2. Add it to the registry in src/brokers/index.js
 *   3. Set "broker": "<name>" in broker.config.json
 */
