'use strict';
// Support / resistance + trend strategy ("SR"). Replaces the BPE (ICT) signal engine. Pure logic, no I/O.
// Rule (fixed before it was tested; do not tune it on a handful of trades):
//   levels of the day  : PDH / PDL = high / low of the previous day's regular session (09:30-16:00 New York)
//                        ONH / ONL = high / low of the overnight session (18:00 New York the day before -> 09:30)
//   trigger            : in the NY AM window (bars starting 09:30-11:55 NY), the FIRST touch of a level that closes back on the
//                        right side (support: low <= level and close > level, level below the previous close; resistance mirrored).
//                        Each level is used once per day, also when the trade is then filtered out.
//   trend filter       : trade only WITH the trend. Trend = sign(EMA20 - EMA50) of H1 closes, last COMPLETED hour.
//   entry / stop / tp  : market at the close of the trigger bar; stop = level -/+ stopAtr x ATR14 (of the bar before the trigger); target = rr x risk.
//   flat               : everything is closed at flatNY (16:00 New York).
// Known property of the backtest this mirrors: the days whose previous data date had no regular session (Mondays: the Sunday evening
// session counts as a date; the day after a holiday) were skipped. `mondays: true` uses the last regular-session day instead (untested).
// Footprint confirmation is NOT part of this version: in the 2025 test it added nothing measurable over the trend filter.
const DAY = 86400;
const DEFAULTS = { rr: 2, atrN: 14, stopAtr: 0.825, levelAtr: 0.75, maxRisk: 60, winFrom: 9 * 60 + 30, winTo: 12 * 60, rthFrom: 9 * 60 + 30, rthTo: 16 * 60, onFrom: 18 * 60, flatNY: 16 * 60,
  fast: 20, slow: 50, minOnBars: 20, mondays: false, keepBars: 2400, contracts: 2, oneAtATime: true };
const r2 = x => Math.round(x * 1e6) / 1e6;
const sign = x => (x > 0 ? 1 : x < 0 ? -1 : 0);

class Sr {
  constructor(cfg = {}) {
    this.c = { ...DEFAULTS, ...cfg };
    this.t = []; this.o = []; this.h = []; this.l = []; this.cl = [];            // M5 bars, t = bar start in New York wall-clock seconds
    this.h1 = { key: null, close: 0, e1: null, e2: null, n: 0, trend: 0 };       // hourly closes -> EMA20 / EMA50 (adjust = false, like pandas ewm)
    this.used = []; this.usedDay = -1; this.last = null; this.levels = null; this.levelsDay = -1; this.signals = 0;
  }
  ny(serverT) { return serverT - 7 * 3600; }

  _hour(t, c) {
    const k = Math.floor(t / 3600), H = this.h1;
    if (H.key !== null && k !== H.key) {                     // the hour H.key is complete: its last close feeds the EMAs
      const a1 = 2 / (this.c.fast + 1), a2 = 2 / (this.c.slow + 1);
      H.e1 = H.e1 === null ? H.close : a1 * H.close + (1 - a1) * H.e1;
      H.e2 = H.e2 === null ? H.close : a2 * H.close + (1 - a2) * H.e2; H.n++;
      H.trend = H.n >= this.c.slow ? sign(H.e1 - H.e2) : 0;      // not enough hours yet -> no trend -> no trade
    }
    H.key = k; H.close = c;
  }
  _push(t, o, h, l, c) {
    if (this.t.length && t <= this.t[this.t.length - 1]) return false;
    this.t.push(t); this.o.push(o); this.h.push(h); this.l.push(l); this.cl.push(c);
    const over = this.t.length - this.c.keepBars;
    if (over > 0) { this.t.splice(0, over); this.o.splice(0, over); this.h.splice(0, over); this.l.splice(0, over); this.cl.splice(0, over); }
    return true;
  }
  addHistory(serverT, o, h, l, c) { const t = this.ny(serverT); if (!this._push(t, o, h, l, c)) return false; this._hour(t, c); return true; }

  atrBefore(i) {                                              // rolling mean of true range over the atrN bars ending at bar i (inclusive)
    const n = this.c.atrN; if (i < n) return 0;
    let s = 0; for (let k = i - n + 1; k <= i; k++) s += Math.max(this.h[k] - this.l[k], Math.abs(this.h[k] - this.cl[k - 1]), Math.abs(this.l[k] - this.cl[k - 1]));
    return s / n;
  }
  _levels(day) {
    const t = this.t, c = this.c, mins = x => (x % DAY) / 60;
    const days = new Set(); for (const x of t) days.add(Math.floor(x / DAY));
    const sorted = [...days].sort((a, b) => a - b), idx = sorted.indexOf(day); if (idx <= 0) return null;
    const rthHL = d => { let hi = -Infinity, lo = Infinity; for (let i = 0; i < t.length; i++) if (Math.floor(t[i] / DAY) === d && mins(t[i]) >= c.rthFrom && mins(t[i]) < c.rthTo) { hi = Math.max(hi, this.h[i]); lo = Math.min(lo, this.l[i]); } return hi > -Infinity ? { hi, lo } : null; };
    let prev = sorted[idx - 1], p = rthHL(prev);
    if (!p && c.mondays) { for (let k = idx - 1; k >= 0 && !p; k--) { prev = sorted[k]; p = rthHL(prev); } }
    if (!p) return null;                                          // previous data date has no regular session (Monday / after a holiday)
    const from = (c.mondays ? prev : sorted[idx - 1]) * DAY + c.onFrom * 60, to = day * DAY + c.winFrom * 60; let hi = -Infinity, lo = Infinity, n = 0;
    for (let i = 0; i < t.length; i++) if (t[i] >= from && t[i] < to) { hi = Math.max(hi, this.h[i]); lo = Math.min(lo, this.l[i]); n++; }
    if (n < c.minOnBars) return null;
    return { PDH: p.hi, PDL: p.lo, ONH: hi, ONL: lo };
  }

