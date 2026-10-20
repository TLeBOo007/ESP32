'use strict';
// Supply/demand forward test on live ticks (PAPER ONLY - no orders anywhere).
// Zones: M5 impulse bar (body >= imp*ATR14) leaving a base of 1-3 small bars. First touch inside NY AM creates an event; when the touch bar
// closes, the footprint of that bar decides which variants enter (at the first tick after the bar close). Four variants run side by side on the
// same events: zone / zone+delta / zone+stack / zone+both. Fills use real ticks: SL = market at the trade price, TP needs a trade through target+fillTicks.
const fs = require('fs');
const path = require('path');
const { toServer } = require('./timeutil');
const BAR_MS = 5 * 60 * 1000;
const VARIANTS = ['zone', 'delta', 'stack', 'both'];

class SdForward {
  constructor(o = {}) {
    this.c = Object.assign({ imp: 1.0, small: 0.8, RR: 3, buf: 0.1, maxRisk: 40, costPts: 1.0, fillTicks: 1, tick: 0.25, maxAgeBars: 576, win: [16 * 60 + 30, 19 * 60], flat: 23 * 60 }, o.cfg || {});
    this.dir = o.dir; this.log = o.log || (() => {});
    this.bars = []; this.atr = []; this.zones = []; this.events = []; this.pos = {}; this.trades = []; this.skipped = 0; this.eventsN = 0;
    this.pendingEntry = [];
    if (this.dir) { try { fs.mkdirSync(this.dir, { recursive: true }); this.file = path.join(this.dir, 'sdfw_trades.jsonl'); this._load(); } catch (e) { this.log('sdfw: ' + e.message); } }
  }
  _load() { try { this.trades = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { /* first run */ } }
  _serverMin(ms) { return Math.floor(toServer(ms / 1000) / 60) % 1440; }
  // ---- bar hook (called with every closed 5-minute footprint bar) ----
  onBar(b) {
    const bars = this.bars, n = bars.length; bars.push(b);
    const pc = n ? bars[n - 1].c : b.o; const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)); b.tr = tr;
    this.atr.push(n >= 13 ? bars.slice(-14).reduce((s, x) => s + x.tr, 0) / 14 : 0);
    if (bars.length > 2000) { bars.shift(); this.atr.shift(); }
    const i = bars.length - 1, A = this.atr;
    // 1) events waiting for this bar's close
    for (const e of this.events) if (e.state === 'await' && e.barT === b.t) {
      const demand = e.d === 1, gap = demand ? b.l < e.lo : b.h > e.hi, beyond = demand ? b.c < e.lo : b.c > e.hi;
      if (gap || beyond) { e.state = 'skip'; this.skipped++; continue; }
      const dAl = Math.sign(b.delta) === e.d, sAl = e.d === 1 ? b.stackBuy >= 2 : b.stackSell >= 2;
      e.feat = { delta: b.delta, vol: b.vol, stackBuy: b.stackBuy, stackSell: b.stackSell, dAl, sAl };
      e.state = 'enter'; this.pendingEntry.push(e);
    }
    this.events = this.events.filter(e => e.state === 'await' || e.state === 'enter');
    // 2) new zone from this bar
    const a = A[i - 1]; if (!(a > 0) || i < 4) return;
    const body = b.c - b.o; if (Math.abs(body) < this.c.imp * a) return;
    let k = 0, j = i - 1; while (j >= 1 && k < 3 && A[j - 1] > 0 && (bars[j].h - bars[j].l) < this.c.small * A[j - 1]) { k++; j--; }
    if (!k) return;
    let hi = -Infinity, lo = Infinity; for (let q = i - k; q < i; q++) { hi = Math.max(hi, bars[q].h); lo = Math.min(lo, bars[q].l); }
    if (body > 0 && b.c > hi) this.zones.push({ d: 1, hi, lo, from: b.t + BAR_MS, born: b.t });
    else if (body < 0 && b.c < lo) this.zones.push({ d: -1, hi, lo, from: b.t + BAR_MS, born: b.t });
  }
  // ---- tick hook ----
  onTick(ts, px, vol, type) {
    const c = this.c;
    // enter pending events at the first tick after the touch bar closed
    if (this.pendingEntry.length) { const list = this.pendingEntry; this.pendingEntry = []; for (const e of list) this._enter(e, ts, px); }
    // manage open positions
    const sm = this._serverMin(ts);
    for (const v of VARIANTS) {
      const p = this.pos[v]; if (!p) continue;
      if (p.d === 1) { if (px <= p.sl) this._close(v, px, ts, 'SL'); else if (px >= p.tp + c.fillTicks * c.tick) this._close(v, p.tp, ts, 'TP'); }
      else { if (px >= p.sl) this._close(v, px, ts, 'SL'); else if (px <= p.tp - c.fillTicks * c.tick) this._close(v, p.tp, ts, 'TP'); }
      if (this.pos[v] && sm >= c.flat && sm < c.flat + 120) this._close(v, px, ts, 'EOD');
    }
    // zone touches (first touch kills the zone whether or not it is in the window)
    const inWin = sm >= c.win[0] && sm < c.win[1], barT = Math.floor(ts / BAR_MS) * BAR_MS;
    if (!this.zones.length) return;
    const keep = [];
    for (const z of this.zones) {
      if (ts < z.from) { keep.push(z); continue; }
      if ((barT - z.born) / BAR_MS > c.maxAgeBars) continue;
      const touched = z.d === 1 ? px <= z.hi : px >= z.lo;
      if (!touched) { keep.push(z); continue; }
      if (inWin) { this.eventsN++; this.events.push({ id: this.eventsN, t: ts, barT, d: z.d, hi: z.hi, lo: z.lo, state: 'await' }); }
    }
    this.zones = keep;
  }
  _enter(e, ts, px) {
    const c = this.c, d = e.d, h = e.hi - e.lo, sl = d === 1 ? e.lo - c.buf * h : e.hi + c.buf * h, risk = (px - sl) * d;
    if (!(risk > 0) || risk > c.maxRisk) { this.skipped++; return; }
    const f = e.feat, take = { zone: true, delta: f.dAl, stack: f.sAl, both: f.dAl && f.sAl };
    for (const v of VARIANTS) if (take[v] && !this.pos[v]) this.pos[v] = { id: e.id, d, ent: px, sl, tp: px + d * c.RR * risk, risk, t0: ts, zone: [e.lo, e.hi], feat: f };
  }
  _close(v, px, ts, why) {
    const p = this.pos[v]; delete this.pos[v]; const R = p.d * (px - p.ent) / p.risk, Rc = R - this.c.costPts / p.risk;
    const t = { v, id: p.id, d: p.d, ent: p.ent, exit: px, why, R: +R.toFixed(3), Rc: +Rc.toFixed(3), risk: +p.risk.toFixed(2), t0: p.t0, t1: ts, delta: p.feat.delta, stackBuy: p.feat.stackBuy, stackSell: p.feat.stackSell };
    this.trades.push(t); if (this.file) try { fs.appendFileSync(this.file, JSON.stringify(t) + '\n'); } catch (e) { this.log('sdfw write: ' + e.message); }
  }
  stats() {
    const out = {};
    for (const v of VARIANTS) {
      const x = this.trades.filter(t => t.v === v), n = x.length, sum = a => a.reduce((s, t) => s + t, 0);
      out[v] = { n, win: n ? Math.round(1000 * x.filter(t => t.R > 0).length / n) / 10 : null, avgR: n ? +(sum(x.map(t => t.R)) / n).toFixed(3) : null, avgRnet: n ? +(sum(x.map(t => t.Rc)) / n).toFixed(3) : null, sumRnet: +sum(x.map(t => t.Rc)).toFixed(2), open: !!this.pos[v] };
    }
    return { cfg: this.c, variants: out, zonesActive: this.zones.length, eventsSeen: this.eventsN, skipped: this.skipped, bars: this.bars.length, open: this.pos, last: this.trades.slice(-20) };
  }
}
module.exports = { SdForward, VARIANTS };
