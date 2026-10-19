'use strict';
// Waiting-setup preview: replays real M5 bars (BPE_CSV = MT4 export "time,open,high,low,close,volume", server time) and checks every preview the engine
// publishes makes sense: stages in order, SL < entry < TP for buys (mirrored for sells), zones with top >= bottom, and that it vanishes once an order exists.
const fs = require('fs'), assert = require('assert');
const { Bpe } = require('../lib/bpe.js');
const csv = process.env.BPE_CSV; if (!csv || !fs.existsSync(csv)) { console.log('preview test skipped (set BPE_CSV)'); process.exit(0); }
const rows = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/).filter(l => /^\d{4}\./.test(l)).map(l => { const [ts, o, h, l2, c] = l.split(','); const m = ts.match(/(\d+)\.(\d+)\.(\d+) (\d+):(\d+)/); return [Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000, +o, +h, +l2, +c]; }).slice(-20000);
let ours = [];
const bpe = new Bpe({ symbol: 'US100' }, { balance: () => 1000, today: () => ({ opened: 0, pl: 0 }), ours: () => ours });
const seen = {}, bad = [];
for (let i = 0; i < 3000; i++) bpe.addHistory(...rows[i]);
for (let i = 3000; i < rows.length; i++) {
  const [t, o, h, l, c] = rows[i];
  const acts = bpe.evaluate(t, { bid: o, ask: o + 0.5 }), p = bpe.preview;
  if (acts.some(a => a.action.includes('buy') || a.action.includes('sell'))) { assert.strictEqual(p, null, 'preview must be cleared once an order is sent'); }
  if (p) {
    seen[p.stage] = (seen[p.stage] || 0) + 1;
    const d = p.dir; assert(d === 1 || d === -1);
    const pr = p.proj;
    if (pr) { const ok = d === 1 ? pr.sl < pr.entry && (pr.tp === 0 || pr.entry < pr.tp) : pr.sl > pr.entry && (pr.tp === 0 || pr.entry > pr.tp); if (!ok) bad.push(['order of sl/entry/tp', p.stage, d, pr]); }
    if (p.zone && !(p.zone.top >= p.zone.bot)) bad.push(['zone', p.stage, p.zone]);
    if (p.band && !(p.band.top >= p.band.bot)) bad.push(['band', p.stage, p.band]);
    if (p.stage === 'sweep') assert(p.poi && Array.isArray(p.levels));
    if (p.stage === 'mss' && p.range) assert(d === 1 ? p.range.to >= p.range.from : p.range.to <= p.range.from, 'range runs away from the sweep extreme');
    if (p.stage === 'fvg' && p.exact) assert(p.zone && p.model);
  }
  bpe.addHistory(t, o, h, l, c);
}
assert.deepStrictEqual(bad, [], JSON.stringify(bad.slice(0, 3)));
assert(seen.sweep > 0 && seen.mss > 0, 'saw the early stages: ' + JSON.stringify(seen));
console.log('preview ok', JSON.stringify(seen));
