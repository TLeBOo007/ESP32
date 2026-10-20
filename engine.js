'use strict';
// Paper-trading engine: one account, one symbol, limit/market orders with SL/TP,
// filled against closed M5 bars sent by the ESP32. Pure logic, no I/O.
// Prices are bid-based bars; `spread` (ask - bid) is applied to buys and to sell-side triggers.

const BUY = 1, SELL = 2;

class Engine {
  constructor(opts = {}) {
    this.acct = opts.acct || {};           // {balance, nextId}: shared by all instruments so there is one account and unique ids
    this.sym = opts.sym || '';
    this.startBalance = opts.startBalance ?? 10000;
    this.commissionRT = opts.commissionRT ?? 0;   // fee per 1.00 lot (contract) per round turn, charged when a position is closed (0 = none)
    this.mult = opts.multiplier ?? 1;      // account-currency value of 1 price unit per 1.00 unit of volume (US100 CFD = 1, MNQ = 2)
    this.reset();
  }

  get balance() { return this.acct.balance; } set balance(v) { this.acct.balance = v; }
  get nextId() { return this.acct.nextId; } set nextId(v) { this.acct.nextId = v; }

  reset() {
    this.balance = this.startBalance;
    this.nextId = 1001;
    this.orders = [];      // pending limit orders
    this.positions = [];   // open positions
    this.trades = [];      // closed trades
    this.lastBarT = 0;     // server-time start of the last bar processed
    this.lastBar = null;
    this.spread = 0;
    this.quote = { bid: 0, ask: 0, t: 0 };
    this.events = [];      // events produced by the last call (for notifications)
    this.equity = [];      // [t, balance] after every closed trade
  }

  _emit(e) { this.events.push(e); }
  takeEvents() { const e = this.events; this.events = []; return e; }

  // ---- orders ---------------------------------------------------------------------------
  placeOrder(o) {
    const side = o.side === SELL ? SELL : BUY;
    const volume = Math.round(Number(o.volume));
    const sl = Number(o.sl) || 0, tp = Number(o.tp) || 0;
    if (!(volume > 0)) return { error: 'BAD_VOLUME' };
    const kind = o.kind === 'market' ? 'market' : 'limit';
    if (o.quote) this.quote = { bid: Number(o.quote.bid) || this.quote.bid, ask: Number(o.quote.ask) || this.quote.ask, t: o.t || 0 };
    let entry = Number(o.price) || 0;
    if (kind === 'market') {
      entry = side === BUY ? Number(o.ask || this.quote.ask) : Number(o.bid || this.quote.bid);
      if (!(entry > 0)) return { error: 'NO_QUOTE' };
    }
    if (!(entry > 0)) return { error: 'BAD_PRICE' };
    if (sl > 0 && (side === BUY ? sl >= entry : sl <= entry)) return { error: 'SL_WRONG_SIDE' };
    if (tp > 0 && (side === BUY ? tp <= entry : tp >= entry)) return { error: 'TP_WRONG_SIDE' };
    const id = this.nextId++;
    const base = { id, sym: this.sym, side, volume, sl, tp, sl0: sl, tp0: tp, comment: String(o.comment || ''), why: o.why, createdT: Number(o.t) || 0, afterT: Number(o.afterT) || 0 };   // afterT: bars up to this server time are ignored (signal came from that bar)
    if (kind === 'market') {
      const p = { ...base, open: entry, openT: Number(o.t) || 0, best: entry, worst: entry, bars: 0 };
      this.positions.push(p);
      this._emit({ type: 'open', pos: { ...p }, via: 'market' });
    } else {
      const ord = { ...base, price: entry };
      this.orders.push(ord);
      this._emit({ type: 'order', order: { ...ord } });
    }
    return { id };
  }

  cancel(id) {
    const i = this.orders.findIndex(o => o.id === id);
    if (i < 0) return { error: 'NOT_FOUND' };
    const [o] = this.orders.splice(i, 1);
    this._emit({ type: 'cancel', order: o });
    return { ok: true };
  }

