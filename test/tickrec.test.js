'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { TickRec, FootprintBuilder } = require('../lib/tickrec');
const T0 = Date.UTC(2026, 9, 16, 13, 30, 0);          // 09:30 NY
// footprint maths: diagonal imbalance, stacks, delta, POC
{
  const fb = new FootprintBuilder(0.25);
  const add = (s, p, v, ty) => fb.add(T0 + s * 1000, p, v, ty);
  add(1, 100.00, 10, 1); add(2, 100.25, 20, 0); add(3, 100.50, 30, 0); add(4, 100.75, 8, 0); add(5, 100.00, 3, 1);
  const closed = add(301, 101, 1, 0);                 // next bucket closes the first
  assert(closed && closed.t === T0 && closed.o === 100 && closed.h === 100.75 && closed.l === 100 && closed.c === 100);
  assert.strictEqual(closed.vol, 71); assert.strictEqual(closed.delta, (20 + 30 + 8) - (10 + 3));
  assert.strictEqual(closed.poc, 100.5);
  assert.deepStrictEqual(closed.lv[400], [13, 0]);
  // ask 100.25=20 vs bid(100.00)=13: 20<39 no; ask 100.5=30 vs bid(100.25)=0 -> 30>=3*1 yes; ask 100.75=8 vs bid(100.5)=0 yes -> stack 2
  assert.strictEqual(closed.stackBuy, 2); assert.strictEqual(closed.stackSell, 0);
  assert.strictEqual(fb.add(T0 + 10 * 1000, 99, 1, 1), null);                           // late trade ignored
}
// recorder: events, side sanity check, file persistence, API roundtrip with a fake hub
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickrec-')); let handlers = {}, subs = [], calls = [];
  const fake = { HttpTransportType: { WebSockets: 1 }, HubConnectionBuilder: class { withUrl() { return this; } withAutomaticReconnect() { return this; } build() {
    return { on: (n, f) => { handlers[n] = f; }, onreconnecting() {}, onreconnected() {}, onclose() {}, start: async () => {}, stop: async () => {}, invoke: async (m, id) => { subs.push([m, id]); } }; } } };
  let now = T0;
  const r = new TickRec({ user: 'u', key: 'k', dir, signalR: fake, now: () => now, fetchJson: async (url, o) => { calls.push(url); return url.endsWith('loginKey') ? { success: true, token: 'tok' } : { contracts: [{ id: 'CON.F.US.MNQ.Z26', activeContract: true, tickSize: 0.25 }] }; } });
  await r.start();
  assert.strictEqual(r.status().state, 'live'); assert.deepStrictEqual(subs, [['SubscribeContractTrades', 'CON.F.US.MNQ.Z26']]);
  assert(!JSON.stringify(calls).includes('tok'), 'token must not appear in URLs of REST calls');
  const tr = (s, p, v, ty) => handlers.GatewayTrade('CON', { symbolId: 'x', price: p, volume: v, type: ty, timestamp: new Date(T0 + s * 1000).toISOString() });
  tr(1, 100, 5, 0); tr(2, 100.25, 5, 0); tr(3, 100, 5, 1); tr(4, 99.75, 5, 1); tr(5, 100, 4, 0);
  assert.strictEqual(r.status().trades, 5); assert.strictEqual(r.status().buys, 14);
  handlers.GatewayTrade('CON', [{ price: 0, volume: 1, type: 0, timestamp: new Date(T0).toISOString() }, { price: 1, volume: 1, type: 5, timestamp: new Date(T0).toISOString() }]);
  assert.strictEqual(r.status().trades, 5, 'bad records ignored');
  assert.strictEqual(r.status().sidePct, 100, 'ticks up = buys, ticks down = sells');
  now = T0 + 6 * 60 * 1000; r.tickFlush();                                              // idle flush closes the bar
  assert.strictEqual(r.status().bars, 1); assert.strictEqual(r.days().length, 1);
  const day = r.day('20261016'); assert.strictEqual(day.length, 1); assert.strictEqual(day[0].vol, 24);
  assert.strictEqual(r.bars().length, 1); assert.deepStrictEqual(r.day('../etc'), []);
  await assert.rejects(r._post('/api/Order/place', {}, 'tok'), /read-only/);          // order endpoints are unreachable from this module
  assert.throws(() => r._invoke({ invoke() {} }, 'SomethingElse'), /read-only/);
  fs.rmSync(dir, { recursive: true }); await r.stop(); console.log('tickrec tests passed');
})().catch(e => { console.error(e); process.exit(1); });
