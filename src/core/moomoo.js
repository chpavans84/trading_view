/**
 * Core logic for Moomoo OpenD API integration.
 * Connects to moomoo OpenD gateway running on localhost:11111.
 */
import MoomooAPI from 'moomoo-api';

const OPEND_HOST = '127.0.0.1';
const OPEND_PORT = 33333;

const TRD_MARKET = { HK: 1, US: 2, CN: 3, HKFUND: 4, USOption: 6 };
const TRD_ENV = { REAL: 0, SIMULATE: 1 };

async function withClient(fn) {
  const api = new MoomooAPI();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { api.stop(); } catch (_) {}
      reject(new Error('Connection to moomoo OpenD timed out. Make sure OpenD is running on port 11111.'));
    }, 10000);

    api.onlogin = (ret, msg) => {
      if (!ret) {
        clearTimeout(timeout);
        try { api.stop(); } catch (_) {}
        reject(new Error(`OpenD login failed: ${msg}`));
        return;
      }
      fn(api)
        .then(result => { clearTimeout(timeout); try { api.stop(); } catch (_) {} resolve(result); })
        .catch(err => { clearTimeout(timeout); try { api.stop(); } catch (_) {} reject(err); });
    };

    api.start(OPEND_HOST, OPEND_PORT, false, '');
  });
}

function pickUsAccount(accList) {
  const list = accList || [];
  return list.find(a => a.trdEnv === TRD_ENV.REAL)
    || list.find(a => a.trdMarket === TRD_MARKET.US)
    || list[0]
    || null;
}

export async function getAccounts() {
  return withClient(async (api) => {
    const res = await api.GetAccList({ userID: 0 });
    if (!res || res.retType !== 0) throw new Error(res?.retMsg || 'Failed to get account list');
    const accounts = (res.accList || []).map(acc => ({
      acc_id: acc.accID,
      trd_env: acc.trdEnv === TRD_ENV.REAL ? 'real' : 'simulate',
      acc_type: acc.accType,
      market: Object.keys(TRD_MARKET).find(k => TRD_MARKET[k] === acc.trdMarket) || String(acc.trdMarket),
      broker_id: acc.brokerID,
      broker_name: acc.brokerName,
    }));
    return { success: true, account_count: accounts.length, accounts };
  });
}

export async function getFunds({ acc_id } = {}) {
  return withClient(async (api) => {
    let accID = acc_id;
    let trdEnv = TRD_ENV.REAL;
    if (!accID) {
      const accRes = await api.GetAccList({ userID: 0 });
      if (!accRes || accRes.retType !== 0) throw new Error('Failed to get account list');
      const acc = pickUsAccount(accRes.accList);
      if (!acc) throw new Error('No accounts found in OpenD');
      accID = acc.accID;
      trdEnv = acc.trdEnv;
    }

    const res = await api.GetFunds({ header: { trdEnv, accID }, refreshCache: true });
    if (!res || res.retType !== 0) throw new Error(res?.retMsg || 'Failed to get funds');

    const f = res.funds || {};
    return {
      success: true,
      acc_id: accID,
      currency: f.currency || 'USD',
      cash: f.cash,
      total_assets: f.totalAssets,
      market_val: f.marketVal,
      buying_power: f.power,
      frozen_cash: f.frozenCash,
      unrealized_pl: f.unrealizedPL,
      realized_pl: f.realizedPL,
    };
  });
}

export async function getPositions({ acc_id } = {}) {
  return withClient(async (api) => {
    let accID = acc_id;
    let trdEnv = TRD_ENV.REAL;
    if (!accID) {
      const accRes = await api.GetAccList({ userID: 0 });
      if (!accRes || accRes.retType !== 0) throw new Error('Failed to get account list');
      const acc = pickUsAccount(accRes.accList);
      if (!acc) throw new Error('No accounts found in OpenD');
      accID = acc.accID;
      trdEnv = acc.trdEnv;
    }

    const res = await api.GetPositionList({ header: { trdEnv, accID }, refreshCache: true });
    if (!res || res.retType !== 0) throw new Error(res?.retMsg || 'Failed to get positions');

    const positions = (res.positionList || []).map(p => ({
      symbol: p.code,
      name: p.name,
      qty: p.qty,
      avg_cost: p.costPrice,
      current_price: p.price,
      market_val: p.val,
      unrealized_pl: p.unrealizedPL,
      unrealized_pl_pct: p.unrealizedPLRatio ? +(p.unrealizedPLRatio * 100).toFixed(2) : null,
      realized_pl: p.realizedPL,
      today_pl: p.PLOfDay,
    }));

    return { success: true, acc_id: accID, position_count: positions.length, positions };
  });
}

export async function getOrders({ acc_id, status = 'active' } = {}) {
  return withClient(async (api) => {
    let accID = acc_id;
    let trdEnv = TRD_ENV.REAL;
    if (!accID) {
      const accRes = await api.GetAccList({ userID: 0 });
      if (!accRes || accRes.retType !== 0) throw new Error('Failed to get account list');
      const acc = pickUsAccount(accRes.accList);
      if (!acc) throw new Error('No accounts found in OpenD');
      accID = acc.accID;
      trdEnv = acc.trdEnv;
    }

    const req = { header: { trdEnv, accID }, filterConditions: {} };
    const res = status === 'history'
      ? await api.GetHistoryOrderList(req)
      : await api.GetOrderList(req);

    if (!res || res.retType !== 0) throw new Error(res?.retMsg || 'Failed to get orders');

    const orders = (res.orderList || []).map(o => ({
      order_id: o.orderID,
      symbol: o.code,
      name: o.name,
      side: o.trdSide === 1 ? 'buy' : 'sell',
      qty: o.qty,
      filled_qty: o.fillQty,
      price: o.price,
      filled_avg_price: o.fillAvgPrice,
      status: o.orderStatusDesc,
      create_time: o.createTime,
      update_time: o.updateTime,
    }));

    return { success: true, acc_id: accID, status_filter: status, order_count: orders.length, orders };
  });
}