  amend(id, sl, tp) {
    const p = this.positions.find(x => x.id === id);
    if (!p) return { error: 'NOT_FOUND' };
    if (sl > 0) p.sl = sl;
    if (tp > 0) p.tp = tp;
    return { ok: true };
  }

  close(id, price, t, volume, reason = 'manual') {
    const i = this.positions.findIndex(x => x.id === id);
    if (i < 0) return { error: 'NOT_FOUND' };
    const p = this.positions[i];
    let px = Number(price);
    if (!(px > 0)) px = p.side === BUY ? this.quote.bid : this.quote.ask;
    if (!(px > 0)) return { error: 'NO_QUOTE' };
    const vol = volume > 0 && volume < p.volume ? Math.round(volume) : p.volume;
    this._closeAmount(p, vol, px, t, reason);
    if (vol >= p.volume) this.positions.splice(i, 1); else p.volume -= vol;
    return { ok: true };
  }

  _closeAmount(p, vol, px, t, reason) {
    const dir = p.side === BUY ? 1 : -1;
    const fee = this.commissionRT * vol / 100, pnl = dir * (px - p.open) * vol / 100 * this.mult - fee;   // volume in 0.01 units; pnl is net of the commission
    this.balance += pnl;
    const risk = Math.abs(p.open - p.sl0);
    const mfeR = risk > 0 && p.best != null ? round(dir * (p.best - p.open) / risk, 2) : 0;
    const maeR = risk > 0 && p.worst != null ? round(Math.min(0, dir * (p.worst - p.open) / risk), 2) : 0;
    const tr = {
      mfeR: Math.max(0, mfeR), maeR, bars: p.bars || 0, why: p.why || null,
      id: p.id, sym: this.sym, side: p.side, volume: vol, open: p.open, close: px, sl0: p.sl0, tp0: p.tp0,
      openT: p.openT, closeT: Number(t) || 0, reason, pnl: round(pnl, 2), fee: round(fee, 2),
      R: risk > 0 ? round(dir * (px - p.open) / risk, 3) : 0, comment: p.comment,
    };
    tr.exitWhy = this._exitWhy(p, tr, reason, px, risk, dir);
    this.trades.push(tr);
    this.equity.push([tr.closeT, round(this.balance, 2)]);
    this._emit({ type: 'close', trade: tr, balance: round(this.balance, 2) });
  }

  // Plain-language reason for the exit, from what the price did after entry.
  _exitWhy(p, tr, reason, px, risk, dir) {
    const f = x => Number(x).toFixed(2), w = p.why, held = tr.bars + ' แท่ง M5 (~' + tr.bars * 5 + ' นาที)', out = [];
    const ctx = 'ถือ ' + held + ' · ไปทางที่ถูกสูงสุด +' + tr.mfeR + 'R · สวนสูงสุด ' + tr.maeR + 'R';
    if (reason === 'SL') {
      out.push('โดน SL @ ' + f(px) + ' (' + (tr.R <= -0.95 ? 'เสียเต็ม 1R' : tr.R + 'R') + ')');
      if (tr.mfeR >= 1) out.push('ราคาเคยไปทางที่ถูกถึง +' + tr.mfeR + 'R แล้วกลับมาโดน SL (พิจารณาเลื่อน SL/ทยอยปิด)');
      else if (tr.mfeR >= 0.3) out.push('ไปทางที่ถูกได้เล็กน้อย (+' + tr.mfeR + 'R) แล้วกลับตัว');
      else out.push(tr.bars <= 2 ? 'โดนเร็วมาก — ราคาไม่ตอบรับโซนเข้าเลย' : 'ราคาแทบไม่ไปทางที่ถูกเลย');
      if (w && w.poi) {
        const broke = dir === 1 ? p.worst < w.poi.bot : p.worst > w.poi.top;
        out.push(broke ? 'ราคาหลุดทะลุโซน POI (' + w.poi.type + ' ' + w.poi.tf + ') — สมมติฐานการกลับตัวจากโซนนี้ล้มเหลว' : 'ราคายังอยู่ในโซน POI แต่ SL แคบกว่า — โดนกวาดก่อนวิ่งต่อ');
      }
      if (w && w.sweep) out.push('ตั้งสมมติฐานจากการกวาด ' + w.sweep.name + ' แล้ว ' + w.disp.mode + ' ยืนยัน แต่ไม่มี follow-through');
    } else if (reason === 'TP') {
      out.push('ถึงเป้า TP @ ' + f(px) + (w && w.tp ? ' (' + w.tp.name + ')' : '') + ' +' + tr.R + 'R');
    } else out.push('ปิดด้วยเหตุผล: ' + reason + ' @ ' + f(px) + ' (' + tr.R + 'R)');
    out.push(ctx);
    return out.join('\n');
  }

