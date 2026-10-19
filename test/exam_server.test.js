'use strict';
// Exam mode on the server (EXAM=1): futures presets, order guard (stop required, risk clamp, contract cap, trading day), commission,
// end-of-day flatten, maximum-loss failure and the lock afterwards.
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.API_KEY = 'test-key-0123456789'; process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-exam-')); process.env.TEST_MODE = '1';
Object.assign(process.env, { EXAM: '1', SYMBOLS: 'US100,US500,XAUUSD,USDJPY', EXAM_CAP: '2', EXAM_MLL: '300', EXAM_COMMISSION_RT: '2', LINE_CHANNEL_TOKEN: '' });
delete process.env.START_BALANCE;
const K = process.env.API_KEY;
async function call(base, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': K }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { code: r.status, json: await r.json().catch(() => null) };
}
(async () => {
  const { server, insts, acct } = require('../server');
  await new Promise(r => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port;
  const clock = utc => call(base, 'POST', '/api/test/now', { utc });
  const at = (h, m = 0) => Date.UTC(2026, 9, 20, h, m) / 1000;                 // 20 Oct 2026, EDT: New York = UTC - 4
  await clock(at(14, 0));                                                       // 10:00 New York
  assert.deepStrictEqual([...insts.keys()], ['US100', 'US500', 'XAUUSD'], 'USDJPY has no micro-futures preset and is skipped');
  assert.strictEqual(acct.balance, 50000);
  const T = at(14, 0);
  const bar = (sym, k, px, lo = px, hi = px) => call(base, 'POST', '/tv?key=' + K, { event: 'bar', sym, t: T + 300 * k, o: px, h: hi, l: lo, c: px }).then(r => r.json);
  await bar('US100', 0, 25000); await bar('US500', 0, 6000); await bar('XAUUSD', 0, 4000);
  const m = await call(base, 'GET', '/api/meta?sym=US100').then(r => r.json);
  assert.strictEqual(m.multiplier, 2); assert(Math.abs(m.ask - m.bid - 0.25) < 1e-9); assert.strictEqual(m.minVolume, 100); assert.strictEqual(m.stepVolume, 100); assert.strictEqual(m.maxVolume, 200);
  let ex = (await call(base, 'GET', '/api/exam')).json;
  assert(ex.enabled && ex.status === 'active' && ex.floor === 49700 && ex.target === 3000 && ex.capContracts === 2 && ex.windowOpen);

  // guard: stop required, risk too big, size clamped
  const ord = o => call(base, 'POST', '/api/order', { sym: 'US100', side: 1, kind: 'limit', volume: 100, price: 24900, sl: 24800, tp: 25200, ...o });
  let r = await ord({ sl: 0 }); assert.strictEqual(r.code, 400); assert(r.json.error.startsWith('EXAM_NO_STOP'));
  r = await ord({ sl: 24000 }); assert(r.json.error.startsWith('EXAM_RISK'), 'one contract risks $1800 > $250');
  r = await ord({ volume: 500 }); assert(r.json.id, JSON.stringify(r.json));                   // $200 per contract, limit $250 per trade => 1 contract
  let mm = await call(base, 'GET', '/api/meta?sym=US100').then(x => x.json); assert.strictEqual(mm.orders[0].volume, 100, 'volume clamped to the risk limit');
  r = await ord({ price: 24950, sl: 24850 }); assert(r.json.id);                               // second contract (cap 2)
  r = await ord({ price: 24920, sl: 24820 }); assert(r.json.error.startsWith('EXAM_CAP'), JSON.stringify(r.json));
  for (const o of (await call(base, 'GET', '/api/meta?sym=US100').then(x => x.json)).orders) await call(base, 'POST', '/api/cancel', { id: o.id });

  // a stop-out costs the loss + commission; the first loss is survivable, the second breaches the 300 loss limit
  const mkt = () => call(base, 'POST', '/api/order', { sym: 'US100', side: 1, kind: 'market', volume: 100, sl: 24900, tp: 25300, comment: 'x' });
  r = await mkt(); assert(r.json.id, JSON.stringify(r.json));
  await bar('US100', 1, 25000, 24890, 25000);                                                  // low through the stop
  let tr = (await call(base, 'GET', '/api/trades').then(x => x.json)).trades; assert.strictEqual(tr.length, 1); assert.strictEqual(tr[0].fee, 2);
  assert(tr[0].pnl < -200 && tr[0].pnl > -203, 'loss 200 (+0.25 spread) + 2 commission: ' + tr[0].pnl);
  ex = (await call(base, 'GET', '/api/exam')).json; assert.strictEqual(ex.status, 'active'); assert(ex.buffer > 0 && ex.buffer < 100, 'buffer ' + ex.buffer);
  // open position + end of the trading day: everything is closed
  await bar('US100', 2, 25000); r = await mkt(); assert(r.json.id);
  await clock(at(20, 30));                                                                     // 16:30 New York: past the 16:05 flat time
  ex = (await call(base, 'GET', '/api/exam')).json;
  assert.strictEqual((await call(base, 'GET', '/api/meta?sym=US100').then(x => x.json)).positions.length, 0, 'flattened at the end of the trading day');
  tr = (await call(base, 'GET', '/api/trades').then(x => x.json)).trades; assert.strictEqual(tr[tr.length - 1].reason, 'exam');
  r = await mkt(); assert(r.json.error.startsWith('EXAM_CLOSED'), r.json.error);
  assert.strictEqual(ex.status, 'active', 'closing at the market costs almost nothing, the account is still alive');
  // next trading day: a second stop-out takes the balance through the 300 loss limit => failed, locked
  await clock(at(14, 0) + 86400); await bar('US100', 100, 25000); r = await mkt(); assert(r.json.id, JSON.stringify(r.json));
  await bar('US100', 101, 25000, 24890, 25000);
  ex = (await call(base, 'GET', '/api/exam')).json; assert.strictEqual(ex.status, 'failed', JSON.stringify(ex)); assert(ex.balance <= 49700);
  r = await mkt(); assert(r.json.error.startsWith('EXAM_FAILED'), 'a failed account stays locked'); assert.strictEqual((await call(base, 'GET', '/api/state')).code, 200);
  const st = (await call(base, 'GET', '/api/status-text')).json.text; assert(st.includes('🎓') && st.includes('สอบไม่ผ่าน'), st);
  const rs = await call(base, 'POST', '/api/reset', { balance: 50000 }); assert(rs.json.ok);
  assert.strictEqual((await call(base, 'GET', '/api/exam')).json.status, 'active', 'reset starts a new attempt');
  server.close(); console.log('exam server tests ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
