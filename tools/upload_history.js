'use strict';
// Loads past M5 bars into the signal engine (it needs about 12 days for the D1 bias and ~120 for a full picture).
//   node tools/upload_history.js <file.csv> <https://xxxx.up.railway.app> <API_KEY> [--utc]
// CSV: either "time,open,high,low,close,volume" with time like 2025.11.12 09:30 (MT4 export) or "epoch,o,h,l,c[,v]".
// Times are taken as broker SERVER time (New York + 7h) unless --utc is given.
const fs = require('fs');
const [file, url, key] = process.argv.slice(2), utc = process.argv.includes('--utc');
if (!file || !url || !key) { console.log('usage: node tools/upload_history.js file.csv https://xxxx.up.railway.app API_KEY [--utc]'); process.exit(1); }
const rows = [];
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const p = line.trim().split(/[,;]/); if (p.length < 5) continue;
  let t = Number(p[0]);
  if (!Number.isFinite(t)) { const m = /^(\d{4})[.\-/](\d\d)[.\-/](\d\d)[ T](\d\d):(\d\d)/.exec(p[0]); if (!m) continue; t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000; }
  const [o, h, l, c] = p.slice(1, 5).map(Number); if (![o, h, l, c].every(Number.isFinite)) continue;
  rows.push([t, o, h, l, c]);
}
rows.sort((a, b) => a[0] - b[0]);
(async () => {
  console.log(rows.length + ' bars read'); let added = 0, last;
  for (let i = 0; i < rows.length; i += 5000) {
    const r = await fetch(url.replace(/\/$/, '') + '/api/history', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ serverTime: !utc, bars: rows.slice(i, i + 5000) }) });
    const j = await r.json(); if (!r.ok) { console.error('failed:', r.status, j); process.exit(1); }
    added += j.added; last = j;
  }
  console.log('added ' + added + ' bars. stored: M5 ' + last.m5 + ', H4 ' + last.h4 + ', D1 ' + last.d1);
})();
