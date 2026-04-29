import net from 'net';
import crypto from 'crypto';
import protobuf from 'protobufjs';
import long from 'long';
import protoRoot from '../../node_modules/moomoo-api/proto.js';

protobuf.util.Long = long;
protobuf.configure();

const OPEND_HOST = process.env.MOOMOO_OPEND_HOST || '127.0.0.1';
const OPEND_PORT = parseInt(process.env.MOOMOO_OPEND_PORT) || 11111;
const CLIENT_VER = 603;
const CLIENT_ID = 'tradingview-mcp-node';

const PROTO = {
  InitConnect:          1001,
  GetGlobalState:       1002,
  // Quote (Qot)
  QotSub:               3001,
  GetBasicQot:          3004,
  GetKL:                3006,
  GetOrderBook:         3014,
  // Trade (Trd)
  GetAccList:           2001,
  GetFunds:             2101,
  GetPositionList:      2102,
  GetOrderList:         2201,
  GetHistoryOrderList:  2221,
};

const QOT_MARKET = { US: 11, HK: 1, HK_FUTURE: 2 };
// SubType enum (for Qot_Sub subscriptions)
const SUB_TYPE   = { Basic: 1, OrderBook: 2, Ticker: 4, RT: 5, KL_Day: 6, KL_5Min: 7, KL_15Min: 8, KL_1Min: 11 };
// KLType enum (for Qot_GetKL requests) — different numbering from SubType!
const KL_TYPE    = { KL_1Min: 1, KL_Day: 2, KL_5Min: 6, KL_15Min: 7, KL_30Min: 8, KL_60Min: 9 };
const REHAB_TYPE = { None: 0, Forward: 1 };
const TRD_MARKET = { HK: 1, US: 2, CN: 3, HKFUND: 4, USOption: 6 };
const TRD_ENV    = { SIMULATE: 0, REAL: 1 };

// Simple LRU-style quote cache (30s TTL) to avoid hammering OpenD
const quoteCache = new Map();
const QUOTE_TTL_MS = 30_000;

function buildPacket(protoID, serial, bodyBytes) {
  const headerLen = 44;
  const bodyLen = bodyBytes ? bodyBytes.length : 0;
  const buf = Buffer.alloc(headerLen + bodyLen);

  buf[0] = 0x46; // 'F'
  buf[1] = 0x54; // 'T'
  buf.writeUInt32LE(protoID, 2);
  buf[6] = 0; // protobuf format
  buf[7] = 0; // API version
  buf.writeUInt32LE(serial, 8);
  buf.writeUInt32LE(bodyLen, 12);

  if (bodyLen > 0) {
    const sha1 = crypto.createHash('sha1').update(bodyBytes).digest();
    sha1.copy(buf, 16);
    bodyBytes.copy(buf, headerLen);
  }
  // bytes 36-43: reserved (zeros)
  return buf;
}

function parseHeader(buf) {
  if (buf.length < 44) return null;
  if (buf[0] !== 0x46 || buf[1] !== 0x54) return null; // 'F', 'T'
  return {
    protoID: buf.readUInt32LE(2),
    serial: buf.readUInt32LE(8),
    bodyLen: buf.readUInt32LE(12),
  };
}

