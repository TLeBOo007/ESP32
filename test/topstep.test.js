'use strict';
const assert = require('assert');
const { TopstepBars, parseBars } = require('../lib/topstep');
const { Feed } = require('../lib/feed');
const T0 = 1760000100;                                                        // multiple of 300
const iso = t => new Date(t * 1000).toISOString();
(async () => {
  // parsing: zone-less timestamps are UTC, order is made ascending, duplicates dropped, junk skipped
  const p = parseBars({ success: true, bars: [{ t: '2026-10-16T13:35:00', o: 2, h: 3, l: 1, c: 2.5, v: 9 }, { t: '2026-10-16T13:30:00+00:00', o: 1, h: 2, l: 1, c: 2, v: 5 }, { t: '2026-10-16T13:30:00Z', o: 1, h: 2, l: 1, c: 2 }, { t: 'x', o: 1, h: 1, l: 1, c: 1 }] });
  assert.strictEqual(p.length, 2); assert.strictEqual(p[0][0], Date.UTC(2026, 9, 16, 13, 30) / 1000); assert.strictEqual(p[1][4], 2.5);
  assert.strictEqual(parseBars({ success: true, bars: [{ t: '2026-10-16T13:35:00Z', o: 1, h: 1, l: 1, c: 1 }] }, 'end')[0][0], Date.UTC(2026, 9, 16, 13, 30) / 1000);
  assert.throws(() => parseBars({ success: false, errorMessage: 'nope' }), /nope/);

  // client: login once, contract search cached, bars request shape, 401 -> one re-login
  let clock = T0 + 3 * 3600 + 10, calls = [], expire = false;
  const all = now => { const r = []; for (let t = T0; t <= now; t += 300) r.push({ t: iso(t), o: 100 + (t - T0) / 300, h: 101 + (t - T0) / 300, l: 99 + (t - T0) / 300, c: 100.5 + (t - T0) / 300, v: 10 }); return r.reverse(); };   // newest first, like the docs example
  const post = async (url, body, headers) => {
    const path = url.replace('https://api.topstepx.com', ''); calls.push({ path, body, headers });
    if (path === '/api/Auth/loginKey') { assert.strictEqual(body.userName, 'u'); return { success: true, token: 'T' + calls.length }; }
    if (expire && path !== '/api/Auth/loginKey' && headers.Authorization === 'Bearer T1') { expire = false; throw new Error('HTTP 401'); }
    if (path === '/api/Contract/search') return { success: true, contracts: [{ id: 'CON.F.US.MNQ.H27', name: 'MNQH27', activeContract: false }, { id: 'CON.F.US.MNQ.Z26', name: 'MNQZ26', activeContract: true }] };
    if (path === '/api/History/retrieveBars') return { success: true, bars: all(clock) };
    throw new Error('unexpected ' + path);
  };
  const ts = new TopstepBars({ user: 'u', key: 'k', post, now: () => clock, log: () => {} });
  const from = T0 - 3600; let rows = await ts.bars('MNQ', from, clock);
  assert.strictEqual(rows[0][0], T0); assert(rows.length > 30);
  const rb = calls.find(c => c.path === '/api/History/retrieveBars'); assert.strictEqual(rb.body.contractId, 'CON.F.US.MNQ.Z26'); assert.strictEqual(rb.body.unit, 2); assert.strictEqual(rb.body.unitNumber, 5); assert.strictEqual(rb.body.limit, 20000); assert.strictEqual(rb.body.includePartialBar, false);
  assert(/^Bearer T\d/.test(rb.headers.Authorization)); assert(!JSON.stringify(calls.map(c => c.path)).includes('Order'));
  const n0 = calls.length; await ts.bars('MNQ', from, clock); assert.strictEqual(calls.length - n0, 1, 'token and contract are cached: only the bars call');
  expire = true; await ts.bars('MNQ', from, clock); assert(calls.filter(c => c.path === '/api/Auth/loginKey').length === 2, 're-login after 401');
  await assert.rejects(ts._post('/api/Order/place', {}, true), /read-only/);
  await assert.rejects(ts._post('/api/Order/cancel', {}, true), /read-only/);

  // as a Feed (like Yahoo): warm-up first, then forward bars, the forming bar is never used
  const state = {}, hist = [], fwd = [];
  const feed = new Feed({ kind: 'topstep', topstep: ts, symbol: 'MNQ', state, now: () => clock, save() {}, log() {}, history: r => hist.push(...r), bar: (r, ev) => fwd.push([r, ev]) });
  let r = await feed.poll(); assert.strictEqual(r.forward, 0); assert(r.history > 30); assert(hist[hist.length - 1][0] + 300 <= clock - 2);
  r = await feed.poll(); assert.strictEqual(r.fresh, 0);
  clock += 300; r = await feed.poll(); assert.strictEqual(r.forward, 1); assert.strictEqual(fwd[0][1], true);
  const bd = calls.filter(c => c.path === '/api/History/retrieveBars').pop().body; assert(Date.parse(bd.endTime) / 1000 === clock);
  clock += 300 * 3; r = await feed.poll(); assert.strictEqual(r.forward, 3);
  ts.o.post = async () => { throw new Error('HTTP 500'); }; r = await feed.poll(); assert(/500/.test(r.error));
  console.log('topstep feed tests passed'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
