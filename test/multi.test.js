'use strict';
// Several instruments on one paper account: shared balance and ids, per-instrument bars, spreads, killzone profile, persistence.
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.API_KEY = 'test-key-0123456789'; process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-multi-')); process.env.TEST_MODE = '1';
process.env.SYMBOLS = 'US100,US30,EURUSD,USDJPY,XAUUSD'; process.env.START_BALANCE = '10000';
const K = process.env.API_KEY;
async function call(base, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': K }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { code: r.status, json: await r.json().catch(() => null) };
}
(async () => {
  const { server, insts, acct } = require('../server');
  await new Promise(r => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port;
  assert.deepStrictEqual([...insts.keys()], ['US100', 'US30', 'EURUSD', 'USDJPY', 'XAUUSD']);
  const T = 1760900000 - (1760900000 % 300);
  const bar = (sym, k, o, h, l, c) => call(base, 'POST', '/tv?key=' + K, { event: 'bar', sym, t: T + 300 * k, o, h, l, c }).then(r => r.json);
  // spreads / killzone profiles per instrument
  for (const [sym, px] of [['US100', 25000], ['US30', 45000], ['EURUSD', 1.1], ['USDJPY', 150], ['XAUUSD', 2700]]) assert.strictEqual((await bar(sym, 0, px, px, px, px)).processed, 1, sym);
  const m = s => call(base, 'GET', '/api/meta?sym=' + s).then(r => r.json);
  let e = await m('EURUSD'); assert.strictEqual(e.digits, 5); assert(Math.abs(e.ask - e.bid - 0.00012) < 1e-9); assert.strictEqual(e.multiplier, 100000);
  assert(e.kz.london && e.kz.nyam && !e.kz.asia && !e.kz.waitEquityOpen);
  let j = await m('USDJPY'); assert(j.kz.asia && j.kz.nyam); assert(Math.abs(j.multiplier - 100000 / 150) < 1e-6);
  let g = await m('XAUUSD'); assert(g.kz.london && g.kz.nyam); assert.strictEqual(g.multiplier, 100);
  let u = await m('US30'); assert(u.kz.nyam && u.kz.nypm && u.waitEquityOpen === undefined); assert(u.kz.waitEquityOpen);
  assert.strictEqual(u.symbols.length, 5);
  // orders on two instruments, one account, unique ids
  const o1 = (await call(base, 'POST', '/api/order', { sym: 'EURUSD', side: 1, kind: 'limit', volume: 100, price: 1.0990, sl: 1.0950, tp: 1.1100, comment: 'eu' })).json;
  const o2 = (await call(base, 'POST', '/api/order', { sym: 'XAUUSD', side: 2, kind: 'limit', volume: 10, price: 2710, sl: 2720, tp: 2680, comment: 'xau' })).json;
  assert(o1.id && o2.id && o1.id !== o2.id);
  assert.strictEqual((await m('EURUSD')).orders.length, 1); assert.strictEqual((await m('XAUUSD')).orders.length, 1);
  assert.strictEqual((await m('US100')).orders.length, 0); assert.strictEqual((await m('US100')).openAll, 2);
  // a XAUUSD bar must not touch the EURUSD order and vice versa
  await bar('XAUUSD', 1, 2700, 2715, 2699, 2710);                                  // sell limit 2710 fills (bid based, high 2715 >= 2710)
  assert.strictEqual((await m('XAUUSD')).positions.length, 1); assert.strictEqual((await m('EURUSD')).orders.length, 1);
  await bar('EURUSD', 1, 1.1, 1.1, 1.0985, 1.099);                                 // buy limit 1.0990: low + spread <= price
  assert.strictEqual((await m('EURUSD')).positions.length, 1);
  // chart endpoint: candles of that symbol only, its open orders/positions, no other symbol's data
  const ch = (await call(base, 'GET', '/api/chart?sym=EURUSD&tf=5')).json;
  assert.strictEqual(ch.sym, 'EURUSD'); assert.strictEqual(ch.digits, 5); assert(ch.bars.length >= 2 && ch.bars[0].length === 5); assert(Array.isArray(ch.poi));
  assert(ch.bars.every(b => b[1] < 2), 'EURUSD candles, not XAUUSD'); assert.strictEqual(ch.positions.length, 1); assert.strictEqual(ch.positions[0].price, 1.099);
  assert('setup' in ch, 'chart reply carries the waiting-setup preview (null when none)'); assert.strictEqual((await call(base, 'GET', '/api/chart?sym=XAUUSD&tf=15')).json.sym, 'XAUUSD'); assert.strictEqual((await call(base, 'GET', '/api/chart')).code, 200);
  // EURUSD hits TP: +0.0110 * 1 lot(100 units) * 100000 = +1100 ; shared balance moves for all
  await bar('EURUSD', 2, 1.099, 1.11, 1.099, 1.105);
  e = await m('EURUSD'); assert.strictEqual(e.positions.length, 0);
  assert(Math.abs(e.balance - 11100) < 0.01, 'balance ' + e.balance); assert.strictEqual((await m('XAUUSD')).balance, e.balance);
  // cancel / close are routed by id to the owning instrument
  const o3 = (await call(base, 'POST', '/api/order', { sym: 'US30', side: 1, kind: 'limit', volume: 10, price: 40000, sl: 39900, tp: 41000 })).json;
  assert.strictEqual((await call(base, 'POST', '/api/cancel', { id: o3.id })).json.ok, true);
  const x = (await m('XAUUSD')).positions[0];
  assert.strictEqual((await call(base, 'POST', '/api/close', { id: x.id, price: 2705, t: T + 900 })).json.ok, true);     // sell from 2710 closed at 2705: +5 * 0.1 lot * 100 = +50
  const tr = (await call(base, 'GET', '/api/trades')).json.trades;
  assert.deepStrictEqual(tr.map(t => t.sym).sort(), ['EURUSD', 'XAUUSD']); const xt = tr.find(t => t.sym === 'XAUUSD'); assert(Math.abs(xt.pnl - 50) < 0.01, 'xau pnl ' + xt.pnl);
  const st = (await call(base, 'GET', '/api/stats')).json; assert.strictEqual(st.trades, 2); assert(Math.abs(st.netPnl - 1150) < 0.01);
  assert.deepStrictEqual(st.bySymbol.filter(b => b.trades).map(b => b.sym), ['EURUSD', 'XAUUSD']);
  assert.strictEqual((await call(base, 'GET', '/api/trades?sym=XAUUSD')).json.trades.length, 1);
  // signals carry the instrument; /api/bpe lists all
  await call(base, 'POST', '/tv?key=' + K, { event: 'signal', sym: 'USDJPY', action: 'buy', price: 150, sl: 149, tp: 152 });
  const sg = (await call(base, 'GET', '/api/signals?sym=USDJPY')).json.signals; assert.strictEqual(sg.length, 1); assert.strictEqual(sg[0].sym, 'USDJPY');
  const bp = (await call(base, 'GET', '/api/bpe?sym=EURUSD')).json; assert.strictEqual(bp.sym, 'EURUSD'); assert.strictEqual(bp.symbols.length, 5);
  // USD/JPY: profit is converted from yen at the current rate
  const oj = (await call(base, 'POST', '/api/order', { sym: 'USDJPY', side: 1, kind: 'market', volume: 100, sl: 149, tp: 152, bid: 150, ask: 150.012, t: T + 1200 })).json; assert(oj.id);
  await bar('USDJPY', 4, 150, 152.5, 150, 152);                                    // TP 152: +2.0 * 1 lot * (100000/152) = ~ +1315.8
  const jt = (await call(base, 'GET', '/api/trades?sym=USDJPY')).json.trades[0]; assert(jt.pnl > 1250 && jt.pnl < 1400, 'jpy pnl ' + jt.pnl);
  // persistence: save, rebuild the module, everything is still there
  await new Promise(r => setTimeout(r, 700));
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'paper.json'), 'utf8')); assert.strictEqual(saved.v, 2); assert.strictEqual(Object.keys(saved.engines).length, 5);
  const bal = acct.balance, nextId = acct.nextId; server.close();
  Object.keys(require.cache).filter(k => /paper-server[\\/](server|engine)\.js$|lib/.test(k)).forEach(k => delete require.cache[k]);
  const again = require('../server'); assert(Math.abs(again.acct.balance - bal) < 1e-6); assert.strictEqual(again.acct.nextId, nextId);
  assert.strictEqual(again.insts.get('EURUSD').engine.trades.length, 1); assert.strictEqual(again.insts.get('XAUUSD').engine.trades.length, 1);
  console.log('multi-instrument tests ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
