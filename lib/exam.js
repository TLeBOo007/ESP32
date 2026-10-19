'use strict';
// Exam mode: tracks a paper account against a Topstep-style evaluation (Trading Combine).
// Pure logic, no I/O. Every number is a setting (defaults = the $50K Combine as published in Oct 2026; CHECK them with Topstep
// before relying on them, and fill in the ones that depend on the plan you buy: daily loss limit, commission).
//
// Rules modelled (all times are "server time" = New York + 7 h, the frame the rest of the server uses):
//   - profit target: realised profit >= target
//   - Maximum Loss Limit (MLL): a floor that starts at start - mll and trails the highest END-OF-DAY balance upward, but never above
//     the starting balance (so it locks at the start balance). Equity (balance + open P/L) at or below the floor = failed.
//   - Daily Loss Limit (optional, dll > 0): the day's P/L (realised + open) at or below -dll => everything is closed and trading
//     is blocked for the rest of that trading day (the account is NOT failed).
//   - Consistency: the best single day must not exceed `consistency` (0.55) of total profit; otherwise the profit needed is bestDay / consistency.
//   - Minimum trading days: days with at least one closed trade.
//   - Trading day: 17:00 -> 15:10 Central = 18:00 -> 16:10 New York. We close everything at `flatNY` (16:05) and block until `openNY` (18:00).
//   - Contract cap: micros (contracts), summed over every instrument. 10 micros = 1 mini.
// Passing needs the account to be flat. After pass / fail the account is locked (no new trades).

const DEFAULTS = {
  start: 50000, target: 3000, mll: 2000, dll: 0, consistency: 0.55, minDays: 2,
  flatNY: 16 * 60 + 5, openNY: 18 * 60, capContracts: 50, riskPct: 0.5, mllOnEquity: true, commissionRT: 0,
};
const DAY = 86400;
const dayOf = serverT => Math.floor((serverT - 3600) / DAY);            // trading day rolls at 18:00 New York = 01:00 server time
const nyMinute = serverT => (((serverT - 7 * 3600) % DAY) + DAY) % DAY / 60 | 0;
const r2 = x => Math.round(x * 100) / 100;

class Exam {
  constructor(cfg = {}, saved = {}) {
    this.c = { ...DEFAULTS, ...cfg };
    this.st = { status: 'active', reason: '', t: 0, blockedDay: null, ...saved };
  }
  serialize() { return { ...this.st }; }
  reset() { this.st = { status: 'active', reason: '', t: 0, blockedDay: null }; }
  windowOpen(serverT) { const m = nyMinute(serverT); return !(m >= this.c.flatNY && m < this.c.openNY); }

