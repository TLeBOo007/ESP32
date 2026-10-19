'use strict';
const assert = require('assert');
const { Engine } = require('../engine');
const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
let e;

// buy limit fills, then TP
e = new Engine({ startBalance: 1000 });
let r = e.placeOrder({ side: 1, kind: 'limit', volume: 100, price: 100, sl: 99, tp: 102, t: 1 });
assert(r.id);
e.processBar(bar(300, 101, 101.5, 100.5, 101));   // not touched
assert.strictEqual(e.orders.length, 1);
e.processBar(bar(600, 101, 101, 99.8, 100.5));    // touched, no exit
assert.strictEqual(e.positions.length, 1); assert.strictEqual(e.positions[0].open, 100);
e.processBar(bar(900, 100.5, 102.5, 100.2, 102)); // TP
assert.strictEqual(e.positions.length, 0);
assert.strictEqual(e.trades[0].reason, 'TP'); assert.strictEqual(e.trades[0].pnl, 2); assert.strictEqual(e.trades[0].R, 2);
assert.strictEqual(e.balance, 1002);

// stop first when both are inside one bar; gap through SL fills at open
e = new Engine({ startBalance: 1000 });
e.placeOrder({ side: 1, kind: 'market', volume: 200, ask: 100, bid: 100, sl: 99, tp: 101, t: 1 });
e.processBar(bar(300, 100, 102, 98, 100));
assert.strictEqual(e.trades[0].reason, 'SL'); assert.strictEqual(e.trades[0].close, 99);
e = new Engine({ startBalance: 1000 });
e.placeOrder({ side: 1, kind: 'market', volume: 100, ask: 100, bid: 100, sl: 99, tp: 105, t: 1 });
e.processBar(bar(300, 98, 98.5, 97, 97.5));
assert.strictEqual(e.trades[0].close, 98);     // gap: min(open, sl)

// sell with spread: SL on ask side
e = new Engine({ startBalance: 1000 });
e.placeOrder({ side: 2, kind: 'market', volume: 100, ask: 100.5, bid: 100, sl: 101, tp: 98, t: 1 });
e.processBar(bar(300, 100, 100.6, 99.5, 100), 0.5);   // high+spread = 101.1 >= 101
assert.strictEqual(e.trades[0].reason, 'SL'); assert.strictEqual(e.trades[0].close, 101);

// validation, cancel, amend, manual close, bar idempotence
e = new Engine();
assert.strictEqual(e.placeOrder({ side: 1, kind: 'limit', volume: 100, price: 100, sl: 101, tp: 102 }).error, 'SL_WRONG_SIDE');
assert.strictEqual(e.placeOrder({ side: 1, kind: 'market', volume: 100, sl: 99, tp: 102 }).error, 'NO_QUOTE');
const o = e.placeOrder({ side: 2, kind: 'limit', volume: 100, price: 100, sl: 101, tp: 98, t: 1 });
assert.strictEqual(e.cancel(o.id).ok, true); assert.strictEqual(e.cancel(o.id).error, 'NOT_FOUND');
const p = e.placeOrder({ side: 1, kind: 'market', volume: 100, ask: 100, bid: 99.9, sl: 99, tp: 105, t: 1 });
assert.strictEqual(e.amend(p.id, 99.5, 0).ok, true); assert.strictEqual(e.positions[0].sl, 99.5); assert.strictEqual(e.positions[0].tp, 105);
assert.strictEqual(e.processBar(bar(300, 100, 100.5, 99.8, 100)), true);
assert.strictEqual(e.processBar(bar(300, 100, 200, 1, 100)), false);          // same bar twice ignored
assert.strictEqual(e.close(p.id, 100.4, 600, 0, 'time').ok, true);
assert.strictEqual(e.trades[0].reason, 'time'); assert.strictEqual(e.balance, 10000.4);

// bars at or before afterT are ignored (the order was created from that bar's signal)
e = new Engine({ startBalance: 1000 });
e.placeOrder({ side: 1, kind: 'limit', volume: 100, price: 100, sl: 99, tp: 102, t: 1, afterT: 600 });
e.processBar(bar(300, 101, 101, 99, 100)); e.processBar(bar(600, 101, 101, 99, 100));
assert.strictEqual(e.positions.length, 0);
e.processBar(bar(900, 101, 101, 99.9, 100.5));
assert.strictEqual(e.positions.length, 1);
e = new Engine({ startBalance: 1000, multiplier: 2 });
e.placeOrder({ side: 1, kind: 'market', volume: 100, ask: 100, bid: 100, sl: 99, tp: 102, t: 1 });
e.processBar(bar(300, 100, 103, 100, 102));
assert.strictEqual(e.trades[0].pnl, 4); assert.strictEqual(e.balance, 1004);

// persistence round trip
const e2 = new Engine(); e2.load(e.serialize());
assert.deepStrictEqual(e2.state(), e.state()); assert.strictEqual(e2.trades.length, 1);
console.log('engine tests ok');
