'use strict';
// The feed wired into the real server: a fake "Yahoo" web server serves the real M5 file as it would appear over time,
// the feed polls it, the signal engine runs on what arrives, a minimal trader takes the signals. Needs BPE_CSV.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), assert = require('assert');
const csv = process.env.BPE_CSV;
if (!csv || !fs.existsSync(csv)) { console.log('feed server test skipped (set BPE_CSV)'); process.exit(0); }
const { serverToUtc } = require('../lib/timeutil');
const rows = fs.readFileSync(csv, 'utf8').trim().split('\n').map(l => l.split(',').map(Number)).map(r => [serverToUtc(r[0]), r[1], r[2], r[3], r[4]]);
const S = 3000, N = 7000; let mockNow = 0, hits = 0;
const mock = http.createServer((req, res) => {
  hits++;
  let list = rows.filter(r => r[0] <= mockNow);                      // includes the bar that is still forming
  if (req.url.includes('range=30d')) list = list.slice(-(S + 1)); else list = list.slice(-6);   // first call: exactly the 3000 bars the original test used for warm-up
  const q = k => list.map(r => r[k]);
  const body = JSON.stringify({ chart: { result: [{ timestamp: q(0), indicators: { quote: [{ open: q(1), high: q(2), low: q(3), close: q(4), volume: list.map(() => 1) }] } }] } });
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(body);
});
(async () => {
  await new Promise(r => mock.listen(0, r));
  process.env.API_KEY = 'test-key-0123456789'; process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-')); process.env.TEST_MODE = '1';
  process.env.FEED = 'yahoo'; process.env.FEED_BASE_URL = 'http://127.0.0.1:' + mock.address().port;
  const { server, feed } = require('../server'); assert(feed, 'feed not created');
  await new Promise(r => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port, K = process.env.API_KEY;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-api-key': K }, body: b === undefined ? undefined : JSON.stringify(b) }); const j = await r.json(); if (!r.ok) throw new Error(p + ' ' + JSON.stringify(j)); return j; };
  let lastSig = 0, entries = 0, taken = 0;
  mockNow = rows[S][0] + 6; await call('POST', '/api/test/now', { utc: mockNow });                  // the moment the server starts: bars before it are warm-up
  let r = await feed.poll(); assert.strictEqual(r.forward, 0); assert.strictEqual(r.history, S);
  for (let i = S; i < S + N; i++) {
    mockNow = rows[i][0] + 300 + 6; await call('POST', '/api/test/now', { utc: mockNow });
    r = await feed.poll(); assert.strictEqual(r.forward, 1, 'bar ' + i + ' ' + JSON.stringify(r));
    if (!r.forward) continue;
    const { signals } = await call('GET', '/api/signals?after=' + lastSig);
    for (const g of signals) {
      lastSig = g.id;
      if (g.action === 'cancel') { const m = await call('GET', '/api/meta'); for (const od of m.orders) await call('POST', '/api/cancel', { id: od.id }); await call('POST', '/api/signals/ack', { id: g.id, status: 'taken' }); continue; }
      entries++;
      const m = await call('GET', '/api/meta'), buy = g.action.startsWith('buy'), market = !g.action.endsWith('limit');
      const entry = market ? (buy ? m.ask : m.bid) : g.price, vol = Math.floor((0.02 * m.balance) / Math.abs(entry - g.sl) * 100);
      if (vol < 1) { await call('POST', '/api/signals/ack', { id: g.id, status: 'skipped', reason: 'small' }); continue; }
      const od = await call('POST', '/api/order', { side: buy ? 1 : 2, kind: market ? 'market' : 'limit', volume: vol, price: g.price, sl: g.sl, tp: g.tp, t: 0, afterBarUtc: g.barT, bid: m.bid, ask: m.ask, comment: g.comment });
      await call('POST', '/api/signals/ack', { id: g.id, status: 'taken', orderId: od.id }); taken++;
    }
  }
  const bpe = await call('GET', '/api/bpe'), st = await call('GET', '/api/stats');
  console.log(`feed polls ${hits}, forward bars ${N}, signals ${entries} (${taken} taken), trades ${st.trades}; feed state ${JSON.stringify(bpe.feed)}`);
  const tl = (await call('GET', '/api/trades')).trades;
  assert(tl.length > 0 && tl.every(t => t.why && t.why.text && t.exitWhy && typeof t.mfeR === 'number' && typeof t.maeR === 'number'), 'every BPE trade carries entry+exit reasons');
  if (process.env.SHOW_WHY) { for (const t of tl.slice(0, 2)) console.log('\n#' + t.id + ' ' + t.R + 'R\n' + t.why.text + '\n--\n' + t.exitWhy); }
  assert(entries === 7 && st.trades > 0 && !bpe.feed.lastError && bpe.feed.forwardStart);
  console.log('feed server test ok'); server.close(); mock.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
