'use strict';
const assert = require('assert');
const { Sr } = require('../lib/sr');
const SRV = 7 * 3600;                                                  // server time = New York + 7 h; the module keeps New York wall-clock time
const ny = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) / 1000;     // New York wall-clock as "UTC" seconds
// bars from `from` to `to` (5-minute steps): a drift of `slope` per bar with a small wobble
function make(from, to, p0, slope) {
  const rows = []; let p = p0, k = 0;
  for (let t = from; t < to; t += 300, k++) {
    const o = p, c = p0 + slope * (k + 1) + 0.4 * Math.sin(k / 3); p = c;
    rows.push([t, o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c]);
  }
  return rows;
}
const feed = (sr, rows) => { for (const r of rows) sr.addHistory(r[0] + SRV, r[1], r[2], r[3], r[4]); };

// ---- trend from hourly EMAs ----
{
  const a = new Sr(), b = new Sr();
  feed(a, make(ny(2026, 10, 5, 18, 0), ny(2026, 10, 9, 12, 0), 100, 0.05)); assert.strictEqual(a.h1.trend, 1, 'rising prices -> up');
  feed(b, make(ny(2026, 10, 5, 18, 0), ny(2026, 10, 9, 12, 0), 300, -0.05)); assert.strictEqual(b.h1.trend, -1, 'falling prices -> down');
  const c = new Sr(); feed(c, make(ny(2026, 10, 5, 18, 0), ny(2026, 10, 6, 18, 0), 100, 0.05)); assert.strictEqual(c.h1.trend, 0, 'under 50 hours -> no trend, no trade');
}

// scenario: uptrend Mon 18:00 .. Wed 09:55 (history), then Wed 10:00 touches the overnight low and closes back above it
function scenario(slope, p0, mondays) {
  const sr = new Sr(mondays ? { mondays: true } : {});
  const rows = make(ny(2026, 10, 5, 18, 0), ny(2026, 10, 14, 10, 0), p0, slope);             // Mon 5 Oct 18:00 -> Wed 14 Oct 09:55
  feed(sr, rows);
  const day = Math.floor(ny(2026, 10, 14, 10, 0) / 86400), lv = sr._levels(day);
  return { sr, lv, last: rows[rows.length - 1] };
}
{
  const { sr, lv, last } = scenario(0.05, 100);
  assert(lv && lv.ONL > lv.PDL && lv.ONH > lv.ONL, 'levels exist on a Wednesday: ' + JSON.stringify(lv));
  const t = ny(2026, 10, 14, 10, 0) + SRV, prevC = last[4], L = lv.ONL;
  assert(prevC > L, 'price is above the support');
  const out = sr.onBar(t, prevC, prevC + 0.5, L - 0.2, L + 0.3, { bid: L + 0.3, ask: L + 0.55 });
  const buy = out.actions.find(x => x.action === 'buy' && x.level === 'ONL');
  assert(buy, 'support touched with the trend -> buy; got ' + JSON.stringify(out.actions.map(x => x.level)));
  assert(buy.sl < L && buy.tp > buy.price && Math.abs((buy.tp - buy.price) / (buy.price - buy.sl) - 2) < 1e-9, 'stop under the level, target 2R');
  assert(sr.used.includes('ONL'), 'level is spent');
  const again = sr.onBar(t + 300, L + 0.3, L + 0.9, L - 0.4, L + 0.4, { bid: L + 0.4, ask: L + 0.6 });
  assert.strictEqual(again.actions.length, 0, 'a level is used once per day');
  const st = sr.status(); assert.strictEqual(st.trend, 1); assert(st.levels.length === 4 && st.levels.find(x => x.name === 'ONL').used);
  // state survives a restart
  const copy = new Sr(); copy.load(JSON.parse(JSON.stringify(sr.serialize()))); assert.strictEqual(copy.h1.trend, 1); assert.deepStrictEqual(copy.used, sr.used); assert.strictEqual(copy.t.length, sr.t.length);
}
{
  const { sr, lv, last } = scenario(-0.05, 300);                       // downtrend: a support touch would be a trade against the trend
  const t = ny(2026, 10, 14, 10, 0) + SRV, prevC = last[4];
  assert.strictEqual(sr.h1.trend, -1);
  const L = lv.ONL; assert(prevC > L);
  const out = sr.onBar(t, prevC, prevC + 0.5, L - 0.2, L + 0.3, { bid: L + 0.3, ask: L + 0.55 });
  assert(!out.actions.some(x => x.action === 'buy'), 'no buy against the trend'); assert(sr.used.includes('ONL'), 'but the level is spent (same as the backtest)');
}
{
  const { sr } = scenario(0.05, 100);                                   // outside the NY AM window nothing happens
  const t = ny(2026, 10, 14, 13, 0) + SRV, c = sr.cl[sr.cl.length - 1];
  const out = sr.onBar(t, c, c + 1, sr.levels ? sr.levels.ONL - 1 : c - 5, c, {});
  assert.strictEqual(out.actions.length, 0);
}
// Monday: the previous data date is Sunday (evening session only) -> no levels, like in the backtest; mondays:true uses Friday
{
  const sr = new Sr(), sr2 = new Sr({ mondays: true });
  const rows = make(ny(2026, 10, 9, 9, 30), ny(2026, 10, 12, 10, 0), 100, 0.03);                // Fri 9 Oct 09:30 -> Mon 12 Oct 09:55, includes the Sunday 18:00 session? (no: Fri 16:00-18:00 and weekend are gaps below)
  const gap = rows.filter(r => { const m = (r[0] % 86400) / 60, wd = new Date(r[0] * 1000).getUTCDay(); return !((wd === 5 && m >= 17 * 60) || wd === 6 || (wd === 0 && m < 18 * 60)); });
  feed(sr, gap); feed(sr2, gap);
  const day = Math.floor(ny(2026, 10, 12, 10, 0) / 86400);
  assert.strictEqual(sr._levels(day), null, 'Monday has no levels by default'); assert(sr2._levels(day), 'mondays:true finds Friday');
}
// a bar that is not newer than the last one is ignored
{ const sr = new Sr(); assert(sr.addHistory(ny(2026, 10, 6, 10, 0) + SRV, 1, 2, 0.5, 1.5)); assert(!sr.addHistory(ny(2026, 10, 6, 10, 0) + SRV, 1, 2, 0.5, 1.5)); }
console.log('sr tests ok');
