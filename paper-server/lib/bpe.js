'use strict';
// BPE (Bias - POI - Execute) signal engine - a line-by-line port of ChartDesk_BPE.mq4 v1.30 (ICT only).
// It reads closed M5 bars (server time = New York + 7h, epoch seconds), builds M15 / H4 / D1 bars itself and, once per
// new M5 bar, decides whether a setup is complete. It emits signals (buy_limit / sell_limit / buy / sell / cancel);
// position sizing and the final go / no-go belong to the trader (the ESP32).
// Educational tool, not investment advice.

const MIN = 60;
const DEFAULTS = {
  symbol: 'US100', digits: 2,
  biasMode: 1,            // 0 H4 only, 1 H4 + D1 must not be opposite, 2 both agree
  biasSwing: 2, biasLook: 120,
  poiTF: 15, poiLook: 150, maxPOI: 3, useOB: true, usePD: true, fvgMinK: 0.10,
  model: 0,               // 0 either, 1 turtle soup only, 2 unicorn only
  dispMode: 1,            // 0 MSS, 1 CISD
  entryAt: 0,             // 0 FVG edge, 1 FVG CE
  slMode: 1,              // 0 conservative, 1 aggressive
  ltfSwing: 2, liqLook: 120, nearK: 1.5, poiBreakK: 0.5, sweepWin: 36, dispWin: 24, setupMaxBars: 60,
  slBufK: 0.10, minSLK: 0.5, dispBodyK: 1.0, minRR: 2.0, tpLevelMax: 3, expiryBars: 12,
  serverMinusNY: 7, market: 'auto', kzAsia: false, kzLondon: true, kzNYAM: true, kzNYPM: false,
  waitEquityOpen: true, preKZMinutes: 180, cancelOutsideKZ: true, closeAtKZEnd: false, maxHoldBars: 0,
  riskPercent: 2.0, maxRiskPctMinLot: 5.0, fixedLots: 0, dailyLossPct: 10.0, maxTradesPerDay: 3,
  minLot: 0.01, maxLot: 100, lotStep: 0.01, tickValue: 0.01, tickSize: 0.01, point: 0.01,
};

const normalize = (x, d) => { const p = Math.pow(10, d); const y = Math.floor(Math.abs(x) * p + 0.5) / p; return x < 0 ? -y : y; };
const maxBars = tf => (tf <= 5 ? 900 : tf <= 60 ? 500 : 220);

class BarStore {
  constructor(poiTF) { this.poiTF = poiTF; this.tf = {}; for (const k of [5, poiTF, 240, 1440]) this.tf[k] = { t: [], o: [], h: [], l: [], c: [] }; this.pushed = []; this.lastT = 0; }
  _upsert(tf, t, o, h, l, c) {
    const d = this.tf[tf], b = Math.floor(t / (tf * MIN)) * (tf * MIN), n = d.t.length;
    if (n && d.t[n - 1] === b) { d.h[n - 1] = Math.max(d.h[n - 1], h); d.l[n - 1] = Math.min(d.l[n - 1], l); d.c[n - 1] = c; return; }
    if (n && b < d.t[n - 1]) return;
    d.t.push(b); d.o.push(o); d.h.push(h); d.l.push(l); d.c.push(c);
    const extra = d.t.length - maxBars(tf);
    if (extra > 0) for (const k of ['t', 'o', 'h', 'l', 'c']) d[k].splice(0, extra);
  }
  addClosed(t, o, h, l, c) {      // a closed M5 bar starting at t
    if (t < this.lastT) return false;
    this.lastT = t + 300;
    for (const k of [5, this.poiTF, 240, 1440]) this._upsert(k, t, o, h, l, c);
    return true;
  }
  pushForming(now, px) {
    this.pushed = [];
    for (const k of [5, this.poiTF, 240, 1440]) {
      const b = Math.floor(now / (k * MIN)) * (k * MIN), d = this.tf[k];
      if (!d.t.length || d.t[d.t.length - 1] < b) { d.t.push(b); d.o.push(px); d.h.push(px); d.l.push(px); d.c.push(px); this.pushed.push(k); }
    }
  }
  popForming() { for (const k of this.pushed) { const d = this.tf[k]; for (const f of ['t', 'o', 'h', 'l', 'c']) d[f].pop(); } this.pushed = []; }
  serialize() { return { poiTF: this.poiTF, lastT: this.lastT, tf: this.tf }; }
  static load(o) { const s = new BarStore(o.poiTF); s.lastT = o.lastT; s.tf = o.tf; return s; }
}

