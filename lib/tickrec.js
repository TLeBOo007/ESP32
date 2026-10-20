'use strict';
// Footprint recorder: ProjectX (Topstep) market hub -> 5-minute footprint bars (bid/ask volume per price level).
// DATA ONLY: it never sends orders. Bars are appended to <dir>/YYYYMMDD.jsonl (UTC day) when they close.
// Buckets are 5 minutes aligned to UTC, which are also NY-aligned. type 0 = buyer-initiated (hits the ask), 1 = seller-initiated.
const fs = require('fs');
const path = require('path');
const BAR_MS = 5 * 60 * 1000;
// Hard guarantee: this module is read-only. It may call ONLY these REST paths and hub methods; anything else throws before it leaves the process.
const ALLOWED_REST = new Set(['/api/Auth/loginKey', '/api/Contract/search']);
const ALLOWED_HUB = new Set(['SubscribeContractTrades']);

class FootprintBuilder {
  constructor(tick) { this.tick = tick || 0.25; this.cur = null; this.done = []; }
  add(tsMs, price, vol, type) {
    if (!(tsMs > 0) || !(price > 0) || !(vol > 0)) return null;
    const b = Math.floor(tsMs / BAR_MS) * BAR_MS; let closed = null;
    if (this.cur && b > this.cur.t) { closed = this._close(); }
    if (this.cur && b < this.cur.t) return null;                       // late out-of-order trade: ignored (counted by the caller)
    if (!this.cur) this.cur = { t: b, o: price, h: price, l: price, c: price, n: 0, lv: new Map() };
    const c = this.cur; c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price; c.n++;
    const k = Math.round(price / this.tick); let v = c.lv.get(k); if (!v) c.lv.set(k, v = [0, 0]);
    if (type === 1) v[0] += vol; else v[1] += vol;                      // [bid(sell) , ask(buy)]
    return closed;
  }
  flush(nowMs) { return this.cur && Math.floor(nowMs / BAR_MS) * BAR_MS > this.cur.t ? this._close() : null; }
  _close() { const c = this.cur; this.cur = null; const o = summarize(c, this.tick); this.done.push(o); if (this.done.length > 600) this.done.shift(); return o; }
}
// diagonal imbalance 3:1 (min 5 contracts), stacked runs, delta, POC - same rules as the research scripts
function summarize(c, tick) {
  const keys = [...c.lv.keys()].sort((a, b) => a - b); const lo = keys[0], hi = keys[keys.length - 1];
  const B = [], A = []; for (let k = lo; k <= hi; k++) { const v = c.lv.get(k) || [0, 0]; B.push(v[0]); A.push(v[1]); }
  let poc = 0, pv = -1, bidT = 0, askT = 0; const bi = [], si = [];
  for (let i = 0; i < B.length; i++) {
    bidT += B[i]; askT += A[i]; if (B[i] + A[i] > pv) { pv = B[i] + A[i]; poc = i; }
    bi.push(i > 0 && A[i] >= 5 && A[i] >= 3 * Math.max(B[i - 1], 1));
    si.push(i < B.length - 1 && B[i] >= 5 && B[i] >= 3 * Math.max(A[i + 1], 1));
  }
  const run = m => { let b = 0, x = 0; for (const v of m) { x = v ? x + 1 : 0; if (x > b) b = x; } return b; };
  const lv = {}; for (const k of keys) lv[k] = c.lv.get(k);
  return { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, n: c.n, vol: bidT + askT, delta: askT - bidT, poc: (lo + poc) * tick, stackBuy: run(bi), stackSell: run(si), tick, lv };
}

