'use strict';
const assert = require('assert');
const { Feed, parseYahoo, parseTwelve } = require('../lib/feed');
// a fake Yahoo: 5 minute bars every 5 minutes from T0, the bar of the current moment is "forming"
const T0 = 1760000100;                        // a multiple of 300
const barsUntil = now => { const rows = []; for (let t = T0; t <= now; t += 300) rows.push([t, 100 + (t - T0) / 300, 101 + (t - T0) / 300, 99 + (t - T0) / 300, 100.5 + (t - T0) / 300]); return rows; };
const yahoo = rows => ({ chart: { result: [{ timestamp: rows.map(r => r[0]), indicators: { quote: [{ open: rows.map(r => r[1]), high: rows.map(r => r[2]), low: rows.map(r => r[3]), close: rows.map(r => r[4]), volume: rows.map(() => 1) }] } }] } });
(async () => {
  // parsing
  const j = yahoo(barsUntil(T0 + 900)); j.chart.result[0].indicators.quote[0].close[1] = null;
  assert.strictEqual(parseYahoo(j).length, 3);                                     // 4 bars, one with a null
  assert.throws(() => parseYahoo({ chart: { result: null, error: { code: 'Not Found' } } }), /unexpected Yahoo/);
  const td = parseTwelve({ status: 'ok', values: [{ datetime: '2025-11-12 14:35:00', open: '2', high: '3', low: '1', close: '2.5' }, { datetime: '2025-11-12 14:30:00', open: '1', high: '2', low: '1', close: '2' }] });
  assert.strictEqual(td[0][0], Date.UTC(2025, 10, 12, 14, 35) / 1000); assert.strictEqual(td[0][4], 2.5);
  assert.throws(() => parseTwelve({ status: 'error', message: 'bad key' }), /bad key/);

  // behaviour over time
  let clock = T0 + 3 * 3600 + 10, hist = [], bars = [], saves = 0; const state = {};
  const feed = new Feed({ kind: 'yahoo', symbol: 'NQ=F', state, now: () => clock, save: () => saves++, log: () => {}, history: r => hist.push(...r), bar: (r, ev) => bars.push({ r, ev }),
    fetchJson: async url => { feed.lastUrl = url; return yahoo(barsUntil(clock)); } });
  let r = await feed.poll();
  assert(/range=30d/.test(feed.lastUrl) && /includePrePost=true/.test(feed.lastUrl));
  assert.strictEqual(r.forward, 0); assert(r.history > 30); assert.strictEqual(bars.length, 0);       // first poll: warm-up only
  const nHist = hist.length; assert.strictEqual(hist[hist.length - 1][0] + 300 <= clock - 2, true);   // the forming bar is not used
  r = await feed.poll(); assert.strictEqual(r.fresh, 0); assert(/range=1d/.test(feed.lastUrl));        // nothing twice
  clock += 300; r = await feed.poll(); assert.strictEqual(r.forward, 1); assert.strictEqual(bars[0].ev, true); assert.strictEqual(hist.length, nHist);
  clock += 300 * 4; r = await feed.poll(); assert.strictEqual(r.forward, 4); assert.strictEqual(bars.slice(1).every(b => b.ev === (clock - (b.r[0] + 300) <= 900)), true);
  const ts = bars.map(b => b.r[0]); assert.deepStrictEqual(ts, ts.slice().sort((a, b) => a - b)); assert.strictEqual(new Set(ts).size, ts.length);
  clock += 300 * 20; r = await feed.poll();                                                              // server was down for 100 minutes
  const late = bars.slice(-20); assert.strictEqual(late.filter(b => !b.ev).length > 10, true); assert.strictEqual(late[late.length - 1].ev, true);
  // errors do not stop anything
  feed.o.fetchJson = async () => { throw new Error('HTTP 429'); }; r = await feed.poll(); assert(/429/.test(r.error)); assert(/429/.test(state.lastError));
  feed.o.fetchJson = async () => yahoo(barsUntil(clock)); clock += 300; r = await feed.poll(); assert.strictEqual(r.forward, 1); assert.strictEqual(state.lastError, '');
  // scheduling: just after the next boundary, quick retries only while the market is moving
  clock = T0 + 300 * 100 + 40; assert.strictEqual(feed.next(), 300 - 40 + 6);
  console.log('feed test ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
