'use strict';
// ตรวจฟีดราคา Topstep: ดึงแท่ง M5 ล่าสุดของ MNQ (หรือ SYMBOL=MES ...) แล้วพิมพ์ออกมาให้ดูว่าเวลาและราคาถูกต้องไหม
//   TOPSTEP_USER=... TOPSTEP_KEY=... [TOPSTEP_API=...] [TOPSTEP_LIVE=1] [SYMBOL=MNQ] node tools/probe_bars.js
const { TopstepBars } = require('../lib/topstep');
const user = process.env.TOPSTEP_USER, key = process.env.TOPSTEP_KEY;
if (!user || !key) { console.log('ตั้ง TOPSTEP_USER และ TOPSTEP_KEY ก่อน'); process.exit(1); }
const ts = new TopstepBars({ user, key, api: process.env.TOPSTEP_API, live: process.env.TOPSTEP_LIVE === '1', label: process.env.TOPSTEP_BAR_LABEL === 'end' ? 'end' : 'start',
  now: () => Math.floor(Date.now() / 1000), log: m => console.log(m),
  post: async (url, body, headers) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', accept: 'text/plain', ...headers }, body: JSON.stringify(body) }); if (!r.ok) throw new Error('HTTP ' + r.status); return JSON.parse(await r.text()); } });
const sym = process.env.SYMBOL || 'MNQ', now = Math.floor(Date.now() / 1000);
ts.bars(sym, now - 3 * 3600, now).then(rows => {
  console.log(`${sym}: ${rows.length} แท่งใน 3 ชั่วโมงล่าสุด (เวลา UTC / เวลาไทย) - แท่งสุดท้ายอาจยังไม่ปิด`);
  for (const r of rows.slice(-8)) console.log(new Date(r[0] * 1000).toISOString(), '|', new Date(r[0] * 1000 + 7 * 3600e3).toISOString().slice(11, 16), 'ไทย | O', r[1], 'H', r[2], 'L', r[3], 'C', r[4]);
  console.log('\nตรวจ: (1) เวลาแท่งควรลงท้าย :00/:05/:10... (2) ราคา MNQ ควรใกล้ NQ ที่เห็นในแพลตฟอร์ม (3) ถ้าเวลาเลื่อนไป 5 นาทีเมื่อเทียบกับแพลตฟอร์ม ให้ตั้ง TOPSTEP_BAR_LABEL=end');
}).catch(e => { console.log('error:', e.message); process.exit(1); });