class TickRec {
  constructor(o) {
    this.user = o.user; this.key = o.key; this.api = (o.api || 'https://api.topstepx.com').replace(/\/$/, ''); this.hub = o.hub || 'https://rtc.topstepx.com/hubs/market';
    this.symbol = o.symbol || 'MNQ'; this.dir = o.dir; this.log = o.log || (() => {}); this.now = o.now || (() => Date.now());
    this.fetchJson = o.fetchJson; this.signalR = o.signalR;             // injectable for tests
    this.fb = new FootprintBuilder(o.tick || 0.25);
    this.st = { state: 'idle', contract: null, trades: 0, buys: 0, sells: 0, late: 0, lastTradeMs: 0, lastErr: null, logins: 0, reconnects: 0, bars: 0, sideAgree: 0, sideTotal: 0 };
    this.lastPx = 0; this.conn = null; this.timers = [];
    if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
  }
  onTrade(contractId, d) {
    for (const t of (Array.isArray(d) ? d : [d])) {
      if (!t) continue; const ts = Date.parse(t.timestamp), px = +t.price, vol = +t.volume, ty = +t.type;
      if (!(ts > 0) || !(px > 0) || !(vol > 0) || (ty !== 0 && ty !== 1)) continue;
      this.st.trades++; if (ty === 0) this.st.buys += vol; else this.st.sells += vol; this.st.lastTradeMs = ts;
      if (this.lastPx && px !== this.lastPx) { this.st.sideTotal++; if ((px > this.lastPx) === (ty === 0)) this.st.sideAgree++; }   // sanity check: up-ticks should be buys
      this.lastPx = px;
      const before = this.fb.cur; const closed = this.fb.add(ts, px, vol, ty);
      if (!closed && before && ts < before.t) this.st.late++;
      if (closed) this._saved(closed);
    }
  }
  _saved(bar) {
    this.st.bars++;
    if (!this.dir) return;
    const day = new Date(bar.t).toISOString().slice(0, 10).replace(/-/g, '');
    try { fs.appendFileSync(path.join(this.dir, day + '.jsonl'), JSON.stringify(bar) + '\n'); } catch (e) { this.st.lastErr = 'write: ' + e.message; this.log('tickrec write failed ' + e.message); }
  }
  tickFlush() { const c = this.fb.flush(this.now()); if (c) this._saved(c); }
  bars(n = 100) { return this.fb.done.slice(-n); }
  day(ymd) {
    if (!this.dir || !/^\d{8}$/.test(ymd)) return [];
    try { return fs.readFileSync(path.join(this.dir, ymd + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; }
  }
  days() { try { return fs.readdirSync(this.dir).filter(f => /^\d{8}\.jsonl$/.test(f)).map(f => f.slice(0, 8)).sort(); } catch (e) { return []; } }
  prune(keepDays = 90) { for (const d of this.days().slice(0, -keepDays)) try { fs.unlinkSync(path.join(this.dir, d + '.jsonl')); } catch (e) { /* ignore */ } }
  status() {
    const s = this.st, ageS = s.lastTradeMs ? Math.round((this.now() - s.lastTradeMs) / 1000) : null;
    return { ...s, lastTradeAgeSec: ageS, sidePct: s.sideTotal ? Math.round(1000 * s.sideAgree / s.sideTotal) / 10 : null, symbol: this.symbol, days: this.days().length, forming: this.fb.cur ? { t: this.fb.cur.t, n: this.fb.cur.n } : null };
  }
  async _post(p, body, tok) {
    if (!ALLOWED_REST.has(p)) throw new Error('tickrec is read-only: REST path not allowed: ' + p);
    const r = await this.fetchJson(this.api + p, { method: 'POST', headers: { 'Content-Type': 'application/json', accept: 'text/plain', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
    return r;
  }
  async connect() {
    this.st.state = 'login';
    const lg = await this._post('/api/Auth/loginKey', { userName: this.user, apiKey: this.key });
    if (!lg || !lg.success) throw new Error('login failed ' + (lg && (lg.errorCode + ' ' + lg.errorMessage)));
    this.st.logins++; const token = lg.token;
    const cs = await this._post('/api/Contract/search', { searchText: this.symbol, live: false }, token);
    const list = (cs && cs.contracts) || []; const c = list.find(x => x.activeContract) || list[0];
    if (!c) throw new Error('no contract for ' + this.symbol);
    this.st.contract = c.id; if (c.tickSize > 0 && !this.fb.cur) this.fb.tick = c.tickSize;
    const conn = new this.signalR.HubConnectionBuilder()
      .withUrl(this.hub + '?access_token=' + token, { skipNegotiation: true, transport: this.signalR.HttpTransportType.WebSockets, accessTokenFactory: () => token })
      .withAutomaticReconnect().build();
    conn.on('GatewayTrade', (cid, d) => this.onTrade(cid, d));
    conn.onreconnecting(() => { this.st.state = 'reconnecting'; });
    conn.onreconnected(async () => { this.st.reconnects++; try { await this._invoke(conn, 'SubscribeContractTrades', c.id); this.st.state = 'live'; } catch (e) { this.st.lastErr = e.message; } });
    conn.onclose(() => { if (conn === this.conn && this.st.state !== 'stopping') { this.st.state = 'closed'; this._retry(30000); } });
    await conn.start();
    const old = this.conn; this.conn = conn; if (old) { try { await old.stop(); } catch (e) { /* ignore */ } }     // stop the old one first so no trade is counted twice
    await this._invoke(conn, 'SubscribeContractTrades', c.id);
    this.st.state = 'live'; this.st.lastErr = null; this.log('tickrec live on ' + c.id + ' tick ' + this.fb.tick);
  }
  _invoke(conn, m, ...a) { if (!ALLOWED_HUB.has(m)) throw new Error('tickrec is read-only: hub method not allowed: ' + m); return conn.invoke(m, ...a); }
  _retry(ms) { const t = setTimeout(() => this.start(), ms); t.unref && t.unref(); this.timers.push(t); }
  async start() {
    try { await this.connect(); }
    catch (e) { this.st.state = 'error'; this.st.lastErr = e.message; this.log('tickrec error: ' + e.message); this._retry(60000); return; }
    if (!this._loops) {
      this._loops = true;
      for (const [fn, ms] of [[() => this.tickFlush(), 15000], [() => this.prune(), 6 * 3600 * 1000], [() => { this.connect().catch(e => { this.st.lastErr = e.message; }); }, 11 * 3600 * 1000]]) {   // re-login before the token expires
        const t = setInterval(fn, ms); t.unref && t.unref(); this.timers.push(t);
      }
    }
  }
  async stop() { this.st.state = 'stopping'; for (const t of this.timers) { clearInterval(t); clearTimeout(t); } this.timers = []; if (this.conn) try { await this.conn.stop(); } catch (e) { /* ignore */ } }
}
module.exports = { ALLOWED_REST, ALLOWED_HUB, TickRec, FootprintBuilder, summarize, BAR_MS };
