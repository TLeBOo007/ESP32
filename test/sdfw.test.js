'use strict';
const assert = require('assert');
const { SdForward } = require('../lib/sdfw');
const T = (h, m, s = 0) => Date.UTC(2026, 9, 16, h, m, s);          // 2026-10-16 UTC (US DST: NY = UTC-4, so 13:30 UTC = 09:30 NY)
const bar = (t, o, h, l, c, delta = 0, sb = 0, ss = 0) => ({ t, o, h, l, c, vol: 100, delta, stackBuy: sb, stackSell: ss, n: 10 });
function scenario(delta, sb) {
  const sd = new SdForward({ cfg: { costPts: 0 } }); let t = T(11, 0);
  for (let i = 0; i < 20; i++, t += 300000) sd.onBar(bar(t, 100, 105, 95, 100));              // flat bars, range 10 -> ATR 10
  sd.onBar(bar(t, 100, 101.5, 98.5, 100)); t += 300000;                                         // base 1
  sd.onBar(bar(t, 100, 101.5, 98.5, 100)); t += 300000;                                         // base 2
  sd.onBar(bar(t, 100, 116, 100, 115)); t += 300000;                                            // impulse up (body 15 >= ATR) -> demand zone 98.5-101.5
  assert.strictEqual(sd.zones.length, 1); assert.strictEqual(sd.zones[0].d, 1);
  while (t < T(13, 35)) { sd.onBar(bar(t, 115, 116, 114, 115)); t += 300000; }
  sd.onTick(T(13, 35, 5), 110, 1, 0); assert.strictEqual(sd.events.length, 0);
  sd.onTick(T(13, 36, 0), 101, 3, 1);                                                           // touches the zone inside NY AM
  assert.strictEqual(sd.events.length, 1); assert.strictEqual(sd.zones.length, 0, 'zone consumed on first touch');
  sd.onTick(T(13, 38, 0), 100.5, 2, 0);
  sd.onBar(bar(T(13, 35), 110, 110, 100.5, 101, delta, sb, 0));                                 // touch bar closes
  sd.onTick(T(13, 40, 5), 101.25, 1, 0);                                                        // first tick after the close -> entry
  return sd;
}
{
  const sd = scenario(+500, 3);                                                                  // buyers absorbed: delta>0, stacked buy 3
  for (const v of ['zone', 'delta', 'stack', 'both']) { assert(sd.pos[v], v + ' should be in'); assert.strictEqual(sd.pos[v].ent, 101.25); }
  assert.strictEqual(+sd.pos.zone.sl.toFixed(2), 98.2); assert.strictEqual(+sd.pos.zone.risk.toFixed(2), 3.05);
  sd.onTick(T(13, 50), 110.5, 1, 0); assert(sd.pos.zone, 'target needs a trade through target + 1 tick');
  sd.onTick(T(13, 51), 110.8, 1, 0); assert(!sd.pos.zone);
  const s = sd.stats(); assert.strictEqual(s.variants.zone.n, 1); assert.strictEqual(s.variants.zone.avgR, 3);
}
{
  const sd = scenario(-500, 0);                                                                  // sellers dominated the touch bar: no confirmation
  assert(sd.pos.zone && !sd.pos.delta && !sd.pos.stack && !sd.pos.both);
  sd.onTick(T(13, 45), 98.0, 1, 1); assert(!sd.pos.zone);                                        // stop out at the trade price
  const s = sd.stats(); assert.strictEqual(s.variants.zone.n, 1); assert(s.variants.zone.avgR < -1 + 1e-9);
}
{
  const sd = new SdForward({ cfg: {} });                                                          // touch outside the NY AM window creates no event
  sd.zones.push({ d: 1, hi: 101.5, lo: 98.5, from: 0, born: 0 }); sd.onTick(T(20, 0), 101, 1, 0);
  assert.strictEqual(sd.events.length, 0); assert.strictEqual(sd.zones.length, 0);
}
console.log('sdfw tests passed');
