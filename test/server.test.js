'use strict';
// Webhook / API behaviour of the cloud server (starts the real server on a random port).
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.API_KEY = 'test-key-0123456789'; process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-')); process.env.TEST_MODE = '1';
const { server } = require('../server');

const K = process.env.API_KEY;
async function call(base, method, p, body, hdr = { 'x-api-key': K }) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...hdr }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  return { code: r.status, json: await r.json().catch(() => null) };
}
(async () => {
  await new Promise(r => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port;
  const T = 1760900000;
  assert.strictEqual((await call(base, 'GET', '/health', undefined, {})).code, 200);
  assert.strictEqual((await call(base, 'GET', '/api/meta', undefined, {})).code, 401);
  assert.strictEqual((await call(base, 'POST', '/tv', { event: 'bar' }, {})).code, 401);
  assert.strictEqual((await call(base, 'POST', '/tv?key=wrong-key-0123456789', { event: 'bar' }, {})).code, 401);
  assert.strictEqual((await call(base, 'POST', '/tv?key=' + K, 'not json', {})).code, 400);
  let r = await call(base, 'POST', '/tv?key=' + K, { event: 'bar', t: T * 1000, o: 1, h: 2, l: 1, c: 1 }, {}); assert.strictEqual(r.json.error, 'TIME_IN_MS');
  r = await call(base, 'POST', '/tv?key=' + K, { event: 'bar', t: T, o: 100, h: 99, l: 100, c: 100 }, {}); assert.strictEqual(r.json.error, 'BAD_BAR');
  r = await call(base, 'POST', '/tv?key=' + K, { event: 'bar', t: T, o: 100, h: 101, l: 99, c: 100.5 }, {}); assert.strictEqual(r.json.processed, 1);
  r = await call(base, 'POST', '/tv?key=' + K, { event: 'bar', t: T, o: 100, h: 101, l: 99, c: 100.5 }, {}); assert.strictEqual(r.json.processed, 0);   // same bar twice
  r = await call(base, 'POST', '/tv', { key: K, event: 'bar', t: T + 300, o: 100.5, h: 101, l: 100, c: 100.8 }, {}); assert.strictEqual(r.json.processed, 1);   // key in the body
  r = await call(base, 'POST', '/tv?key=' + K, { event: 'signal', action: 'dance' }, {}); assert.strictEqual(r.json.error, 'BAD_ACTION');
  r = await call(base, 'POST', '/tv?key=' + K, { event: 'nope' }, {}); assert.strictEqual(r.json.error, 'BAD_EVENT');
  r = await call(base, 'POST', '/tv?key=' + K, { action: 'long', price: 100, sl: 99, tp: 103 }, {}); assert.strictEqual(r.json.id, 1);                     // legacy body without "event"
  r = await call(base, 'POST', '/tv?key=' + K, { event: 'signal', action: 'sell_limit', price: 101, sl: 102, tp: 98.5, t: T + 300, comment: 'x"y' }, {}); assert.strictEqual(r.json.id, 2);
  r = await call(base, 'GET', '/api/signals?after=0'); assert.strictEqual(r.json.signals.length, 2); assert.strictEqual(r.json.signals[0].action, 'buy'); assert.strictEqual(r.json.signals[1].status, 'new');
  r = await call(base, 'GET', '/api/signals?after=1'); assert.strictEqual(r.json.signals.length, 1);
  r = await call(base, 'GET', '/api/meta'); assert.strictEqual(r.json.pending, 2); assert.strictEqual(r.json.bid, 100.8); assert.strictEqual(r.json.balance, 10000);
  r = await call(base, 'POST', '/api/signals/ack', { id: 1, status: 'skipped', reason: 'outside killzone' }); assert.strictEqual(r.code, 200);
  r = await call(base, 'POST', '/api/signals/ack', { id: 1, status: 'taken' }); assert.strictEqual(r.json.already, true);                                // first decision wins
  r = await call(base, 'POST', '/api/order', { side: 2, kind: 'limit', volume: 100, price: 101, sl: 102, tp: 98.5, t: 5, afterBarUtc: T + 300 }); assert(r.json.id);
  r = await call(base, 'POST', '/api/signals/ack', { id: 2, status: 'taken', orderId: r.json.id, note: '1.00 units' });
  r = await call(base, 'GET', '/api/meta'); assert.strictEqual(r.json.takenToday, 1); assert.strictEqual(r.json.orders.length, 1); assert.strictEqual(r.json.pending, 0);
  // the bar of the signal itself (T+300) must not fill the order, the next one does
  r = await call(base, 'POST', '/tv?key=' + K, { event: 'bar', t: T + 300, o: 100.5, h: 101.5, l: 100, c: 101 }, {}); assert.strictEqual(r.json.processed, 0);
  r = await call(base, 'POST', '/tv?key=' + K, { event: 'bar', t: T + 600, o: 100.8, h: 101.5, l: 100.5, c: 101 }, {}); assert.strictEqual(r.json.processed, 1);
  r = await call(base, 'GET', '/api/meta'); assert.strictEqual(r.json.positions.length, 1); assert.strictEqual(r.json.orders.length, 0);
  r = await call(base, 'POST', '/tv?key=' + K, { event: 'bar', t: T + 900, o: 100.9, h: 101, l: 98, c: 98.4 }, {});
  r = await call(base, 'GET', '/api/stats'); assert.strictEqual(r.json.trades, 1); assert.strictEqual(r.json.wins, 1);
  r = await call(base, 'GET', '/api/trades'); assert.strictEqual(r.json.trades[0].reason, 'TP');
  r = await call(base, 'POST', '/api/reset', { balance: 500 }); r = await call(base, 'GET', '/api/meta'); assert.strictEqual(r.json.balance, 500); assert.strictEqual(r.json.takenToday, 0);
  r = await call(base, 'GET', '/'); assert.strictEqual(r.code, 200);
  server.close(); console.log('server tests ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