class Bpe {
  // host (all optional): { ours() -> [{type:'buylimit'|'selllimit'|'buy'|'sell', openT, tp, sl, price, pending:boolean}], balance(), today() -> {opened, pl} }
  constructor(cfg, host) {
    this.c = Object.assign({}, DEFAULTS, cfg || {});
    this.host = host || {};
    this.st = new BarStore(this.c.poiTF);
    this.gNow = 0; this.indexError = false;
    this.lastBar = 0; this.lastPoiBar = 0;
    this.biasH4 = 0; this.biasD1 = 0; this.bias = 0; this.rangeHi = 0; this.rangeLo = 0; this.eqLvl = 0;
    this.poi = []; this.used = [];
    this.s = { state: 0, dir: 0, poiType: 0, top: 0, bot: 0, ext: 0, liq: 0, disp: 0, key: 0, touchT: 0, extT: 0, dispT: 0, liqName: '' };
    this.stateTxt = '-'; this.riskTxt = '-'; this.kzTxt = '-'; this.lastTxt = '-';
    this.out = []; this.log = [];
    this._resolveMarket();
  }
  // -------------------------------------------------------------- bar access (MQL semantics: shift 0 = forming bar)
  _tf(tf) { return tf === 0 ? 5 : tf; }
  _cur(tf) { const d = this.st.tf[this._tf(tf)], g = this.gNow; let lo = 0, hi = d.t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (d.t[m] <= g) lo = m + 1; else hi = m; } return lo - 1; }
  _idx(tf, sh) { const i = this._cur(tf) - sh; if (i < 0 || i >= this.st.tf[this._tf(tf)].t.length) { this.indexError = true; return -1; } return i; }
  _v(f, tf, sh) { const i = this._idx(tf, sh); return i < 0 ? 0 : this.st.tf[this._tf(tf)][f][i]; }
  iBars(tf) { return this._cur(tf) + 1; }
  iO(tf, sh) { return this._v('o', tf, sh); } iH(tf, sh) { return this._v('h', tf, sh); }
  iL(tf, sh) { return this._v('l', tf, sh); } iC(tf, sh) { return this._v('c', tf, sh); }
  iTime(tf, sh) { const i = this._cur(tf) - sh, d = this.st.tf[this._tf(tf)]; return (i >= 0 && i < d.t.length) ? d.t[i] : 0; }
  iBarShift(tf, t) { const c = this._cur(tf), d = this.st.tf[this._tf(tf)]; let i = c; while (i > 0 && d.t[i] > t) i--; return c - i; }
  iATR(tf, n, sh) {
    const d = this.st.tf[this._tf(tf)], c = this._cur(tf) - sh; if (c < 1) return 1e-9;
    let a = 0, cnt = 0;
    for (let i = c; i > c - n && i >= 1; i--) { a += Math.max(d.h[i] - d.l[i], Math.max(Math.abs(d.h[i] - d.c[i - 1]), Math.abs(d.l[i] - d.c[i - 1]))); cnt++; }
    return cnt ? a / cnt : 1e-9;
  }
  T0() { return this.iTime(0, 0); }
  // -------------------------------------------------------------- time
  nyMin(t) { let x = (t - this.c.serverMinusNY * 3600) % 86400; if (x < 0) x += 86400; return Math.floor(x / 60); }
  nyDayKey(t) { return Math.floor((t - this.c.serverMinusNY * 3600 + 6 * 3600) / 86400); }
  nyStr(t) { const m = this.nyMin(t); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  _resolveMarket() {
    const c = this.c; let kzA = false, kzL = false, kzAM = false, kzPM = false; const s = String(c.symbol).toUpperCase(), has = k => s.includes(k);
    if (c.market === 'custom') { kzA = c.kzAsia; kzL = c.kzLondon; kzAM = c.kzNYAM; kzPM = c.kzNYPM; }
    else {
      let mk = c.market;
      if (mk === 'auto') {
        if (['NAS', 'NQ', 'US100', 'USTEC', 'NDX', 'SPX', 'SP500', 'US500', 'ES', 'US30', 'DJI', 'DOW', 'YM'].some(has)) mk = 'us_index';
        else if (['XAU', 'GOLD', 'GC', 'XAG'].some(has)) mk = 'gold';
        else { kzL = has('EUR') || has('GBP') || has('CHF'); kzAM = has('USD') || has('CAD'); kzA = has('JPY') || has('AUD') || has('NZD'); if (!(kzA || kzL || kzAM)) { kzL = true; kzAM = true; } mk = 'done'; }
      }
      if (mk === 'us_index') { kzAM = true; kzPM = true; }
      if (mk === 'gold' || mk === 'fx_europe') { kzL = true; kzAM = true; }
      if (mk === 'fx_asia') { kzA = true; kzL = true; }
    }
    this.kzA = kzA; this.kzL = kzL; this.kzAM = kzAM; this.kzPM = kzPM;
  }
  _kzWin(on, m, s, e, pre) {
    if (!on) return 0; if (m >= s && m < e) return 2;
    const ps = s - pre;
    if (ps < 0) { if (m >= ps + 1440 || m < s) return 1; } else if (m >= ps && m < s) return 1;
    return 0;
  }
  kzState(t) {
    const m = this.nyMin(t), pre = Math.max(0, this.c.preKZMinutes), amS = this.c.waitEquityOpen ? 570 : 510; let st = 0, name = '', x;
    x = this._kzWin(this.kzA, m, 1140, 1320, pre); if (x > st) { st = x; name = 'Asia KZ'; }
    x = this._kzWin(this.kzL, m, 120, 300, pre); if (x > st) { st = x; name = 'London KZ'; }
    x = this._kzWin(this.kzAM, m, amS, 660, pre); if (x > st) { st = x; name = 'NY AM KZ'; }
    x = this._kzWin(this.kzPM, m, 810, 960, pre); if (x > st) { st = x; name = 'NY PM KZ'; }
    return { st, name };
  }
  // -------------------------------------------------------------- swings and bias
  isSH(tf, j, L) { const h = this.iH(tf, j); for (let k = 1; k <= L; k++) { if (this.iH(tf, j + k) >= h || this.iH(tf, j - k) > h) return false; } return true; }
  isSL(tf, j, L) { const l = this.iL(tf, j); for (let k = 1; k <= L; k++) { if (this.iL(tf, j + k) <= l || this.iL(tf, j - k) < l) return false; } return true; }
  structBias(tf, L, look) {
    const n = Math.min(look, this.iBars(tf) - L - 2); let hi = 0, lo = 0;
    if (n < 3 * L + 5) return { b: 0, hi, lo };
    let aH = 0, aL = 0, b = 0;
    for (let k = n; k >= 1; k--) {
      const c = this.iC(tf, k);
      if (aH > 0 && c > aH) { b = 1; aH = 0; }
      if (aL > 0 && c < aL) { b = -1; aL = 0; }
      const j = k + L;
      if (j <= n) {
        if (this.isSH(tf, j, L)) { aH = this.iH(tf, j); hi = aH; }
        if (this.isSL(tf, j, L)) { aL = this.iL(tf, j); lo = aL; }
      }
    }
    return { b, hi, lo };
  }
  updateBias() {
    const c = this.c, h4 = this.structBias(240, c.biasSwing, c.biasLook), d1 = this.structBias(1440, c.biasSwing, c.biasLook);
    this.biasH4 = h4.b; this.biasD1 = d1.b; this.rangeHi = h4.hi; this.rangeLo = h4.lo;
    this.eqLvl = (h4.hi > 0 && h4.lo > 0 && h4.hi > h4.lo) ? (h4.hi + h4.lo) / 2 : 0;
    if (c.biasMode === 0) this.bias = this.biasH4;
    else if (c.biasMode === 1) this.bias = (this.biasH4 !== 0 && this.biasD1 !== -this.biasH4) ? this.biasH4 : 0;
    else this.bias = (this.biasH4 !== 0 && this.biasH4 === this.biasD1) ? this.biasH4 : 0;
  }
  // -------------------------------------------------------------- POI
  scanPOI() {
    this.poi = [];
    if (this.bias === 0) return;
    const c = this.c, tf = c.poiTF, d = this.bias, n = Math.min(c.poiLook, this.iBars(tf) - 3), atr = this.iATR(tf, 14, 1), px = this.iC(tf, 1), cand = [];
    for (let m = 2; m < n; m++) {
      for (let typ = 0; typ < 2; typ++) {
        let top = 0, bot = 0;
        if (typ === 0) {
          if (d === 1 && this.iL(tf, m - 1) > this.iH(tf, m + 1)) { top = this.iL(tf, m - 1); bot = this.iH(tf, m + 1); }
          if (d === -1 && this.iH(tf, m - 1) < this.iL(tf, m + 1)) { top = this.iL(tf, m + 1); bot = this.iH(tf, m - 1); }
          if (top - bot < c.fvgMinK * atr) continue;
        } else {
          if (!c.useOB) continue;
          const o = this.iO(tf, m), cl = this.iC(tf, m), c1 = this.iC(tf, m - 1), o1 = this.iO(tf, m - 1);
          if (d === 1 && cl < o && c1 > o1 && c1 > this.iH(tf, m)) { top = o; bot = cl; }
          if (d === -1 && cl > o && c1 < o1 && c1 < this.iL(tf, m)) { top = cl; bot = o; }
          if (top - bot <= 0) continue;
        }
        if (top <= bot) continue;
        const key = this.iTime(tf, m) + typ * 7 + (d === 1 ? 0 : 3);
        if (this.used.includes(key)) continue;
        let dead = false;
        for (let k = m - 2; k >= 1 && !dead; k--) { if (d === 1 && this.iL(tf, k) < bot) dead = true; if (d === -1 && this.iH(tf, k) > top) dead = true; }
        if (dead) continue;
        if ((d === 1 && px < bot) || (d === -1 && px > top)) continue;
        const ce = (top + bot) / 2;
        if (c.usePD && this.eqLvl > 0 && ((d === 1 && ce > this.eqLvl) || (d === -1 && ce < this.eqLvl))) continue;
        cand.push({ top, bot, key, type: typ });
      }
    }
    const taken = new Array(cand.length).fill(false);
    for (let r = 0; r < c.maxPOI; r++) {
      let best = -1, bd = 0;
      for (let q = 0; q < cand.length; q++) {
        if (taken[q]) continue;
        const dist = d === 1 ? px - cand[q].top : cand[q].bot - px;
        if (best < 0 || dist < bd) { best = q; bd = dist; }
      }
      if (best < 0) break;
      taken[best] = true; this.poi.push(cand[best]);
    }
  }
  // -------------------------------------------------------------- liquidity
  sessionLevels(upto) {
    const r = { aH: 0, aL: 0, lH: 0, lL: 0, xAH: 0, xAL: 0, xLH: 0, xLL: 0, dH: 0, dL: 0 };
    const key = this.nyDayKey(this.iTime(0, upto)), nb = Math.min(this.iBars(0) - 1, 800);
    for (let s = upto; s < nb; s++) {
      const t = this.iTime(0, s); if (this.nyDayKey(t) !== key) break;
      const h = this.iH(0, s), l = this.iL(0, s), m = this.nyMin(t);
      if (r.dH === 0 || h > r.dH) r.dH = h; if (r.dL === 0 || l < r.dL) r.dL = l;
      if (m >= 1200) { if (r.aH === 0 || h > r.aH) r.aH = h; if (r.aL === 0 || l < r.aL) r.aL = l; }
      else {
        if (r.xAH === 0 || h > r.xAH) r.xAH = h; if (r.xAL === 0 || l < r.xAL) r.xAL = l;
        if (m >= 120 && m < 300) { if (r.lH === 0 || h > r.lH) r.lH = h; if (r.lL === 0 || l < r.lL) r.lL = l; }
        if (m >= 300) { if (r.xLH === 0 || h > r.xLH) r.xLH = h; if (r.xLL === 0 || l < r.xLL) r.xLL = l; }
      }
    }
    return r;
  }
  liquidity(side, upto) {
    const c = this.c, lv = [], nm = [], L = c.ltfSwing, nb = Math.min(c.liqLook, this.iBars(0) - L - 2);
    for (let j = upto + L; j < nb; j++) {
      const sw = side === 1 ? this.isSH(0, j, L) : this.isSL(0, j, L); if (!sw) continue;
      const p = side === 1 ? this.iH(0, j) : this.iL(0, j); let taken = false;
      for (let k = j - 1; k >= upto && !taken; k--) if ((side === 1 && this.iH(0, k) > p) || (side === -1 && this.iL(0, k) < p)) taken = true;
      if (taken) continue; lv.push(p); nm.push('swing');
    }
    const tf = c.poiTF, nb2 = Math.min(100, this.iBars(tf) - L - 2);
    for (let j2 = L + 1; j2 < nb2; j2++) {
      const sw2 = side === 1 ? this.isSH(tf, j2, L) : this.isSL(tf, j2, L); if (!sw2) continue;
      const p2 = side === 1 ? this.iH(tf, j2) : this.iL(tf, j2); let taken2 = false;
      for (let k2 = j2 - 1; k2 >= 1 && !taken2; k2--) if ((side === 1 && this.iH(tf, k2) > p2) || (side === -1 && this.iL(tf, k2) < p2)) taken2 = true;
      if (taken2) continue; lv.push(p2); nm.push('M' + tf + ' swing');
    }
    const S = this.sessionLevels(upto), pdh = this.iH(1440, 1), pdl = this.iL(1440, 1);
    if (side === 1) {
      if (S.aH > 0 && (S.xAH === 0 || S.xAH <= S.aH)) { lv.push(S.aH); nm.push('Asia High'); }
      if (S.lH > 0 && (S.xLH === 0 || S.xLH <= S.lH)) { lv.push(S.lH); nm.push('London High'); }
      if (pdh > 0 && S.dH > 0 && S.dH <= pdh) { lv.push(pdh); nm.push('PDH'); }
    } else {
      if (S.aL > 0 && (S.xAL === 0 || S.xAL >= S.aL)) { lv.push(S.aL); nm.push('Asia Low'); }
      if (S.lL > 0 && (S.xLL === 0 || S.xLL >= S.lL)) { lv.push(S.lL); nm.push('London Low'); }
      if (pdl > 0 && S.dL > 0 && S.dL >= pdl) { lv.push(pdl); nm.push('PDL'); }
    }
    return { lv, nm, n: lv.length };
  }
  // -------------------------------------------------------------- execute
  _evt(evt, d, e, sl, tp, rr, det) {
    this.log.push({ t: this.T0(), ny: this.nyStr(this.T0()), evt, side: d === 1 ? 'BUY' : d === -1 ? 'SELL' : '-', entry: e, sl, tp, rr, det });
    if (this.log.length > 200) this.log.shift();
  }
  _reset(why) { if (this.s.state !== 0) this._evt('setup dropped', this.s.dir, 0, 0, 0, 0, why); this.s.state = 0; this.s.dir = 0; this.stateTxt = why; }
  _tfName(tf) { return tf === 60 ? 'H1' : tf === 240 ? 'H4' : tf === 1440 ? 'D1' : 'M' + tf; }
  dispLevel(d, es) {
    const c = this.c, L = c.ltfSwing;
    if (c.dispMode === 0) {
      for (let j = Math.max(es + 1, L + 1); j < es + c.liqLook && j < this.iBars(0) - L - 1; j++)
        if ((d === 1 && this.isSH(0, j, L)) || (d === -1 && this.isSL(0, j, L))) return d === 1 ? this.iH(0, j) : this.iL(0, j);
      return 0;
    }
    const against = k => (d === 1 ? this.iC(0, k) < this.iO(0, k) : this.iC(0, k) > this.iO(0, k));
    let k = es, guard = 0;
    while (guard < 6 && !against(k)) { k++; guard++; }
    if (guard >= 6) return 0;
    while (against(k + 1)) k++;
    return this.iO(0, k);
  }
  step(kz) {
    const c = this.c, S = this.s, inKZ = kz === 2;
    if (kz === 0) {
      if (S.state !== 0) this._reset('killzone ended');
      this.stateTxt = 'outside killzone - ' + this._biasName(this.bias) + ' bias, ' + this.poi.length + ' POI'; return;
    }
    if (S.state === 0) {
      if (this.bias === 0) { this.stateTxt = 'no bias'; return; }
      if (!this.poi.length) { this.stateTxt = 'no POI on the bias side'; return; }
      const l1 = this.iL(0, 1), h1 = this.iH(0, 1);
      for (const p of this.poi) {
        if (this.used.includes(p.key)) continue;
        const w = p.top - p.bot;
        const touch = this.bias === 1 ? (l1 <= p.top && h1 >= p.bot - w) : (h1 >= p.bot && l1 <= p.top + w);
        if (!touch) continue;
        S.state = 1; S.dir = this.bias; S.top = p.top; S.bot = p.bot; S.key = p.key; S.poiType = p.type;
        S.touchT = this.iTime(0, 1); S.ext = 0; S.liq = 0; S.disp = 0; S.liqName = '';
        if (!this.used.includes(S.key)) this.used.push(S.key);
        this._evt('POI touched', S.dir, 0, 0, 0, 0, (S.poiType === 0 ? 'FVG ' : 'OB ') + this._tfName(c.poiTF) + ' ' + S.bot.toFixed(c.digits) + '-' + S.top.toFixed(c.digits));
        break;
      }
      if (S.state === 0) { this.stateTxt = (this.bias === 1 ? 'BUY' : 'SELL') + ' bias - waiting for price at ' + this.poi.length + ' POI'; return; }
    }
    const d = S.dir, brk = c.poiBreakK * this.iATR(c.poiTF, 14, 1);
    if ((d === 1 && this.iC(c.poiTF, 1) < S.bot - brk) || (d === -1 && this.iC(c.poiTF, 1) > S.top + brk)) { this._reset('POI broken on ' + this._tfName(c.poiTF)); return; }
    if (d !== this.bias) { this._reset('bias changed'); return; }
    const age = this.iBarShift(0, S.touchT);
    if (age > c.setupMaxBars) { this._reset('setup too old'); return; }
    if (S.state === 1) {
      if (age > c.sweepWin) { this._reset('no liquidity sweep after the POI'); return; }
      const L = this.liquidity(-d, 2), atrP = this.iATR(c.poiTF, 14, 1), x1 = d === 1 ? this.iL(0, 1) : this.iH(0, 1); let pick = -1;
      for (let q = 0; q < L.n; q++) {
        if (L.lv[q] < S.bot - c.nearK * atrP || L.lv[q] > S.top + c.nearK * atrP) continue;
        if ((d === 1 && x1 < L.lv[q]) || (d === -1 && x1 > L.lv[q])) { if (pick < 0 || (d === 1 ? L.lv[q] < L.lv[pick] : L.lv[q] > L.lv[pick])) pick = q; }
      }
      if (pick < 0) { this.stateTxt = 'in POI - waiting for ' + (d === 1 ? 'SSL' : 'BSL') + ' to be cleared'; return; }
      S.state = 2; S.ext = x1; S.extT = this.iTime(0, 1); S.liq = L.lv[pick]; S.liqName = L.nm[pick];
      this._evt('liquidity cleared', d, 0, 0, 0, 0, S.liqName + ' ' + S.liq.toFixed(c.digits));
    }
    if (S.state === 2) {
      const x = d === 1 ? this.iL(0, 1) : this.iH(0, 1);
      if ((d === 1 && x < S.ext) || (d === -1 && x > S.ext)) { S.ext = x; S.extT = this.iTime(0, 1); }
      const es = this.iBarShift(0, S.extT), nameD = c.dispMode === 0 ? 'MSS' : 'CISD';
      if (es > c.dispWin) { this._reset('no displacement after the sweep'); return; }
      S.disp = this.dispLevel(d, es);
      if (S.disp === 0) { this.stateTxt = 'swept ' + S.liqName + ' - no reference for ' + nameD; return; }
      const c1 = this.iC(0, 1);
      if (!((d === 1 && c1 > S.disp) || (d === -1 && c1 < S.disp))) { this.stateTxt = 'swept ' + S.liqName + ' - waiting for ' + nameD + ' close beyond ' + S.disp.toFixed(c.digits); return; }
      if (c.dispBodyK > 0) {
        const atrE = this.iATR(0, 14, 1); let best = 0;
        for (let b = 1; b < es; b++) { const body = d * (this.iC(0, b) - this.iO(0, b)); if (body > best) best = body; }
        if (best < c.dispBodyK * atrE) { this.stateTxt = 'swept ' + S.liqName + ' - move too weak (no displacement candle)'; return; }
      }
      S.state = 3; S.dispT = this.iTime(0, 1);
      this._evt(nameD, d, 0, 0, 0, 0, 'close beyond ' + S.disp.toFixed(c.digits));
    }
    if (S.state === 3) {
      const es2 = this.iBarShift(0, S.extT), ds = this.iBarShift(0, S.dispT), atr = this.iATR(0, 14, 1);
      let fTop = 0, fBot = 0, fm = -1;
      for (let m = 2; m <= es2 - 1; m++) {
        let t = 0, b = 0;
        if (d === 1 && this.iL(0, m - 1) > this.iH(0, m + 1)) { t = this.iL(0, m - 1); b = this.iH(0, m + 1); }
        if (d === -1 && this.iH(0, m - 1) < this.iL(0, m + 1)) { t = this.iL(0, m + 1); b = this.iH(0, m - 1); }
        if (t - b < c.fvgMinK * atr || t <= b) continue;
        let filled = false;
        for (let k = m - 2; k >= 1 && !filled; k--) if ((d === 1 && this.iL(0, k) < b) || (d === -1 && this.iH(0, k) > t)) filled = true;
        if (filled) continue;
        fTop = t; fBot = b; fm = m; break;
      }
      if (fm < 0) { if (ds > 6) { this._reset('no FVG after the displacement'); return; } this.stateTxt = 'displacement - waiting for FVG'; return; }
      let zTop = fTop, zBot = fBot, mdl = 'Turtle Soup', bbTop = 0, bbBot = 0;
      if (c.model !== 1) {
        for (let o = es2 + 1; o <= es2 + 20 && o < this.iBars(0) - 1; o++) {
          const oo = this.iO(0, o), oc = this.iC(0, o);
          if ((d === 1 && oc > oo) || (d === -1 && oc < oo)) {
            let broke = false;
            for (let k3 = es2 - 1; k3 >= 1 && !broke; k3--) if ((d === 1 && this.iC(0, k3) > this.iH(0, o)) || (d === -1 && this.iC(0, k3) < this.iL(0, o))) broke = true;
            if (broke) { bbTop = Math.max(oo, oc); bbBot = Math.min(oo, oc); }
            break;
          }
        }
        if (bbTop > 0) { const ot = Math.min(fTop, bbTop), ob = Math.max(fBot, bbBot); if (ot > ob) { zTop = ot; zBot = ob; mdl = 'Unicorn'; } }
        if (c.model === 2 && mdl !== 'Unicorn') { this._reset('no Unicorn (FVG does not overlap a Breaker Block)'); return; }
      }
      if (!inKZ) { this.stateTxt = mdl + ' ready - waiting for the killzone to open'; return; }
      const entry = c.entryAt === 1 ? (zTop + zBot) / 2 : (d === 1 ? zTop : zBot), buf = c.slBufK * atr; let sl;
      if (c.slMode === 0) sl = S.ext - d * buf;
      else sl = d === 1 ? Math.min(zBot, mdl === 'Unicorn' ? bbBot : fBot) - buf : Math.max(zTop, mdl === 'Unicorn' ? bbTop : fTop) + buf;
      this._place(d, entry, sl, mdl, { zTop, zBot, fTop, fBot, bbTop, bbBot, atr });
    }
  }
  // Snapshot of "why this trade": stored on the signal, then on the order, position and closed trade.
  _why(d, entry, sl, slRaw, tp, tpName, rank, rr, lots, mdl, useLimit, S, z) {
    const c = this.c, dg = c.digits, f = x => Number(x).toFixed(dg), side = d === 1 ? 'BUY' : 'SELL';
    const poi = (S.poiType === 0 ? 'FVG' : 'OB') + ' ' + this._tfName(c.poiTF) + ' ' + f(S.bot) + '-' + f(S.top);
    const slBasis = c.slMode === 0 ? 'ใต้/เหนือจุดสุดของการกวาดสภาพคล่อง ' + f(S.ext)
      : 'นอกขอบ ' + (mdl === 'Unicorn' ? 'FVG+Breaker' : 'FVG') + ' ' + f(d === 1 ? Math.min(z.zBot || 0, mdl === 'Unicorn' ? z.bbBot : z.fBot) : Math.max(z.zTop || 0, mdl === 'Unicorn' ? z.bbTop : z.fTop)) + ' + buffer';
    const widened = Math.abs(slRaw - sl) > Math.pow(10, -dg) ? ' (ขยายให้ถึง SL ขั้นต่ำ)' : '';
    const dn = c.dispMode === 0 ? 'MSS' : 'CISD';
    const chain = this.log.filter(e => e.t >= (S.touchT || 0) - 300).slice(-6).map(e => e.ny + ' ' + e.evt + (e.det ? ' (' + e.det + ')' : ''));
    const lines = [
      'Bias: ' + this._biasName(this.bias) + ' (H4 ' + this._biasName(this.biasH4) + ', D1 ' + this._biasName(this.biasD1) + ') → เล่นฝั่ง ' + side,
      'POI: ราคาเข้าโซน ' + poi,
      'Liquidity: กวาด ' + (S.liqName === 'swing' ? 'swing low/high' : S.liqName) + ' ' + f(S.liq) + ' (จุดสุด ' + f(S.ext) + ')',
      dn + ': ปิดทะลุ ' + f(S.disp) + ' = ยืนยันการกลับตัว',
      'โมเดล ' + mdl + ': โซนเข้า ' + f(z.zBot) + '-' + f(z.zTop) + (useLimit ? ' วาง limit @ ' + f(entry) : ' เข้า market @ ' + f(entry)),
      'SL ' + f(sl) + ' ← ' + slBasis + widened,
      'TP ' + f(tp) + ' ← ' + tpName + ' (เป้าหมายที่ ' + rank + ') RR ' + rr.toFixed(2),
    ];
    return { side, ny: this.nyStr(this.T0()), model: mdl, mode: dn, biasH4: this._biasName(this.biasH4), biasD1: this._biasName(this.biasD1),
      poi: { type: S.poiType === 0 ? 'FVG' : 'OB', tf: this._tfName(c.poiTF), top: S.top, bot: S.bot }, sweep: { name: S.liqName, level: S.liq, extreme: S.ext },
      disp: { mode: dn, level: S.disp }, zone: { top: z.zTop, bot: z.zBot }, slBasis: slBasis + widened, tp: { name: tpName, rank, price: tp }, entry, sl, rr: Number(rr.toFixed(2)), lots, text: lines.join('\n'), chain };
  }
  _biasName(b) { return b === 1 ? 'BULL' : b === -1 ? 'BEAR' : 'none'; }
  _lotsFor(entry, stop) {
    const c = this.c, bal = this._balance(), perLot = c.tickSize > 0 ? Math.abs(entry - stop) / c.tickSize * c.tickValue : 0; let lots = c.fixedLots;
    if (lots <= 0) lots = perLot > 0 ? bal * c.riskPercent / 100 / perLot : c.minLot;
    if (c.lotStep > 0) lots = Math.floor(lots / c.lotStep + 1e-9) * c.lotStep;
    if (lots < c.minLot) {
      const riskAtMin = perLot * c.minLot;
      if (c.fixedLots <= 0 && riskAtMin > bal * c.maxRiskPctMinLot / 100) { this.riskTxt = 'min lot would risk ' + riskAtMin.toFixed(2) + ' (' + (100 * riskAtMin / Math.max(1e-9, bal)).toFixed(1) + '% of balance)'; return 0; }
      lots = c.minLot;
    }
    this.riskTxt = Math.min(c.maxLot, lots).toFixed(2) + ' lots, risk ' + (perLot * Math.min(c.maxLot, lots)).toFixed(2);
    return normalize(Math.min(c.maxLot, lots), 2);
  }
  _balance() { return this.host.balance ? this.host.balance() : 0; }
  _ours() { return this.host.ours ? this.host.ours() : []; }
  _tradingAllowed() {
    const t = this.host.today ? this.host.today() : { opened: 0, pl: 0 }, c = this.c;
    if (t.blocked) return { ok: false, why: t.blocked };
    if (c.maxTradesPerDay > 0 && t.opened >= c.maxTradesPerDay) return { ok: false, why: 'max trades for today reached' };
    const startBal = this._balance() - t.pl;
    if (c.dailyLossPct > 0 && t.pl < 0 && startBal > 0 && -t.pl >= startBal * c.dailyLossPct / 100) return { ok: false, why: 'daily loss limit hit - done for today' };
    return { ok: true, why: 'ok' };
  }
  _place(d, entry, sl, mdl, zc) {
    const c = this.c, S0 = { ...this.s }, sl0 = sl, q = this.quote || { bid: this.iC(0, 1), ask: this.iC(0, 1) }, mkt = d === 1 ? q.ask : q.bid, stopLvl = 0; let useLimit = true;
    if ((d === 1 && mkt <= entry) || (d === -1 && mkt >= entry)) { useLimit = false; entry = mkt; }
    else if (Math.abs(mkt - entry) < stopLvl) { useLimit = false; entry = mkt; }
    if ((d === 1 && entry <= sl) || (d === -1 && entry >= sl)) { this._reset('price already beyond the stop'); return; }
    const minD = c.minSLK * this.iATR(c.poiTF, 14, 1);
    if (c.minSLK > 0 && Math.abs(entry - sl) < minD) sl = entry - d * minD;
    const risk = Math.abs(entry - sl), L = this.liquidity(d, 1); let tp = 0, tpName = '', rank = 0;
    for (let r = 0; r < c.tpLevelMax; r++) {
      let best = -1;
      for (let qq = 0; qq < L.n; qq++) {
        if ((d === 1 && L.lv[qq] <= entry) || (d === -1 && L.lv[qq] >= entry)) continue;
        if (r > 0 && ((d === 1 && L.lv[qq] <= tp) || (d === -1 && L.lv[qq] >= tp))) continue;
        if (best < 0 || (d === 1 ? L.lv[qq] < L.lv[best] : L.lv[qq] > L.lv[best])) best = qq;
      }
      if (best < 0) break;
      tp = L.lv[best]; tpName = L.nm[best]; rank = r + 1;
      if (Math.abs(tp - entry) >= c.minRR * risk) break;
    }
    if (tp === 0) { this._reset('no liquidity target'); return; }
    const rr = Math.abs(tp - entry) / risk;
    if (rr < c.minRR) { this._reset('R:R ' + rr.toFixed(2) + ' < ' + c.minRR.toFixed(2) + ' (TP ' + tpName + ')'); return; }
    sl = normalize(sl, c.digits); tp = normalize(tp, c.digits); entry = normalize(entry, c.digits);
    if (Math.abs(entry - sl) < stopLvl || Math.abs(tp - entry) < stopLvl) { this._reset('SL/TP inside stop level'); return; }
    const al = this._tradingAllowed();
    if (!al.ok) { this.riskTxt = al.why; this._reset('blocked: ' + al.why); return; }
    const lots = this._lotsFor(entry, sl);
    if (lots <= 0) { this._reset('min lot risk too high for balance'); return; }
    const type = useLimit ? (d === 1 ? 2 : 3) : (d === 1 ? 0 : 1);
    const cmt = 'BPE ' + (mdl === 'Unicorn' ? 'UC' : 'TS') + ' ' + (c.dispMode === 0 ? 'MSS' : 'CISD');
    const det = mdl + ', TP' + rank + ' ' + tpName + ', ' + lots.toFixed(2) + ' lots, ' + (useLimit ? 'limit' : 'market');
    const why = this._why(d, entry, sl, sl0, tp, tpName, rank, rr, lots, mdl, useLimit, S0, zc || {});
    this._evt(useLimit ? 'limit placed' : 'market entry', d, entry, sl, tp, rr, det);
    this.lastTxt = (d === 1 ? 'BUY ' : 'SELL ') + det;
    this.out.push({ action: type === 2 ? 'buy_limit' : type === 3 ? 'sell_limit' : type === 0 ? 'buy' : 'sell', type, price: entry, sl, tp, lots, comment: cmt, model: mdl, rr, tpName, barT: this.gNow, why });
    this.s.state = 0; this.s.dir = 0; this.stateTxt = 'order sent';
  }
  _manage(kz) {
    const c = this.c, inKZ = kz.st === 2;
    for (const o of this._ours()) {
      if (o.local) continue;     // a signal that the trader has not processed yet
      if (o.pending === false || o.type === 'buy' || o.type === 'sell') {
        if ((c.maxHoldBars > 0 && this.iBarShift(0, o.openT) >= c.maxHoldBars) || (c.closeAtKZEnd && !inKZ)) this.out.push({ action: 'close', comment: 'BPE close' });
        continue;
      }
      const age = this.iBarShift(0, o.openT), reached = o.type === 'buylimit' ? this.iH(0, 1) >= o.tp : this.iL(0, 1) <= o.tp;
      if (age > c.expiryBars || reached || (c.cancelOutsideKZ && !inKZ)) {
        this._evt('limit cancelled', o.type === 'buylimit' ? 1 : -1, o.price, o.sl, o.tp, 0, reached ? 'target reached first' : (age > c.expiryBars ? 'expired' : 'killzone ended'));
        this.out.push({ action: 'cancel', comment: reached ? 'target reached first' : (age > c.expiryBars ? 'expired' : 'killzone ended') });
      }
    }
  }
  // -------------------------------------------------------------- driver
  // A bar (UTC-independent: t in server time) closed. Feed it; returns the actions the engine wants (may be empty).
  // Evaluate like OnTick() at the open of the next bar: nextOpen is the best estimate of that price.
  onBar(t, o, h, l, c, quote) {
    const added = this.st.addClosed(t, o, h, l, c);
    if (!added) return [];
    return this.evaluate(t + 300, quote || { bid: c, ask: c });
  }
  addHistory(t, o, h, l, c) { return this.st.addClosed(t, o, h, l, c); }
  evaluate(now, quote) {
    this.out = []; this.gNow = now; this.quote = quote;
    this.st.pushForming(now, quote.bid);
    try {
      if (this.host.sync) this.host.sync(this.iTime(1440, 0));
      if (this.T0() === this.lastBar) return this.out;
      this.lastBar = this.T0();
      if (this.iBars(0) < this.c.liqLook + 20) return this.out;
      const kz = this.kzState(this.T0());
      this._manage(kz);
      this.kzTxt = kz.st === 2 ? 'IN ' + kz.name : kz.st === 1 ? 'before ' + kz.name + ' (watching)' : 'outside killzone';
      const p0 = this.iTime(this.c.poiTF, 0);
      if (p0 !== this.lastPoiBar) { this.lastPoiBar = p0; this.updateBias(); this.scanPOI(); }
      if (this._ours().length > 0) { if (this.s.state !== 0) this._reset('order already open'); return this.out; }
      this.step(kz.st);
    } finally { this.st.popForming(); }
    return this.out;
  }
  status() {
    return { time: this.gNow, ny: this.nyStr(this.gNow), kz: this.kzTxt, bias: this._biasName(this.bias), biasH4: this._biasName(this.biasH4), biasD1: this._biasName(this.biasD1), eq: this.eqLvl,
      poi: this.poi.map(p => ({ top: p.top, bot: p.bot, type: p.type === 0 ? 'FVG' : 'OB' })), state: this.stateTxt, last: this.lastTxt, risk: this.riskTxt,
      bars: { m5: this.st.tf[5].t.length, h4: this.st.tf[240].t.length, d1: this.st.tf[1440].t.length }, log: this.log.slice(-12) };
  }
  serialize() { return { store: this.st.serialize(), used: this.used.slice(-400), s: this.s, lastBar: this.lastBar, lastPoiBar: this.lastPoiBar, bias: [this.biasH4, this.biasD1, this.bias, this.rangeHi, this.rangeLo, this.eqLvl], poi: this.poi }; }
  load(o) {
    if (!o) return; this.st = BarStore.load(o.store); this.used = o.used || []; this.s = o.s; this.lastBar = o.lastBar; this.lastPoiBar = o.lastPoiBar;
    [this.biasH4, this.biasD1, this.bias, this.rangeHi, this.rangeLo, this.eqLvl] = o.bias; this.poi = o.poi || [];
  }
}

module.exports = { Bpe, BarStore, DEFAULTS };
