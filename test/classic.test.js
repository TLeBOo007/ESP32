'use strict';
// Geometry of the book's models (BPE book p.577-586) on hand-made bars: discount/premium, OTE, IDM (models 1-3) and the BOX (model 4).
const assert = require('assert');
const { Bpe, MODEL_NAMES } = require('../lib/bpe.js');
const T0 = 1699999200;                              // multiple of 900 s, so M15 bars line up
function make(bars, cfg) {                                // bars: [o,h,l,c] oldest -> newest (all closed); the forming bar is added like the engine does
  const b = new Bpe(Object.assign({ symbol: 'US100', digits: 2 }, cfg));
  bars.forEach((x, i) => b.addHistory(T0 + i * 300, ...x));
  b.gNow = T0 + bars.length * 300; b.quote = { bid: bars[bars.length - 1][3], ask: bars[bars.length - 1][3] };
  b.st.pushForming(b.gNow, b.quote.bid);
  return b;
}
const flat = (n, lo, hi) => Array.from({ length: n }, () => [(lo + hi) / 2, hi, lo, (lo + hi) / 2]);
const mirror = bars => bars.map(([o, h, l, c]) => [200 - o, 200 - l, 200 - h, 200 - c]);   // price -> 200 - price turns a buy picture into a sell picture

// ---- models 1-3: sweep low 100, rally to 121, IDM at 113 swept again on the way back into the FVG
const up = [...flat(10, 109, 111), [110, 111, 100, 101], [101, 113, 100.5, 112], [112, 118, 111, 116], [118, 119, 113.5, 114], [114, 117, 113, 115], [115, 121, 114, 119], [119, 119.5, 111, 112]];
{
  const b = make(up), S = { ext: 100 };
  // bar shifts: last closed = 1; sweep bar is 7th from the end (shift 7), displacement bar shift 6
  let f = b._flags(1, S, 7, 6, 110, 106);
  assert.ok(f.discount, 'zone 106-110 is below the 50% of 100..121'); assert.ok(f.ote, 'overlaps OTE 104.4-108.0'); assert.ok(f.idm, 'IDM 113 was taken');
  assert.strictEqual(Number(f.range.toFixed(2)), 21); assert.strictEqual(Number(f.oteZone.top.toFixed(2)), 107.98); assert.strictEqual(f.oteZone.bot, 106);
  f = b._flags(1, S, 7, 6, 113, 111);
  assert.ok(!f.discount, 'zone 111-113 is in premium'); assert.ok(!f.ote);
  f = b._flags(1, S, 7, 6, 111.5, 109);
  assert.ok(f.discount === false || f.discount === true); assert.ok(!f.ote, '109-111.5 is above the OTE band');
  // no IDM: remove the dip that sweeps it
  const noIdm = up.slice(); noIdm[noIdm.length - 1] = [119, 119.5, 114.5, 115];
  assert.ok(!make(noIdm)._flags(1, S, 7, 6, 110, 106).idm, 'IDM not swept yet');
  // mirror = bearish picture: premium, OTE and IDM must give the same answers
  const m = make(mirror(up)), fm = m._flags(-1, { ext: 100 }, 7, 6, 94, 90);
  assert.ok(fm.discount && fm.ote && fm.idm, 'sell side mirrors the buy side');
}
// ---- model 4: a consolidation 100..104, its low (100) is raided to 98.5, then price closes back above the box
const box = [...flat(14, 100, 104), [101, 101.2, 98.5, 100.8], [101, 106, 100.8, 105.5]];
{
  const b = make(box), S = { ext: 98.5, liq: 100 };
  const r = b._box(1, 2, S);
  assert.ok(r, 'box found'); assert.strictEqual(r.top, 104); assert.strictEqual(r.bot, 100); assert.ok(r.n >= 8);
  assert.strictEqual(make(box)._box(1, 2, { ext: 98.5, liq: 90 }), null, 'the swept level must be the box low (equal lows), not something far away');
  assert.strictEqual(make(box)._box(1, 2, { ext: 100.5, liq: 100 }), null, 'price must have gone below the box low');
  const drift = Array.from({ length: 14 }, (_, i) => [100 + i * 1.5, 101 + i * 1.5, 99.5 + i * 1.5 - 0.5, 100.5 + i * 1.5]);   // small bars walking upward = a trend, not a box
  assert.strictEqual(make([...drift, box[14], box[15]], { boxMaxK: 1.0 })._box(1, 2, S), null, 'a range taller than boxMaxK x ATR is not a consolidation');
  const mb = make(mirror(box)); assert.ok(mb._box(-1, 2, { ext: 101.5, liq: 100 }), 'sell side mirrors the buy side');
}
// ---- names / defaults
assert.ok(MODEL_NAMES.M4.includes('BOX')); assert.deepStrictEqual(new Bpe({}).c.setups, ['M1', 'M2', 'M3', 'M4', 'UC']); assert.strictEqual(new Bpe({}).c.setupMode, 'classic');
console.log('classic model tests ok');
// ---- stats per model (comment of the order carries the model code)
{
  const { Engine } = require('../engine.js'), en = new Engine({ startBalance: 1000 });
  const add = (comment, pnl, R) => en.trades.push({ id: en.trades.length + 1, side: 1, volume: 1, open: 1, close: 1, pnl, R, comment, closeT: 1 });
  add('BPE M3 M3 RR2.4 swing', 30, 2.4); add('BPE M3 M3 RR2.1 PDH', -12, -1); add('BPE UC CISD Unicorn RR2.0 swing', 20, 2); add('manual', 5, 0.5);
  const bm = en.stats().byModel, g = k => bm.find(x => x.model === k);
  assert.strictEqual(g('M3').trades, 2); assert.strictEqual(g('M3').winRate, 50); assert.strictEqual(g('M3').sumR, 1.4); assert.strictEqual(g('UC').trades, 1); assert.strictEqual(g('other').trades, 1);
  console.log('per-model stats ok');
}
