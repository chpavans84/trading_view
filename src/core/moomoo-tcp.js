import net from 'net';
import crypto from 'crypto';
import protobuf from 'protobufjs';
import long from 'long';
import protoRoot from '../../node_modules/moomoo-api/proto.js';

protobuf.util.Long = long;
protobuf.configure();

const OPEND_HOST = '127.0.0.1';
const OPEND_PORT = 11111;
const CLIENT_VER = 603;
const CLIENT_ID = 'tradingview-mcp-node';

const PROTO = {
  InitConnect: 1001,
  GetGlobalState: 1002,
  GetAccList: 2001,
  GetFunds: 2101,
  GetPositionList: 2102,
  GetOrderList: 2201,
  GetHistoryOrderList: 2221,
};

const TRD_MARKET = { HK: 1, US: 2, CN: 3, HKFUND: 4, USOption: 6 };
const TRD_ENV = { SIMULATE: 0, REAL: 1 };

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
    { c2s: { userID: 0 } }
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
      { c2s: { userID: 0 } }
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
      { c2s: { header: { trdEnv, accID }, currency: 1, refreshCache: true } }
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

export async function getPositions({ acc_id } = {}) {
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
      PROTO.GetPositionList,
      'Trd_GetPositionList.Request',
      'Trd_GetPositionList.Response',
      { c2s: { header: { trdEnv, accID, trdMarket: TRD_MARKET.US }, refreshCache: true } }
    );
    if (resp.retType !== 0) throw new Error(resp.retMsg || 'Failed to get positions');

    const positions = (resp.s2c.positionList || []).map(p => ({
      symbol: p.code, name: p.name, qty: p.qty,
      avg_cost: p.costPrice, current_price: p.price,
      market_val: p.val, unrealized_pl: p.unrealizedPL,
      unrealized_pl_pct: p.unrealizedPLRatio ? +(p.unrealizedPLRatio * 100).toFixed(2) : null,
      realized_pl: p.realizedPL, today_pl: p.PLOfDay,
    }));

    return { success: true, acc_id: accID.toString(), position_count: positions.length, positions };
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

    const resp = await client.sendProto(protoID, ReqType, RespType,
      { c2s: { header: { trdEnv, accID }, filterConditions: {} } }
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
