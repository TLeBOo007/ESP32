'use strict';
// Paper-trading engine: one account, one symbol, limit/market orders with SL/TP,
// filled against closed M5 bars sent by the ESP32. Pure logic, no I/O.
// Prices are bid-based bars; `spread` (ask - bid) is applied to buys and to sell-side triggers.

const BUY = 1, SELL = 2;

class Engine {
  constructor(opts = {}) {
    this.startBalance = opts.startBalance ?? 10000;
    this.mult = opts.multiplier ?? 1;      // account-currency value of 1 price unit per 1.00 unit of volume (US100 CFD = 1, MNQ = 2)
    this.reset();
  }

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
    const base = { id, side, volume, sl, tp, sl0: sl, tp0: tp, comment: String(o.comment || ''), createdT: Number(o.t) || 0, afterT: Number(o.afterT) || 0 };   // afterT: bars up to this server time are ignored (signal came from that bar)
    if (kind === 'market') {
      const p = { ...base, open: entry, openT: Number(o.t) || 0 };
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
    const pnl = dir * (px - p.open) * vol / 100 * this.mult;   // volume in 0.01 units
    this.balance += pnl;
    const risk = Math.abs(p.open - p.sl0);
    const tr = {
      id: p.id, side: p.side, volume: vol, open: p.open, close: px, sl0: p.sl0, tp0: p.tp0,
      openT: p.openT, closeT: Number(t) || 0, reason, pnl: round(pnl, 2),
      R: risk > 0 ? round(dir * (px - p.open) / risk, 3) : 0, comment: p.comment,
    };
    this.trades.push(tr);
    this.equity.push([tr.closeT, round(this.balance, 2)]);
    this._emit({ type: 'close', trade: tr, balance: round(this.balance, 2) });
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
      const p = { id: o.id, side: o.side, volume: o.volume, sl: o.sl, tp: o.tp, sl0: o.sl0, tp0: o.tp0, comment: o.comment, open: o.price, openT: b.t, afterT: 0 };
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
    const sumR = t.reduce((s, x) => s + x.R, 0);
    return {
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