  // trades: closed trades [{closeT (server time), pnl}] of ALL instruments; balance: realised account balance; floating: open P/L (all instruments);
  // open: number of open positions; serverT: now in server time.
  // Returns { view, flatten: reason|'' , events: [text] }. Changes this.st only on a state change (status / daily block).
  evaluate({ trades, balance, floating = 0, open = 0, serverT }) {
    const c = this.c, today = dayOf(serverT), days = {};
    for (const t of trades) { const k = dayOf(t.closeT), d = days[k] = days[k] || { pnl: 0, n: 0 }; d.pnl += t.pnl; d.n++; }
    const keys = Object.keys(days).map(Number).sort((a, b) => a - b);
    let cum = c.start, peak = c.start;
    for (const k of keys) { cum += days[k].pnl; if (k < today) peak = Math.max(peak, cum); }        // only finished days set the end-of-day high
    const floor = Math.min(c.start, peak - c.mll), equity = balance + floating, level = c.mllOnEquity ? equity : balance;
    const profit = balance - c.start, dayPnl = (days[today] ? days[today].pnl : 0) + floating;
    let best = 0; for (const k of keys) best = Math.max(best, days[k].pnl);
    const consistencyOK = profit > 0 && best <= c.consistency * profit + 1e-9, needProfit = Math.max(c.target, c.consistency > 0 ? best / c.consistency : 0);
    const tradingDays = keys.filter(k => days[k].n > 0).length;
    const events = []; let flatten = '';

    if (this.st.status === 'active') {
      if (level <= floor + 1e-9) {
        this.st.status = 'failed'; this.st.reason = 'MLL'; this.st.t = serverT; flatten = 'exam failed: maximum loss limit';
        events.push(`❌ สอบไม่ผ่าน: ยอดถึง Maximum Loss Limit (${r2(level)} ≤ ${r2(floor)}) ปิดทุกไม้และหยุดเทรดแล้ว`);
      } else if (profit >= c.target - 1e-9 && consistencyOK && tradingDays >= c.minDays && open === 0) {
        this.st.status = 'passed'; this.st.reason = 'TARGET'; this.st.t = serverT;
        events.push(`🏆 ผ่านเกณฑ์สอบ! กำไร ${r2(profit)} (เป้า ${c.target}) วันเทรด ${tradingDays} วัน วันที่ดีที่สุดคิดเป็น ${Math.round(best / profit * 100)}% ของกำไร หยุดเทรดแล้ว`);
      }
    }
    if (this.st.status === 'active') {
      if (c.dll > 0 && dayPnl <= -c.dll + 1e-9 && this.st.blockedDay !== today) {
        this.st.blockedDay = today; flatten = flatten || 'daily loss limit';
        events.push(`⛔ ขาดทุนรายวันถึงเพดาน (${r2(dayPnl)} ≤ -${c.dll}) ปิดทุกไม้ และหยุดเปิดไม้ใหม่จนถึงวันเทรดถัดไป`);
      }
      if (!this.windowOpen(serverT) && open > 0) flatten = flatten || 'end of trading day';
    }
    const view = {
      enabled: true, status: this.st.status, reason: this.st.reason, start: c.start, mll: c.mll, balance: r2(balance), equity: r2(equity), profit: r2(profit), target: c.target,
      pct: r2(Math.max(0, profit) / c.target * 100), floor: r2(floor), buffer: r2(level - floor), peakEOD: r2(peak), dayPnl: r2(dayPnl), dll: c.dll,
      dllLeft: c.dll > 0 ? r2(c.dll + dayPnl) : null, bestDay: r2(best), bestPct: profit > 0 ? Math.round(best / profit * 100) : 0, consistency: c.consistency,
      consistencyOK, needProfit: r2(needProfit), days: tradingDays, minDays: c.minDays, windowOpen: this.windowOpen(serverT),
      blockedToday: this.st.blockedDay === today, capContracts: c.capContracts, riskPct: c.riskPct, commissionRT: c.commissionRT, dayKey: today,
    };
    return { view, flatten, events };
  }

  // May a NEW order be opened right now? `contracts` = open + pending contracts (all instruments), `add` = contracts of the new order.
  canOpen(view, serverT, contracts, add) {
    const c = this.c;
    if (this.st.status === 'failed') return { ok: false, why: 'EXAM_FAILED: the evaluation account hit the maximum loss limit' };
    if (this.st.status === 'passed') return { ok: false, why: 'EXAM_PASSED: target reached, trading is closed' };
    if (view && view.blockedToday) return { ok: false, why: 'EXAM_DAILY_LOSS: daily loss limit reached, no new trades until the next trading day' };
    if (!this.windowOpen(serverT)) return { ok: false, why: 'EXAM_CLOSED: outside the trading day (flat before 16:10 New York, back at 18:00)' };
    if (c.capContracts > 0 && contracts + add > c.capContracts) return { ok: false, why: `EXAM_CAP: ${contracts + add} contracts would exceed the limit of ${c.capContracts} micros` };
    return { ok: true, why: '' };
  }
}
module.exports = { Exam, DEFAULTS, dayOf, nyMinute };