  // One CLOSED M5 bar (serverT = bar start, server time). quote = { bid, ask } at the close. Returns { actions: [...], flat: bool }.
  onBar(serverT, o, h, l, c, quote = {}) {
    const t = this.ny(serverT), out = { actions: [], flat: false };
    const trendBefore = this.h1.trend;                         // completed hours only: the hour of this bar is not complete yet
    const fresh = this._push(t, o, h, l, c); if (!fresh) return out;
    this._hour(t, c);
    const i = this.t.length - 1, day = Math.floor(t / DAY), m = (t % DAY) / 60, cf = this.c;
    this.last = { t, c, day, m };
    if (m >= cf.flatNY && m < cf.onFrom) out.flat = true;
    if (day !== this.usedDay) { this.used = []; this.usedDay = day; }
    if (m < cf.winFrom || m >= cf.winTo || i < cf.atrN + 2) return out;
    if (this.levelsDay !== day) { this.levels = this._levels(day); this.levelsDay = day; }
    if (!this.levels) return out;
    const A = this.atrBefore(i - 1); if (!(A > 0)) return out;
    const prevC = this.cl[i - 1], bid = quote.bid > 0 ? quote.bid : c, ask = quote.ask > 0 ? quote.ask : c;
    for (const nm of ['PDH', 'PDL', 'ONH', 'ONL']) {
      if (this.used.includes(nm)) continue;
      const L = this.levels[nm]; let d = 0;
      if (L < prevC && l <= L && c > L) d = 1; else if (L > prevC && h >= L && c < L) d = -1; else continue;
      this.used.push(nm);
      if (trendBefore !== d) continue;                         // against the trend (or no trend yet): the level is spent, no trade
      const ent = d === 1 ? ask : bid, sl = d === 1 ? L - cf.stopAtr * A : L + cf.stopAtr * A, risk = (ent - sl) * d;
      if (!(risk > 0) || risk > cf.maxRisk) continue;
      const tp = ent + d * cf.rr * risk; this.signals++;
      const txt = `${nm} ${d === 1 ? 'รับ' : 'ต้าน'} ${r2(L)} ราคาแตะแล้วปิดกลับ | เทรนชั่วโมง ${d === 1 ? 'ขึ้น' : 'ลง'} (EMA${cf.fast}/${cf.slow}) | ATR ${A.toFixed(2)} | ความเสี่ยง ${risk.toFixed(2)} | RR ${cf.rr}`;
      out.actions.push({ action: d === 1 ? 'buy' : 'sell', price: ent, sl, tp, level: nm, risk, rr: cf.rr, comment: 'SR ' + nm, why: { text: txt, chain: [`แนว ${nm} = ${r2(L)}`, `ATR14 ก่อนแท่งสัญญาณ = ${A.toFixed(2)}`, `Stop = แนว ${d === 1 ? '-' : '+'} ${cf.stopAtr} ATR = ${r2(sl)}`, `เป้า = ${cf.rr}R = ${r2(tp)}`] } });
    }
    return out;
  }

  status() {
    const lv = this.levels && this.levelsDay === (this.last ? this.last.day : -2) ? this.levels : null;
    return { enabled: true, strategy: 'sr', bars: this.t.length, hours: this.h1.n, trend: this.h1.trend, trendText: this.h1.trend > 0 ? 'ขึ้น' : this.h1.trend < 0 ? 'ลง' : 'ยังไม่พอข้อมูล',
      levels: lv ? Object.keys(lv).map(k => ({ name: k, price: r2(lv[k]), used: this.used.includes(k) })) : [], lastT: this.last ? this.last.t : 0, signals: this.signals,
      state: lv ? `วันนี้มีแนว ${lv ? 4 : 0} ระดับ ใช้แล้ว ${this.used.length}` : 'วันนี้ไม่มีแนว (วันจันทร์/หลังวันหยุด หรือข้อมูลยังไม่พอ)' };
  }
  serialize() { return { t: this.t, o: this.o, h: this.h, l: this.l, c: this.cl, h1: this.h1, used: this.used, usedDay: this.usedDay, signals: this.signals }; }
  load(s) {
    if (!s || !Array.isArray(s.t)) return;
    this.t = s.t; this.o = s.o; this.h = s.h; this.l = s.l; this.cl = s.c; this.h1 = { ...this.h1, ...s.h1 }; this.used = s.used || []; this.usedDay = s.usedDay ?? -1; this.signals = s.signals || 0; this.levelsDay = -1;
  }
}
module.exports = { Sr, DEFAULTS };
