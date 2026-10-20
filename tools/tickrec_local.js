'use strict';
// รันตัวบันทึก footprint บน "คอมของคุณเอง" (ไม่ผ่าน Railway/VPS) - เก็บข้อมูลเท่านั้น ไม่เรียก endpoint ส่งออเดอร์
//   npm i @microsoft/signalr
//   TOPSTEP_USER=... TOPSTEP_KEY=... [TOPSTEP_API=...] [OUT_DIR=./footprint] node tools/tickrec_local.js
// ปล่อยให้รันค้างไว้ได้ ไฟล์รายวันอยู่ใน OUT_DIR (หนึ่งบรรทัดต่อหนึ่งแท่ง 5 นาที) ใช้ทดสอบย้อนหลังได้ทันที
const path = require('path');
const { TickRec } = require('../lib/tickrec');
const user = process.env.TOPSTEP_USER, key = process.env.TOPSTEP_KEY;
if (!user || !key) { console.log('ตั้ง TOPSTEP_USER และ TOPSTEP_KEY ก่อน'); process.exit(1); }
const r = new TickRec({
  user, key, api: process.env.TOPSTEP_API, hub: process.env.TOPSTEP_HUB, symbol: process.env.TICKREC_SYMBOL || 'MNQ',
  dir: path.resolve(process.env.OUT_DIR || './footprint'), log: m => console.log(new Date().toISOString(), m),
  signalR: require('@microsoft/signalr'),
  fetchJson: async (url, o) => JSON.parse(await (await fetch(url, { ...o, signal: AbortSignal.timeout(20000) })).text()),
});
r.start();
setInterval(() => { const s = r.status(); console.log(new Date().toISOString(), s.state, 'trades', s.trades, 'bars', s.bars, 'age', s.lastTradeAgeSec + 's', 'sidePct', s.sidePct); }, 60000);
process.on('SIGINT', async () => { await r.stop(); process.exit(0); });