class FutuTCPClient {
  constructor() {
    this.socket = null;
    this.serial = 0;
    this.pending = new Map();
    this.recvBuf = Buffer.alloc(0);
    this.connID = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TCP connection timed out')), 10000);
      this.socket = new net.Socket();

      this.socket.on('data', (data) => {
        this.recvBuf = Buffer.concat([this.recvBuf, data]);
        this._processBuffer();
      });

      this.socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      this.socket.on('close', () => {
        for (const [, cb] of this.pending) {
          cb.reject(new Error('Connection closed'));
        }
        this.pending.clear();
      });

      this.socket.connect(OPEND_PORT, OPEND_HOST, async () => {
        clearTimeout(timer);
        try {
          await this._initConnect();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  _processBuffer() {
    while (this.recvBuf.length >= 44) {
      const header = parseHeader(this.recvBuf);
      if (!header) break;
      if (this.recvBuf.length < 44 + header.bodyLen) break;

      const body = this.recvBuf.slice(44, 44 + header.bodyLen);
      this.recvBuf = this.recvBuf.slice(44 + header.bodyLen);

      const cb = this.pending.get(header.serial);
      if (cb) {
        this.pending.delete(header.serial);
        cb.resolve({ protoID: header.protoID, body });
      }
    }
  }

  send(protoID, msgBytes) {
    const serial = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(new Error(`Request ${protoID} timed out`));
      }, 10000);

      this.pending.set(serial, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      const pkt = buildPacket(protoID, serial, msgBytes ? Buffer.from(msgBytes) : null);
      this.socket.write(pkt);
    });
  }

  async _initConnect() {
    const Req = protoRoot.lookup('InitConnect.Request');
    const Resp = protoRoot.lookup('InitConnect.Response');
    const msg = Req.encode(Req.create({
      c2s: { clientVer: CLIENT_VER, clientID: CLIENT_ID, recvNotify: false, programmingLanguage: 'JavaScript' }
    })).finish();

    const { body } = await this.send(PROTO.InitConnect, msg);
    const resp = Resp.decode(body);
    if (resp.retType !== 0) throw new Error(`InitConnect failed: ${resp.retMsg}`);
    this.connID = resp.s2c.connID;
  }

  async sendProto(protoID, ReqType, RespType, reqData) {
    const Req = protoRoot.lookup(ReqType);
    const Resp = protoRoot.lookup(RespType);
    const msg = Req.encode(Req.create(reqData)).finish();
    const { body } = await this.send(protoID, msg);
    const resp = Resp.decode(body);
    return resp;
  }

  close() {
    if (this.socket) this.socket.destroy();
  }
}

async function withClient(fn) {
  const client = new FutuTCPClient();
  try {
    await client.connect();
    return await fn(client);
  } finally {
    client.close();
  }
}

async function pickUSAccount(client) {
  const resp = await client.sendProto(
    PROTO.GetAccList,
    'Trd_GetAccList.Request',
    'Trd_GetAccList.Response',
    { c2s: { userID: 0, needGeneralSecAccount: true } }
  );
  if (resp.retType !== 0) throw new Error(resp.retMsg || 'Failed to get account list');
  const list = resp.s2c.accList || [];
  // Prefer real US stock account, then any US account, then any real account
  return list.find(a => a.trdEnv === TRD_ENV.REAL && (a.trdMarketAuthList || []).includes(TRD_MARKET.US))
    || list.find(a => a.trdEnv === TRD_ENV.REAL)
    || list.find(a => (a.trdMarketAuthList || []).includes(TRD_MARKET.US))
    || list[0] || null;
}

export async function getAccounts() {
  return withClient(async (client) => {
    const resp = await client.sendProto(
      PROTO.GetAccList,
      'Trd_GetAccList.Request',
      'Trd_GetAccList.Response',
      { c2s: { userID: 0, needGeneralSecAccount: true } }
    );
    if (resp.retType !== 0) throw new Error(resp.retMsg || 'Failed to get account list');
    const accounts = (resp.s2c.accList || []).map(a => ({
      acc_id: a.accID.toString(),
      trd_env: a.trdEnv === TRD_ENV.REAL ? 'real' : 'simulate',
      acc_type: a.accType,
      markets: (a.trdMarketAuthList || []).map(m => Object.keys(TRD_MARKET).find(k => TRD_MARKET[k] === m) || String(m)),
    }));
    return { success: true, account_count: accounts.length, accounts };
  });
}

export async function getFunds({ acc_id } = {}) {
  return withClient(async (client) => {
    let accID = acc_id;
    let trdEnv = TRD_ENV.REAL;
    if (!accID) {
      const acc = await pickUSAccount(client);
      if (!acc) throw new Error('No accounts found in OpenD');
      accID = acc.accID;
      trdEnv = acc.trdEnv;
    }

    const resp = await client.sendProto(
      PROTO.GetFunds,
      'Trd_GetFunds.Request',
      'Trd_GetFunds.Response',
      { c2s: { header: { trdEnv, accID }, currency: 2, refreshCache: true } }
    );
    if (resp.retType !== 0) throw new Error(resp.retMsg || 'Failed to get funds');

    const f = resp.s2c.funds || {};
    return {
      success: true, acc_id: accID.toString(),
      currency: f.currency || 'USD',
      cash: f.cash, total_assets: f.totalAssets,
      market_val: f.marketVal, buying_power: f.power,
      frozen_cash: f.frozenCash,
      unrealized_pl: f.unrealizedPL, realized_pl: f.realizedPL,
    };
  });
}

// market: 'US' | 'HK' | 'all'  (default 'all' so dashboard shows complete P&L)
export async function getPositions({ acc_id, market = 'all' } = {}) {
  return withClient(async (client) => {
    let accID = acc_id;
    let trdEnv = TRD_ENV.REAL;
    if (!accID) {
      const acc = await pickUSAccount(client);
      if (!acc) throw new Error('No accounts found in OpenD');
      accID = acc.accID;
      trdEnv = acc.trdEnv;
    }

    // Fetch US positions — Moomoo returns the same holdings regardless of market filter
    const resp = await client.sendProto(
      PROTO.GetPositionList,
      'Trd_GetPositionList.Request',
      'Trd_GetPositionList.Response',
      { c2s: { header: { trdEnv, accID, trdMarket: TRD_MARKET.US }, refreshCache: true } }
    );
    if (resp.retType !== 0) throw new Error(resp.retMsg || 'Failed to get positions');

    // Deduplicate by symbol in case OpenD returns duplicates
    const seen = new Set();
    const positions = (resp.s2c.positionList || [])
      .filter(p => { if (seen.has(p.code)) return false; seen.add(p.code); return true; })
      .map(p => ({
        symbol:            p.code,
        name:              p.name,
        market:            'US',
        qty:               p.qty,
        avg_cost:          p.costPrice,
        current_price:     p.price,
        market_val:        p.val,
        unrealized_pl:     p.unrealizedPL,
        unrealized_pl_pct: p.unrealizedPLRatio != null ? +(p.unrealizedPLRatio * 100).toFixed(2) : null,
        realized_pl:       p.realizedPL,
        today_pl:          p.PLOfDay,
      }));

    const totalUnrealizedPL = +positions.reduce((s, p) => s + (p.unrealized_pl || 0), 0).toFixed(2);
    const totalMarketVal    = +positions.reduce((s, p) => s + (p.market_val    || 0), 0).toFixed(2);

    return {
      success: true,
      acc_id: accID.toString(),
      position_count: positions.length,
      total_unrealized_pl: totalUnrealizedPL,
      total_market_val: totalMarketVal,
      positions,
    };
  });
}

export async function getOrders({ acc_id, status = 'active' } = {}) {
  return withClient(async (client) => {
    let accID = acc_id;
    let trdEnv = TRD_ENV.REAL;
    if (!accID) {
      const acc = await pickUSAccount(client);
      if (!acc) throw new Error('No accounts found in OpenD');
      accID = acc.accID;
      trdEnv = acc.trdEnv;
    }

    const protoID = status === 'history' ? PROTO.GetHistoryOrderList : PROTO.GetOrderList;
    const ReqType = status === 'history' ? 'Trd_GetHistoryOrderList.Request' : 'Trd_GetOrderList.Request';
    const RespType = status === 'history' ? 'Trd_GetHistoryOrderList.Response' : 'Trd_GetOrderList.Response';

    // GetHistoryOrderList requires beginTime/endTime; GetOrderList does not
    const toMoomooTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
    const now   = new Date();
    const begin = new Date(now); begin.setDate(begin.getDate() - 90); // last 90 days
    const filterConditions = status === 'history'
      ? { beginTime: toMoomooTime(begin), endTime: toMoomooTime(now) }
      : {};

    const resp = await client.sendProto(protoID, ReqType, RespType,
      { c2s: { header: { trdEnv, accID }, filterConditions } }
    );
    if (resp.retType !== 0) throw new Error(resp.retMsg || 'Failed to get orders');

    const orders = (resp.s2c.orderList || []).map(o => ({
      order_id: o.orderID, symbol: o.code, name: o.name,
      side: o.trdSide === 1 ? 'buy' : 'sell',
      qty: o.qty, filled_qty: o.fillQty, price: o.price,
      filled_avg_price: o.fillAvgPrice, status: o.orderStatusDesc,
      create_time: o.createTime, update_time: o.updateTime,
    }));

    return { success: true, acc_id: accID.toString(), status_filter: status, order_count: orders.length, orders };
  });
}

// ─── Quote helpers ────────────────────────────────────────────────────────────

function usSecurity(ticker) {
  return { market: QOT_MARKET.US, code: ticker.toUpperCase() };
}

async function qotSub(client, tickers, subTypes, subscribe = true) {
  const resp = await client.sendProto(
    PROTO.QotSub, 'Qot_Sub.Request', 'Qot_Sub.Response',
    { c2s: { securityList: tickers.map(usSecurity), subTypeList: subTypes, isSubOrUnSub: subscribe } }
  );
  if (resp.retType !== 0) throw new Error(resp.retMsg || 'Qot_Sub failed');
}

/**
 * Get real-time basic quotes for one or more US stock symbols.
 * Returns bid/ask, last price, open/high/low, volume, change%.
 * Results cached 30s to avoid hammering OpenD.
 */
export async function getQuotes(symbols) {
  const tickers = (Array.isArray(symbols) ? symbols : [symbols]).map(s => s.toUpperCase());

  // Return cached if all symbols are fresh
  const now = Date.now();
  const cached = tickers.map(t => quoteCache.get(t)).filter(Boolean);
  if (cached.length === tickers.length && cached.every(c => now - c.ts < QUOTE_TTL_MS)) {
    return { success: true, source: 'moomoo_cache', quotes: cached.map(c => c.data) };
  }

  return withClient(async (client) => {
    await qotSub(client, tickers, [SUB_TYPE.Basic]);

    const resp = await client.sendProto(
      PROTO.GetBasicQot, 'Qot_GetBasicQot.Request', 'Qot_GetBasicQot.Response',
      { c2s: { securityList: tickers.map(usSecurity) } }
    );
    if (resp.retType !== 0) throw new Error(resp.retMsg || 'GetBasicQot failed');

    const quotes = (resp.s2c?.basicQotList || []).map(q => {
      const changePct = q.lastClosePrice > 0
        ? +((q.curPrice - q.lastClosePrice) / q.lastClosePrice * 100).toFixed(3)
        : 0;
      const result = {
        symbol:      q.security?.code || '',
        name:        q.name || '',
        price:       q.curPrice,
        open:        q.openPrice,
        high:        q.highPrice,
        low:         q.lowPrice,
        prev_close:  q.lastClosePrice,
        change_pct:  changePct,
        volume:      q.volume ? Number(q.volume) : 0,
        update_time: q.updateTime,
        suspended:   q.isSuspended,
        pre_market:  q.preMarket  ? { price: q.preMarket.price,  change_pct: q.preMarket.changeRate  } : null,
        after_market: q.afterMarket ? { price: q.afterMarket.price, change_pct: q.afterMarket.changeRate } : null,
      };
      quoteCache.set(result.symbol, { ts: Date.now(), data: result });
      return result;
    });

    await qotSub(client, tickers, [SUB_TYPE.Basic], false).catch(() => {});
    return { success: true, source: 'moomoo', quotes };
  });
}

/**
 * Get a single real-time quote — convenience wrapper around getQuotes().
 */
export async function getQuote(symbol) {
  const result = await getQuotes([symbol]);
  const q = result.quotes?.[0] ?? null;
  if (!q) return { success: false, error: 'No quote returned' };
  return { success: true, source: result.source, ...q };
}

/**
 * Get intraday or daily K-line (OHLCV) candles for ATR and technical calculations.
 * klType: '1min' | '5min' | '15min' | 'day'   count: number of bars (max 1000)
 */
export async function getKLines({ symbol, klType = 'day', count = 20 } = {}) {
  // KL_TYPE (GetKL request) and SUB_TYPE (subscription) use different numbering
  const klTypeInt  = { '1min': KL_TYPE.KL_1Min,  '5min': KL_TYPE.KL_5Min,  '15min': KL_TYPE.KL_15Min,  'day': KL_TYPE.KL_Day  }[klType] ?? KL_TYPE.KL_Day;
  const subTypeInt = { '1min': SUB_TYPE.KL_1Min,  '5min': SUB_TYPE.KL_5Min, '15min': SUB_TYPE.KL_15Min, 'day': SUB_TYPE.KL_Day }[klType] ?? SUB_TYPE.KL_Day;

  return withClient(async (client) => {
    await qotSub(client, [symbol], [subTypeInt]);

    const resp = await client.sendProto(
      PROTO.GetKL, 'Qot_GetKL.Request', 'Qot_GetKL.Response',
      { c2s: { rehabType: REHAB_TYPE.Forward, klType: klTypeInt, security: usSecurity(symbol), reqNum: count } }
    );
    if (resp.retType !== 0) throw new Error(resp.retMsg || 'GetKL failed');

    const candles = (resp.s2c?.klList || []).map(k => ({
      time:       k.time,
      open:       k.openPrice,
      high:       k.highPrice,
      low:        k.lowPrice,
      close:      k.closePrice,
      prev_close: k.lastClosePrice,
      volume:     k.volume ? Number(k.volume) : 0,
      change_pct: k.changeRate != null ? +k.changeRate.toFixed(3) : null,
    }));

    await qotSub(client, [symbol], [subTypeInt], false).catch(() => {});
    return { success: true, source: 'moomoo', symbol: symbol.toUpperCase(), kl_type: klType, candles };
  });
}

/**
 * Calculate ATR% from recent daily candles using Moomoo data.
 * Returns atr_pct (average true range as % of price) over last `period` days.
 */
export async function getAtrPct({ symbol, period = 14 } = {}) {
  const result = await getKLines({ symbol, klType: 'day', count: period + 1 });
  if (!result.success || result.candles.length < 2) return null;

  const candles = result.candles;
  let trSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  const atr = trSum / (candles.length - 1);
  const lastPrice = candles[candles.length - 1].close;
  return lastPrice > 0 ? +(atr / lastPrice * 100).toFixed(3) : null;
}
