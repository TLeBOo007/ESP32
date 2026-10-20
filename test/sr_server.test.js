'use strict';
// End to end: history import, one closed M5 bar through /tv, the SR strategy signals and trades by itself in an exam account.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
process.env.API_KEY = 'test-key-0123456789'; process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-')); process.env.TEST_MODE = '1';
Object.assign(process.env, { EXAM: '1', SYMBOLS: 'US100', START_BALANCE: '25000', EXAM_TARGET: '1250', EXAM_MLL: '1000', EXAM_CONSISTENCY: '50', EXAM_RISK_PCT: '1', LINE_CHANNEL_TOKEN: '' });
delete process.env.STRATEGY;                                              // default = sr
const { server } = require('../server');
const { Sr } = require('../lib/sr');
const { serverToUtc } = require('../lib/timeutil');
const K = process.env.API_KEY, SRV = 7 * 3600;
let base;
async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': K }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(p + ' ' + r.status + ' ' + JSON.stringify(j)); return j;
}
const ny = (d, h, mi) => Date.UTC(2026, 9, d, h, mi) / 1000;
function make(from, to, p0, slope) { const rows = []; let p = p0, k = 0; for (let t = from; t < to; t += 300, k++) { const o = p, c = p0 + slope * (k + 1) + 0.4 * Math.sin(k / 3); p = c; rows.push([t, o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c]); } return rows; }
async function bar(nyT, o, h, l, c) {
  const t = nyT + SRV; await call('POST', '/api/test/now', { utc: serverToUtc(t) + 300 });
  const r = await fetch(base + '/tv?key=' + K, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'bar', serverTime: true, t, o, h, l, c, sym: 'US100' }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j;
}
(async () => {
  await new Promise(r => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;
  const rows = make(ny(5, 18, 0), ny(14, 10, 0), 20000, 0.5);                       // uptrend, Mon 5 Oct 18:00 -> Wed 14 Oct 09:55 New York
  const h = await call('POST', '/api/history', { serverTime: true, sym: 'US100', bars: rows.map(r => [r[0] + SRV, r[1], r[2], r[3], r[4]]) });
  assert.strictEqual(h.added, rows.length);
  const ref = new Sr(); for (const r of rows) ref.addHistory(r[0] + SRV, r[1], r[2], r[3], r[4]);
  const lv = ref._levels(Math.floor(ny(14, 10, 0) / 86400)), L = lv.ONL, prevC = rows[rows.length - 1][4];
  assert(prevC > L);
  const res = await bar(ny(14, 10, 0), prevC, prevC + 1, L - 0.5, L + 1);          // touches the overnight low and closes back above it
  assert.strictEqual(res.signals, 1, 'one signal');
  const sg = (await call('GET', '/api/signals')).signals; assert.strictEqual(sg.length, 1); assert.strictEqual(sg[0].source, 'sr'); assert.strictEqual(sg[0].action, 'buy'); assert.strictEqual(sg[0].status, 'taken', JSON.stringify(sg[0]));
  let m = await call('GET', '/api/meta'); assert.strictEqual(m.positions.length, 1, 'position opened by the server itself'); assert(m.positions[0].volume >= 100 && m.positions[0].volume <= 200, 'size within the exam risk cap: ' + m.positions[0].volume);
  assert(m.positions[0].why && /ONL/.test(m.positions[0].why.text), 'reason is attached to the position');
  const p = m.positions[0];
  // a second level touch while a trade is open is skipped (one trade at a time)
  const sr = await call('GET', '/api/sr'); assert.strictEqual(sr.strategy, 'sr'); assert.strictEqual(sr.levels.length, 4); assert.strictEqual(sr.trend, 1);
  // price runs to the target -> closed by TP
  const tp = p.tp; await bar(ny(14, 10, 5), L + 1, tp + 1, L + 0.8, tp + 0.5);
  m = await call('GET', '/api/meta'); assert.strictEqual(m.positions.length, 0, 'target hit'); const tr = await call('GET', '/api/trades'); assert.strictEqual(tr.trades.length, 1); assert.strictEqual(tr.trades[0].reason, 'TP'); assert(tr.trades[0].pnl > 0);
  // health / exam view
  const hl = await (await fetch(base + '/health')).json(); assert.strictEqual(hl.strategy, 'sr'); assert(hl.signalEngine > 0);
  const ex = await call('GET', '/api/exam'); assert.strictEqual(ex.start, 25000); assert.strictEqual(ex.target, 1250); assert(ex.profit > 0);
  // a position left open at 16:00 New York is closed by the strategy (end of day)
  const c0 = tp + 0.5; await bar(ny(14, 11, 0), c0, c0 + 1, c0 - 1, c0);
  console.log('sr server test ok: size', p.volume / 100, 'contracts, pnl', tr.trades[0].pnl);
  server.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
