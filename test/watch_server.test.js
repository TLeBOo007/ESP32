'use strict';
// End to end on the real HTTP server: a request with "x-device: esp32" starts the watch, silence raises the alert, the next request clears it,
// and the exam window closing / opening sends a notice.
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.API_KEY = 'test-key-0123456789'; process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-watch-')); process.env.TEST_MODE = '1';
Object.assign(process.env, { EXAM: '1', SYMBOLS: 'US100', LINE_CHANNEL_TOKEN: 'x', LINE_TO: 'Utest' });
const K = process.env.API_KEY, sent = [];
global.fetch = (u, o) => { if (String(u).includes('api.line.me')) { sent.push(JSON.parse(o.body).messages[0].text); return Promise.resolve({ ok: true, status: 200, text: async () => '' }); } return Promise.reject(new Error('no network in test')); };
const realFetch = global.fetch;
(async () => {
  const { server, devWatch, examEval } = require('../server');
  await new Promise(r => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port;
  const http = require('http');
  const req = (method, p, body, headers = {}) => new Promise((res, rej) => { const q = http.request(base + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': K, ...headers } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() })); }); q.on('error', rej); q.end(body ? JSON.stringify(body) : undefined); });
  const clock = utc => req('POST', '/api/test/now', { utc });
  const at = (h, m = 0) => Date.UTC(2026, 9, 20, h, m) / 1000;                 // EDT: New York = UTC - 4
  const flush = () => new Promise(r => setTimeout(r, 50));
  await clock(at(14, 0));                                                       // 10:00 NY, window open
  examEval();                                                                    // first evaluation: no notice
  await flush(); assert.strictEqual(sent.length, 0, 'nothing yet: ' + sent.join('|'));
  await req('GET', '/api/meta');                                                // dashboard-like request, no header: does not start the watch
  assert.strictEqual(devWatch.state(at(14, 0)).ever, false);
  await req('GET', '/api/meta', null, { 'x-device': 'esp32' });
  assert.strictEqual(devWatch.state(at(14, 0)).ever, true);
  await clock(at(14, 4)); assert.strictEqual(devWatch.check(at(14, 4)), '', 'under 5 minutes');
  await clock(at(14, 6));
  const m = devWatch.check(at(14, 6)); assert(m.includes('ESP32'), m);
  await req('GET', '/api/meta', null, { 'x-device': 'esp32' }); await flush();
  assert(sent.some(t => t.includes('กลับมาออนไลน์')), 'recovery message sent: ' + sent.join('|'));
  const st = await req('GET', '/api/status-text'); assert(JSON.stringify(st).includes('ESP32'), 'status text has the ESP32 line');
  await clock(at(20, 10)); examEval();                                          // 16:10 NY: trading day closed
  await flush(); assert(sent.some(t => t.includes('หมดวันเทรด')), 'close notice: ' + sent.join('|'));
  await clock(at(22, 5)); examEval();                                           // 18:05 NY: open again
  await flush(); assert(sent.some(t => t.includes('เริ่มวันเทรดใหม่')), 'open notice: ' + sent.join('|'));
  console.log('watch server tests ok'); server.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
