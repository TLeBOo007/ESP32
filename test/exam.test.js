'use strict';
// Exam mode tracker: trailing end-of-day MLL, target, consistency, daily loss, trading-day window, caps.
const assert = require('assert');
const { Exam, dayOf, nyMinute } = require('../lib/exam');

const K = 20000;                                          // an arbitrary trading day number
const at = (day, nyH, nyM = 0) => {                       // server time of New York hh:mm inside trading day `day` (day starts 18:00 NY the evening before)
  const base = day * 86400 + 3600;                        // 18:00 NY
  const m = nyH * 60 + nyM, sinceOpen = (m - 18 * 60 + 1440) % 1440;
  return base + sinceOpen * 60;
};
const T = (day, pnl) => ({ closeT: at(day, 10), pnl });
const ev = (ex, trades, extra = {}) => ex.evaluate({ trades, balance: 50000 + trades.reduce((a, t) => a + t.pnl, 0), serverT: at(K + 10, 10), ...extra });

// day boundary + window helpers
assert.strictEqual(nyMinute(at(K, 18)), 18 * 60); assert.strictEqual(nyMinute(at(K, 9, 30)), 9 * 60 + 30);
assert.strictEqual(dayOf(at(K, 18)), K); assert.strictEqual(dayOf(at(K, 17, 59)), K); assert.strictEqual(dayOf(at(K + 1, 18)), K + 1);
const ex0 = new Exam();
assert(ex0.windowOpen(at(K, 10)) && ex0.windowOpen(at(K, 16, 4)) && !ex0.windowOpen(at(K, 16, 5)) && !ex0.windowOpen(at(K, 17, 59)) && ex0.windowOpen(at(K + 1, 18)));

// trailing MLL: floor = min(start, highest finished-day balance - 2000)
{
  let ex = new Exam();
  let r = ev(ex, []); assert.strictEqual(r.view.floor, 48000); assert.strictEqual(r.view.status, 'active');
  r = ev(ex, [T(K + 1, 1000)]); assert.strictEqual(r.view.floor, 49000, 'after +1000 end-of-day the floor trails to 49,000');
  r = ev(ex, [T(K + 1, 1000), T(K + 2, 1500)]); assert.strictEqual(r.view.floor, 50000, 'floor locks at the start balance');
  r = ev(ex, [T(K + 1, 1000), T(K + 2, 1500), T(K + 3, 3000)]); assert.strictEqual(r.view.floor, 50000, 'it never moves above the start balance');
  // today's profit does not lift the floor until the day is over
  r = ex.evaluate({ trades: [T(K + 10, 1200)], balance: 51200, serverT: at(K + 10, 11) }); assert.strictEqual(r.view.floor, 48000);
}
// failing: equity at / below the floor; balance alone is fine but open loss counts
{
  let ex = new Exam(); const r = ex.evaluate({ trades: [T(K, -1500)], balance: 48500, floating: -600, open: 1, serverT: at(K + 1, 10) });
  assert.strictEqual(r.view.status, 'failed'); assert(r.flatten && r.events.length === 1);
  const r2 = ex.evaluate({ trades: [], balance: 50000, serverT: at(K + 2, 10) }); assert.strictEqual(r2.view.status, 'failed', 'stays failed'); assert.strictEqual(r2.events.length, 0, 'tells you only once');
  assert(!ex.canOpen(r2.view, at(K + 2, 10), 0, 1).ok);
  assert(new Exam({ mllOnEquity: false }).evaluate({ trades: [], balance: 49000, floating: -2000, serverT: at(K, 10) }).view.status === 'active', 'mllOnEquity:false looks at the realised balance only');
}
// pass needs target + consistency + 2 trading days + flat
{
  let ex = new Exam();
  let r = ev(ex, [T(K + 1, 2000), T(K + 2, 1000)]);
  assert.strictEqual(r.view.status, 'active', '66% of the profit came from one day'); assert(!r.view.consistencyOK); assert.strictEqual(r.view.needProfit, 3636.36); assert.strictEqual(r.view.bestPct, 67);
  r = ev(ex, [T(K + 1, 2000), T(K + 2, 1000), T(K + 3, 700)]); assert.strictEqual(r.view.status, 'passed'); assert(r.events[0].includes('ผ่านเกณฑ์สอบ'));
  const ex2 = new Exam(); r = ev(ex2, [T(K + 1, 1600), T(K + 2, 1600)], { open: 1 }); assert.strictEqual(r.view.status, 'active', 'must be flat to pass');
  r = ev(ex2, [T(K + 1, 1600), T(K + 2, 1600)], { open: 0 }); assert.strictEqual(r.view.status, 'passed');
  const one = new Exam(); r = ev(one, [T(K + 1, 3200)]); assert.strictEqual(r.view.status, 'active', 'one day only: consistency (and minimum days) not met');
  assert(!new Exam().canOpen(r.view, at(K + 5, 10), 0, 1).ok === false);
}
// daily loss limit (optional): flatten + block for the rest of that day, account stays alive
{
  const ex = new Exam({ dll: 1000 }); const day = K + 4;
  let r = ex.evaluate({ trades: [{ closeT: at(day, 9), pnl: -700 }], balance: 49300, floating: -350, open: 1, serverT: at(day, 10) });
  assert.strictEqual(r.view.status, 'active'); assert(r.flatten === 'daily loss limit' && r.view.blockedToday); assert.strictEqual(r.view.dllLeft, -50);
  assert(!ex.canOpen(r.view, at(day, 10), 0, 1).ok);
  r = ex.evaluate({ trades: [{ closeT: at(day, 9), pnl: -700 }, { closeT: at(day, 10), pnl: -350 }], balance: 48950, floating: 0, serverT: at(day, 11) });
  assert.strictEqual(r.events.length, 0, 'block announced once'); assert(r.view.blockedToday);
  r = ex.evaluate({ trades: [{ closeT: at(day, 9), pnl: -700 }, { closeT: at(day, 10), pnl: -350 }], balance: 48950, serverT: at(day + 1, 10) });
  assert(!r.view.blockedToday && ex.canOpen(r.view, at(day + 1, 10), 0, 1).ok, 'free again on the next trading day');
  assert.strictEqual(new Exam({ dll: 0 }).evaluate({ trades: [], balance: 40000, floating: 0, serverT: at(day, 10) }).view.dllLeft, null);
}
// trading-day window + caps
{
  const ex = new Exam(); const v = ex.evaluate({ trades: [], balance: 50000, serverT: at(K, 16, 30), open: 1 });
  assert.strictEqual(v.flatten, 'end of trading day'); assert(!ex.canOpen(v.view, at(K, 16, 30), 0, 1).ok);
  assert(ex.canOpen(v.view, at(K, 10), 49, 1).ok); const c = ex.canOpen(v.view, at(K, 10), 50, 1); assert(!c.ok && c.why.startsWith('EXAM_CAP'));
}
console.log('exam tests ok');
