'use strict';
// Replays an MT4/MT5 M5 export (time,open,high,low,close,volume; time = broker server time) through the BPE engine with a simple
// paper broker and prints the result per model. Usage: node tools/replay_models.js <csv> [JSON config] [path to bpe.js]
const fs = require('fs'), path = require('path');
const csv = process.argv[2]; if (!csv) { console.log('usage: node tools/replay_models.js <M5 csv> [json cfg] [bpe.js]'); process.exit(1); }
const cfg = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const { Bpe } = require(path.resolve(process.argv[4] || path.join(__dirname, '../lib/bpe.js')));
const rows = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/).filter(l => /^\d{4}\./.test(l)).map(l => {
  const [ts, o, h, l2, c] = l.split(','); const m = ts.match(/(\d+)\.(\d+)\.(\d+) (\d+):(\d+)/);
  return [Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000, +o, +h, +l2, +c];
});
const sim = { bal: 1000, id: 1, live: [], dayKey: -1, dayStart: 1000, opened: 0, trades: [] };
const host = {
  ours: () => sim.live.map(x => ({ type: ['buy', 'sell', 'buylimit', 'selllimit'][x.type], pending: x.type >= 2, openT: x.t, tp: x.tp, sl: x.sl, price: x.op })),
  balance: () => sim.bal, today: () => ({ opened: sim.opened, pl: sim.bal - sim.dayStart }),
  sync: day0 => { if (day0 !== sim.dayKey) { sim.dayKey = day0; sim.dayStart = sim.bal; sim.opened = 0; } },
};
const bpe = new Bpe(Object.assign({ symbol: 'US100' }, cfg), host);
const close = (x, px, t, why) => { const d = x.type === 0 ? 1 : -1; sim.bal += d * (px - x.op) * x.vol / 100; sim.live.splice(sim.live.indexOf(x), 1);
  sim.trades.push({ cmt: x.cmt, why, R: d * (px - x.op) / Math.abs(x.op - x.sl), pnl: d * (px - x.op) * x.vol / 100, t, sig: x.sig }); };
const S = 3000; let sends = 0; const sigBy = {};
for (let i = 0; i < S; i++) bpe.addHistory(...rows[i].slice(0, 5));
for (let i = S; i < rows.length; i++) {
  const [t, o, h, l, c] = rows[i];
  for (const a of bpe.evaluate(t, { bid: o, ask: o })) {
    if (a.action === 'cancel') { sim.live = sim.live.filter(x => x.type <= 1); continue; }
    if (a.action === 'close' || sim.live.length) continue;
    sends++; sigBy[a.model] = (sigBy[a.model] || 0) + 1; if (a.type <= 1) sim.opened++;
    sim.live.push({ type: a.type, vol: Math.round(a.lots * 100), op: a.type <= 1 ? o : a.price, sl: a.sl, tp: a.tp, t, cmt: a.comment, sig: a });
  }
  for (const x of sim.live.slice()) {
    if (x.type === 2 && l <= x.op) { x.type = 0; sim.opened++; } if (x.type === 3 && h >= x.op) { x.type = 1; sim.opened++; }
    if (x.type === 0) { if (l <= x.sl) close(x, Math.min(o, x.sl), t, 'SL'); else if (h >= x.tp) close(x, x.tp, t, 'TP'); }
    else if (x.type === 1) { if (h >= x.sl) close(x, Math.max(o, x.sl), t, 'SL'); else if (l <= x.tp) close(x, x.tp, t, 'TP'); }
  }
  bpe.addHistory(t, o, h, l, c);
}
const by = {}; for (const t of sim.trades) { const k = t.cmt.replace(/^BPE /, ''); const b = by[k] = by[k] || { n: 0, w: 0, R: 0 }; b.n++; if (t.pnl > 0) b.w++; b.R += t.R; }
console.log(`bars ${rows.length - S}  signals ${sends}  closed ${sim.trades.length}  balance ${sim.bal.toFixed(2)}  indexErrors ${bpe.indexError ? 1 : 0}`);
console.log('  signals by model: ' + JSON.stringify(sigBy) + '  (signals that did not fill expired/cancelled)');
for (const k of Object.keys(by).sort()) console.log(`  ${k.padEnd(12)} n=${String(by[k].n).padStart(3)} win=${(100 * by[k].w / by[k].n).toFixed(0)}%  sumR=${by[k].R.toFixed(2)}`);
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(sim.trades.map(t => ({ cmt: t.cmt, R: t.R, why: t.sig.why.text })), null, 1));
