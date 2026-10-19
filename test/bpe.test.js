'use strict';
// Replays the real US100 M5 file through the JS port with the same simulated broker as the C++ desktop test of the
// original EA logic, and compares every order and the final balance. Needs BPE_CSV=<path to z_5.csv> (t,o,h,l,c,v in server time).
const fs = require('fs'), path = require('path');
const { Bpe } = require('../lib/bpe.js');
const csv = process.env.BPE_CSV;
if (!csv || !fs.existsSync(csv)) { console.log('bpe replay test skipped (set BPE_CSV)'); process.exit(0); }
const rows = fs.readFileSync(csv, 'utf8').trim().split('\n').map(l => l.split(',').map(Number));
const S = 3000, out = [];
const sim = { o: [], bal: 1000, id: 1000, dayKey: -1, dayStart: 0, opened: 0, live: [], gNow: 0 };
const fmt = x => x.toFixed(2);
const host = {
  ours: () => sim.live.filter(x => x.open).map(x => ({ type: ['buy', 'sell', 'buylimit', 'selllimit'][x.type], pending: x.type >= 2, openT: x.t, tp: x.tp, sl: x.sl, price: x.op })),
  balance: () => sim.bal,
  today: () => ({ opened: sim.opened, pl: sim.bal - sim.dayStart }),
  sync: day0 => {
    if (day0 !== sim.dayKey) { sim.dayKey = day0; sim.dayStart = sim.bal; sim.opened = 0; }
    const fresh = sim.o.filter(x => x.open);
    for (const old of sim.live) if (old.type <= 1 && !fresh.includes(old) && old.t >= sim.dayKey) sim.opened++;
    sim.live = fresh.slice();
  },
};
const bpe = new Bpe({ symbol: 'US100', setupMode: 'legacy' }, host)   // the golden file was made with the original Turtle Soup / Unicorn logic;
function closeAt(x, px, t, why) {
  const d = x.type === 0 ? 1 : -1; x.open = false; sim.bal += d * (px - x.op) * (x.vol / 100);
  out.push(`CLOSE ${t} ${why} side=${d} op=${fmt(x.op)} sl=${fmt(x.sl)} tp=${fmt(x.tp)} px=${fmt(px)} R=${fmt(d * (px - x.op) / Math.abs(x.op - x.sl0))} cmt=${x.cmt}`);
}
function simBar(op, h, l, t) {
  for (const x of sim.o) {
    if (!x.open) continue;
    if (x.type === 2 && l <= x.op) x.type = 0;
    if (x.type === 3 && h >= x.op) x.type = 1;
    if (x.type === 0) { if (l <= x.sl) closeAt(x, Math.min(op, x.sl), t, 'SL'); else if (h >= x.tp) closeAt(x, x.tp, t, 'TP'); }
    else if (x.type === 1) { if (h >= x.sl) closeAt(x, Math.max(op, x.sl), t, 'SL'); else if (l <= x.tp) closeAt(x, x.tp, t, 'TP'); }
  }
}
for (let i = 0; i < S; i++) bpe.addHistory(rows[i][0], rows[i][1], rows[i][2], rows[i][3], rows[i][4]);
for (let i = S; i < rows.length; i++) {
  const [t, o, h, l, c] = rows[i];
  const acts = bpe.evaluate(t, { bid: o, ask: o });
  for (const a of acts) {
    if (a.action === 'cancel') { for (const x of sim.o) if (x.open && x.type >= 2) { x.open = false; out.push(`DELETE ${t}`); } continue; }
    if (a.action === 'close') continue;
    const vol = Math.round(a.lots * 100), op = a.type <= 1 ? o : a.price;
    sim.o.push({ id: sim.id++, type: a.type, vol, op, sl: a.sl, tp: a.tp, sl0: a.sl, t, cmt: a.comment, open: true });
    out.push(`SEND ${t} type=${a.type} lots=${fmt(vol / 100)} pr=${fmt(op)} sl=${fmt(a.sl)} tp=${fmt(a.tp)} ${a.comment}`);
  }
  simBar(o, h, l, t);
  bpe.addHistory(t, o, h, l, c);
}
out.push(`END bal=${fmt(sim.bal)} indexErrors=${bpe.indexError ? 1 : 0}`);
const gold = fs.readFileSync(path.join(__dirname, 'golden_bpe_z5.txt'), 'utf8').trim().split('\n');
let bad = 0; const n = Math.max(gold.length, out.length);
for (let i = 0; i < n; i++) if (gold[i] !== out[i]) { if (bad++ < 5) console.log('DIFF line ' + (i + 1) + '\n  want ' + gold[i] + '\n  got  ' + out[i]); }
if (bad) { console.log('bpe replay FAILED: ' + bad + ' differing lines'); process.exit(1); }
console.log('bpe replay ok: ' + out.filter(l => l.startsWith('SEND')).length + ' orders, ' + out[out.length - 1]);
