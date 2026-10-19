'use strict';
// Thai status messages for LINE (and Telegram / webhook): pure text builders plus a tiny state keeper, no network here (server.js sends).
//   setup progress   a setup the signal engine is waiting for reaches stage >= minStage (once per stage, per setup)
//   daily summary    one message when the trading day rolls over (nothing happened = nothing sent)
//   feed alerts      a price feed has been failing for a while / is back again
//   on-demand status text for the "สถานะ" chat command (a reply message does not use the push quota)
// Stages of a waiting setup (same as the dashboard banner): 1 sweep, 2 waiting MSS/CISD, 3 waiting FVG, 4 FVG found, 5 M4 box.

const SIDE = d => (d === 1 ? 'BUY' : 'SELL');
const BIAS = { BULL: 'ขึ้น', BEAR: 'ลง', none: 'ไม่ชัด' };
const thBias = b => BIAS[b] || b;
const thWin = s => String(s || '').replace(/NY AM/g, 'นิวยอร์กเช้า').replace(/NY PM/g, 'นิวยอร์กบ่าย').replace(/London/g, 'ลอนดอน').replace(/Asia/g, 'เอเชีย').replace(/\bKZ\b/g, '').replace(/\s+/g, ' ').trim();

function stageText(su, digits) {
  const f = x => Number(x).toFixed(digits), dirW = su.d === 1 ? 'เหนือ' : 'ใต้';
  switch (su.s) {
    case 1: return ['ขั้น 1/4', 'ราคาอยู่ใน POI · รอกวาดสภาพคล่อง'];
    case 2: return ['ขั้น 2/4', su.lv ? `กวาดแล้ว · รอ ${su.ln || 'MSS'} ปิด${dirW} ${f(su.lv)}` : 'กวาดแล้ว · รอจุดอ้างอิง'];
    case 3: return ['ขั้น 3/4', 'ยืนยันกลับตัวแล้ว · รอ FVG เกิด'];
    case 4: return ['ขั้น 4/4', su.x ? `โมเดล ${su.m} ครบเงื่อนไข · ${su.rdy ? 'วาง limit ได้' : 'รอเข้าช่วงเทรด'}` : 'FVG เกิดแล้วแต่ยังไม่ผ่านเงื่อนไขโมเดล'];
    case 5: return ['Model 4', 'เจอกรอบ consolidation · รอปิดทะลุกรอบ'];
    default: return ['', ''];
  }
}
function projText(su, digits) {
  if (!(su.e > 0 && su.sl > 0)) return '';
  const f = x => Number(x).toFixed(digits);
  return `${su.x ? 'จุดเข้า' : 'จุดเข้าที่คาดไว้'} ${f(su.e)}  SL ${f(su.sl)}  TP ${su.tp ? f(su.tp) : '-'}  RR ${su.rr || '-'}`
    + (su.x ? '' : '\n(ประมาณการ ยังไม่ใช่คำสั่งจริง)') + (su.ok || !su.tp ? '' : '\n⚠ RR ต่ำกว่าเกณฑ์ ถ้าไม่ดีขึ้นจะไม่เข้า');
}
function setupLine(sym, su, digits) {          // one setup, two or three lines
  const [a, b] = stageText(su, digits), pj = projText(su, digits);
  return `${sym} ${SIDE(su.d)} · ${a} ${b}` + (pj ? '\n' + pj : '');
}