  // ---- bars -----------------------------------------------------------------------------
  // bar: {t (server time, start), o, h, l, c}. Orders placed after a bar closed only see later bars.
  processBar(b, spread) {
    if (!(b.t > this.lastBarT)) return false;
    if (spread !== undefined && spread >= 0) this.spread = spread;
    const sp = this.spread;
    for (const o of this.orders.slice()) {
      if (b.t <= o.afterT) continue;
      const touched = o.side === BUY ? b.l + sp <= o.price : b.h >= o.price;
      if (!touched) continue;
      this.orders.splice(this.orders.indexOf(o), 1);
      const p = { id: o.id, sym: this.sym, side: o.side, volume: o.volume, sl: o.sl, tp: o.tp, sl0: o.sl0, tp0: o.tp0, comment: o.comment, why: o.why, open: o.price, openT: b.t, afterT: 0, best: o.price, worst: o.price, bars: 0 };
      this.positions.push(p);
      this._emit({ type: 'open', pos: { ...p }, via: 'limit' });
    }
    for (const p of this.positions.slice()) {
      if (b.t <= (p.afterT || 0)) continue;
      let px = null, why = '';
      if (p.side === BUY) {
        if (p.sl > 0 && b.l <= p.sl) { px = Math.min(b.o, p.sl); why = 'SL'; }
        else if (p.tp > 0 && b.h >= p.tp) { px = p.tp; why = 'TP'; }
      } else {
        if (p.sl > 0 && b.h + sp >= p.sl) { px = Math.max(b.o + sp, p.sl); why = 'SL'; }
        else if (p.tp > 0 && b.l + sp <= p.tp) { px = p.tp; why = 'TP'; }
      }
      p.bars = (p.bars || 0) + (b.t > p.openT ? 1 : 0);
      if (b.t > p.openT) {                                // excursion tracking (the fill bar itself is ambiguous, so it is skipped)
        if (px === null) p.best = p.side === BUY ? Math.max(p.best, b.h) : Math.min(p.best, b.l + sp);   // stop-first: the closing bar's favourable side is not credited
        p.worst = p.side === BUY ? Math.min(p.worst, b.l) : Math.max(p.worst, b.h + sp);
      }
      if (px !== null) {
        this._closeAmount(p, p.volume, px, b.t, why);
        this.positions.splice(this.positions.indexOf(p), 1);
      }
    }
    this.lastBarT = b.t; this.lastBar = { ...b };
    return true;
  }

  setQuote(bid, ask, t) { if (bid > 0 && ask > 0) this.quote = { bid, ask, t: t || 0 }; }

  // ---- views ----------------------------------------------------------------------------
  floating() {
    const bid = this.quote.bid || (this.lastBar && this.lastBar.c) || 0;
    const ask = this.quote.ask || bid + this.spread;
    let f = 0;
    for (const p of this.positions) f += (p.side === BUY ? bid - p.open : p.open - ask) * p.volume / 100 * this.mult;
    return f;
  }

