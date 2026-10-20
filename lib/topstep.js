'use strict';
// Topstep (ProjectX gateway) as a PRICE FEED: closed M5 bars, read-only.
// Hard guarantee: only the three REST paths below can be called. Any other path (e.g. anything under /api/Order) throws before a request is made.
const ALLOWED = new Set(['/api/Auth/loginKey', '/api/Contract/search', '/api/History/retrieveBars']);
const TOKEN_MS = 20 * 3600 * 1000, CONTRACT_MS = 6 * 3600 * 1000;

function parseBars(j, label = 'start') {
  if (!j || j.success === false || !Array.isArray(j.bars)) throw new Error('Topstep bars: ' + (j && (j.errorMessage || j.errorCode) || 'bad reply'));
  const out = new Map();
  for (const b of j.bars) {
    let ts = b.t; if (typeof ts === 'string' && !/(Z|[+-]\d\d:?\d\d)$/.test(ts)) ts += 'Z';       // no zone given -> UTC
    const t = typeof ts === 'number' ? (ts > 1e12 ? ts / 1000 : ts) : Date.parse(ts) / 1000, o = +b.o, h = +b.h, l = +b.l, c = +b.c;
    if (![t, o, h, l, c].every(Number.isFinite)) continue;
    out.set(t, [label === 'end' ? t - 300 : t, o, h, l, c]);
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

class TopstepBars {
  // o: { user, key, api, live, label ('start'|'end'), post(url, body, headers) -> parsed JSON (throws on HTTP errors), now(), log }
  constructor(o) {
    this.o = o; this.api = (o.api || 'https://api.topstepx.com').replace(/\/$/, ''); this.tok = null; this.tokAt = 0; this.cs = new Map(); this.checked = false;
  }
  async _post(p, body, auth) {
    if (!ALLOWED.has(p)) throw new Error('topstep feed is read-only: path not allowed: ' + p);
    return this.o.post(this.api + p, body, auth ? { Authorization: 'Bearer ' + this.tok } : {});
  }
  async _token(force) {
    const now = this.o.now() * 1000;
    if (!force && this.tok && now - this.tokAt < TOKEN_MS) return;
    const r = await this._post('/api/Auth/loginKey', { userName: this.o.user, apiKey: this.o.key }, false);
    if (!r || !r.success || !r.token) throw new Error('Topstep login failed: ' + (r && (r.errorMessage || r.errorCode)));
    this.tok = r.token; this.tokAt = now; this.o.log('topstep: logged in');
  }
  async _contract(sym) {
    const now = this.o.now() * 1000, c = this.cs.get(sym); if (c && now - c.at < CONTRACT_MS) return c.id;
    const r = await this._post('/api/Contract/search', { searchText: sym, live: !!this.o.live }, true);
    const list = (r && r.contracts) || [];
    const hit = list.find(x => x.activeContract && (String(x.id).includes('.' + sym + '.') || String(x.name).startsWith(sym))) || list.find(x => x.activeContract);
    if (!hit) throw new Error('Topstep: no active contract for ' + sym);
    this.cs.set(sym, { id: hit.id, at: now }); this.o.log('topstep: ' + sym + ' -> ' + hit.id); return hit.id;
  }
  // closed or forming M5 bars from..to (UTC seconds); the caller (Feed) drops the forming one
  async bars(sym, from, to) {
    const run = async () => {
      await this._token(false); const id = await this._contract(sym);
      return this._post('/api/History/retrieveBars', { contractId: id, live: !!this.o.live, startTime: new Date(from * 1000).toISOString(), endTime: new Date(to * 1000).toISOString(), unit: 2, unitNumber: 5, limit: 20000, includePartialBar: false }, true);
    };
    let r;
    try { r = await run(); } catch (e) { if (!/401/.test(e.message)) throw e; await this._token(true); this.cs.clear(); r = await run(); }   // token expired: log in again once
    const rows = parseBars(r, this.o.label || 'start');
    if (!this.checked && rows.length) {
      this.checked = true; const odd = rows.filter(x => x[0] % 300 !== 0).length;
      this.o.log(`topstep bars check ${sym}: ${rows.length} bars, first ${new Date(rows[0][0] * 1000).toISOString()}, last ${new Date(rows[rows.length - 1][0] * 1000).toISOString()}` + (odd ? `, WARNING ${odd} bars not on a 5-minute boundary` : ''));
    }
    return rows;
  }
}
module.exports = { TopstepBars, parseBars, ALLOWED };