class Status {
  constructor(o = {}) { this.minStage = o.minStage === undefined ? 3 : o.minStage; this.seen = {}; this.feedBad = {}; this.alerted = {}; this.feedMin = o.feedMin || 15; this.endBars = o.endBars || 6; }
  // Call after every closed bar of an instrument with its current setup brief (null when none). Returns the message to send, or null.
  setup(sym, su, digits) {
    if (!su) { if (this.seen[sym] && ++this.seen[sym].miss >= this.endBars) delete this.seen[sym]; return null; }   // a setup is over only after it was gone for a while (a one-bar gap is not the end)
    if (this.seen[sym]) this.seen[sym].miss = 0;
    const prev = this.seen[sym];
    if (prev && prev.d === su.d && su.s <= prev.s) return null;           // same setup, no progress
    this.seen[sym] = { d: su.d, s: su.s, miss: 0 };
    if (!this.minStage || su.s < this.minStage) return null;
    if (su.s === 4 && su.x && su.rdy) return null;                         // the order message follows right away
    return '👀 ' + setupLine(sym, su, digits);
  }
  // Call about once a minute: states = [{sym, error, now}] (error = '' when the feed is fine). Returns a message or null.
  feeds(states) {
    const bad = [], back = [];
    for (const s of states) {
      if (s.error) {
        if (!this.feedBad[s.sym]) this.feedBad[s.sym] = s.now;
        if (!this.alerted[s.sym] && s.now - this.feedBad[s.sym] >= this.feedMin * 60) { this.alerted[s.sym] = true; bad.push(`${s.sym}: ${s.error}`); }
      } else {
        if (this.alerted[s.sym]) back.push(s.sym);
        delete this.feedBad[s.sym]; delete this.alerted[s.sym];
      }
    }
    const out = [];
    if (bad.length) out.push(`⚠️ ฟีดราคาไม่เข้า (นานกว่า ${this.feedMin} นาที)\n` + bad.join('\n'));
    if (back.length) out.push(`✅ ฟีดราคากลับมาแล้ว: ${back.join(', ')}`);
    return out.length ? out.join('\n\n') : null;
  }
}

const money = x => (x >= 0 ? '+' : '') + Number(x).toFixed(2);
// d = { date: 'YYYY-MM-DD', balance, dayStart, trades: [{sym, pnl, R}], signals, setups }
function dailyText(d) {
  const n = d.trades.length, wins = d.trades.filter(t => t.pnl > 0).length, pnl = d.trades.reduce((a, t) => a + t.pnl, 0), R = d.trades.reduce((a, t) => a + (t.R || 0), 0);
  if (!n && !d.signals && !d.setups) return null;                          // quiet day (weekend): nothing to say
  const by = {}; for (const t of d.trades) { const b = by[t.sym] = by[t.sym] || { n: 0, pnl: 0, R: 0 }; b.n++; b.pnl += t.pnl; b.R += t.R || 0; }
  const lines = [`📊 สรุปวัน ${d.date}`,
    n ? `ไม้ที่ปิด ${n} (ชนะ ${wins}, แพ้ ${n - wins})  กำไร/ขาดทุน ${money(pnl)}  (${R >= 0 ? '+' : ''}${R.toFixed(2)}R)` : 'ไม่มีไม้ที่ปิดวันนี้',
    `ยอดเงิน ${Number(d.balance).toFixed(2)}  (วันนี้ ${money(d.balance - d.dayStart)})`,
    `สัญญาณที่ระบบสร้าง ${d.signals} · setup ที่แจ้ง ${d.setups}`];
  const sy = Object.keys(by); if (sy.length) lines.push(sy.map(s => `${s} ${by[s].n} ไม้ ${money(by[s].pnl)} (${by[s].R >= 0 ? '+' : ''}${by[s].R.toFixed(2)}R)`).join('\n'));
  return lines.join('\n');
}

// d = { balance, dayStart, open, pending, symbols: [{sym, digits, bid, bias, biasH4, biasD1, kz, su, tr}], feedKind }
function statusText(d) {
  const lines = [`📋 สถานะ [PAPER]`, `ยอดเงิน ${Number(d.balance).toFixed(2)}  (วันนี้ ${money(d.balance - d.dayStart)})  เปิดอยู่ ${d.open} · ลิมิตรอ ${d.pending}`];
  for (const s of d.symbols) {
    const px = s.bid ? Number(s.bid).toFixed(s.digits) : '-';
    let st;
    if (s.tr) st = `${s.tr.k === 'pos' ? 'มีไม้เปิด' : 'ลิมิตรอเข้า'} ${SIDE(s.tr.side)} @ ${Number(s.tr.px).toFixed(s.digits)}`;
    else if (s.su) st = '\n   ' + setupLine(s.sym, s.su, s.digits).replace(/\n/g, '\n   ');
    else st = 'ยังไม่มี setup';
    lines.push(`• ${s.sym} ${px} · ทิศ ${thBias(s.bias)} (H4 ${thBias(s.biasH4)}/D1 ${thBias(s.biasD1)}) · ${thWin(s.kz) || '-'} · ${st}`);
  }
  return lines.join('\n');
}

module.exports = { Status, stageText, setupLine, dailyText, statusText };
