'use strict';
// End to end on the real M5 file: history import, bars through /tv, signals made by the server, a minimal "trader" that
// takes every entry signal with 2% risk. Checks the signals against the original EA orders and that the paper account works.
// Needs BPE_CSV=<z_5.csv> (t,o,h,l,c,v in server time).
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const csv = process.env.BPE_CSV;
if (!csv || !fs.existsSync(csv)) { console.log('bpe server test skipped (set BPE_CSV)'); process.exit(0); }
process.env.API_KEY = 'test-key-0123456789'; process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bpe-')); process.env.TEST_MODE = '1'; process.env.BPE_CONFIG = '{"setupMode":"legacy"}';   // golden file = original Turtle Soup / Unicorn logic
const { server, bpe } = require('../server');
const { serverToUtc } = require('../lib/timeutil');
const K = process.env.API_KEY;
let base;
async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': K }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(p + ' ' + r.status + ' ' + JSON.stringify(j)); return j;
}
(async () => {
  await new Promise(r => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;
  const rows = fs.readFileSync(csv, 'utf8').trim().split('\n').map(l => l.split(',').map(Number));
  const S = 3000;
  let h = await call('POST', '/api/history', { serverTime: true, bars: rows.slice(0, S).map(r => r.slice(0, 5)) });
  assert.strictEqual(h.added, S);
  let lastSig = 0, entries = [], cancels = 0, taken = 0, skipped = 0;
  const want = fs.readFileSync(path.join(__dirname, 'golden_bpe_z5.txt'), 'utf8').trim().split('\n').filter(l => l.startsWith('SEND'));
  for (let i = S; i < rows.length; i++) {
    const [t, o, hi, lo, c] = rows[i];
    await call('POST', '/api/test/now', { utc: serverToUtc(t) + 300 });
    const r = await fetch(base + '/tv?key=' + K, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'bar', serverTime: true, t, o, h: hi, l: lo, c }) });
    const res = await r.json(); if (!r.ok) throw new Error(JSON.stringify(res));
    if (!res.signals) continue;
    const { signals } = await call('GET', '/api/signals?after=' + lastSig);
    for (const g of signals) {
      lastSig = g.id;
      if (g.action === 'cancel') { const m = await call('GET', '/api/meta'); for (const od of m.orders) await call('POST', '/api/cancel', { id: od.id }); await call('POST', '/api/signals/ack', { id: g.id, status: 'taken', note: 'cancel' }); cancels++; continue; }
      if (g.action === 'close') { await call('POST', '/api/signals/ack', { id: g.id, status: 'skipped', reason: 'unused' }); continue; }
      entries.push({ t, ...g });
      const m = await call('GET', '/api/meta'), buy = g.action.startsWith('buy'), market = !g.action.endsWith('limit');
      const entry = market ? (buy ? m.ask : m.bid) : g.price, dist = Math.abs(entry - g.sl);
      const vol = Math.floor((0.02 * m.balance) / dist * 100);
      if (vol < 1) { await call('POST', '/api/signals/ack', { id: g.id, status: 'skipped', reason: 'too small' }); skipped++; continue; }
      const od = await call('POST', '/api/order', { side: buy ? 1 : 2, kind: market ? 'market' : 'limit', volume: vol, price: g.price, sl: g.sl, tp: g.tp, t: t + 300, afterBarUtc: g.barT, bid: m.bid, ask: m.ask, comment: g.comment });
      await call('POST', '/api/signals/ack', { id: g.id, status: 'taken', orderId: od.id }); taken++;
    }
  }
  const m = await call('GET', '/api/meta'), st = await call('GET', '/api/stats');
  console.log(`signals: ${entries.length} entries (${taken} taken, ${skipped} too small), ${cancels} cancels; golden orders ${want.length}`);
  console.log(`paper: ${st.trades} trades, balance ${m.balance}, win ${st.winRate}%, sumR ${st.sumR}`);
  // the original EA sent these orders: same moments, same limit prices, stops and targets
  const g = want.map(l => { const q = Object.fromEntries(l.split(' ').slice(2).filter(x => x.includes('=')).map(x => x.split('='))); return { t: Number(l.split(' ')[1]), type: Number(q.type), pr: Number(q.pr), sl: Number(q.sl), tp: Number(q.tp) }; });
  let same = 0;
  for (const e of entries) { const k = g.find(x => x.t === e.t + 300 && Math.abs(x.sl - e.sl) < 0.011 && Math.abs(x.tp - e.tp) < 0.011); if (k) same++; }
  console.log(`entry signals matching the original EA orders (time, SL, TP): ${same} of ${entries.length}`);
  assert(entries.length > 0 && st.trades > 0, 'no trades');
  assert(same / entries.length > 0.85, 'signals differ from the original EA');
  assert.strictEqual(m.positions.length + m.orders.length <= 1, true);
  console.log('bpe server test ok'); server.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