  state() {
    return {
      balance: round(this.balance, 2), startBalance: this.startBalance, equity: round(this.balance + this.floating(), 2),
      lastBarT: this.lastBarT, spread: this.spread, quote: this.quote,
      positions: this.positions, orders: this.orders, tradeCount: this.trades.length,
    };
  }

  stats() {
    const t = this.trades; const wins = t.filter(x => x.pnl > 0), loss = t.filter(x => x.pnl < 0);
    const gp = wins.reduce((s, x) => s + x.pnl, 0), gl = -loss.reduce((s, x) => s + x.pnl, 0);
    let peak = this.startBalance, dd = 0, bal = this.startBalance;
    for (const x of t) { bal += x.pnl; peak = Math.max(peak, bal); dd = Math.max(dd, peak - bal); }
    const sumR = t.reduce((s, x) => s + x.R, 0), bm = {};
    for (const x of t) {                                           // per setup: the model code is the word after "BPE " in the order comment (M1..M4, UC, TS)
      const m = /BPE\s+(\S+)/.exec(x.comment || ''), k = m ? m[1] : 'other', b = bm[k] = bm[k] || { model: k, trades: 0, wins: 0, netPnl: 0, sumR: 0 };
      b.trades++; if (x.pnl > 0) b.wins++; b.netPnl += x.pnl; b.sumR += x.R;
    }
    const bg = {};
    for (const x of t) {                                           // per grade: "G<A|B|C>" token in the comment (classic mode only)
      const m = /\sG([ABC])\b/.exec(x.comment || ''); if (!m) continue;
      const b = bg[m[1]] = bg[m[1]] || { grade: m[1], trades: 0, wins: 0, netPnl: 0, sumR: 0 };
      b.trades++; if (x.pnl > 0) b.wins++; b.netPnl += x.pnl; b.sumR += x.R;
    }
    const byGrade = Object.values(bg).map(b => ({ grade: b.grade, trades: b.trades, winRate: round(b.wins / b.trades * 100, 1), netPnl: round(b.netPnl, 2), sumR: round(b.sumR, 2) })).sort((p, q) => p.grade < q.grade ? -1 : 1);
    const byModel = Object.values(bm).map(b => ({ model: b.model, trades: b.trades, winRate: round(b.wins / b.trades * 100, 1), netPnl: round(b.netPnl, 2), sumR: round(b.sumR, 2) })).sort((p, q) => p.model < q.model ? -1 : 1);
    return { byModel, byGrade,
      trades: t.length, wins: wins.length, losses: loss.length, winRate: t.length ? round(wins.length / t.length * 100, 1) : 0,
      netPnl: round(this.balance - this.startBalance, 2), sumR: round(sumR, 2), profitFactor: gl > 0 ? round(gp / gl, 2) : (gp > 0 ? null : 0),
      maxDrawdown: round(dd, 2),
    };
  }

  serialize() {
    return JSON.stringify({ v: 1, startBalance: this.startBalance, balance: this.balance, nextId: this.nextId, orders: this.orders, positions: this.positions,
      trades: this.trades, lastBarT: this.lastBarT, lastBar: this.lastBar, spread: this.spread, quote: this.quote, equity: this.equity });
  }
  load(text) {
    const d = JSON.parse(text);
    Object.assign(this, { startBalance: d.startBalance, balance: d.balance, nextId: d.nextId, orders: d.orders || [], positions: d.positions || [],
      trades: d.trades || [], lastBarT: d.lastBarT || 0, lastBar: d.lastBar || null, spread: d.spread || 0, quote: d.quote || { bid: 0, ask: 0, t: 0 }, equity: d.equity || [] });
  }
}

function round(x, n) { const k = Math.pow(10, n); return Math.round(x * k) / k; }

module.exports = { Engine, BUY, SELL, round };
