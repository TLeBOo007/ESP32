'use strict';
// Free price feeds: the server pulls closed M5 bars from a public web source instead of waiting for someone to push them.
//   FEED=yahoo       Yahoo Finance chart endpoint (unofficial, no key). Futures such as NQ=F trade ~24h.
//   FEED=twelvedata  Twelve Data time_series (free key, 800 requests a day; 1 request per 5-minute bar fits).
// On the very first poll the bars it gets are only used as warm-up for the H4 / D1 bias (no trading, nothing is counted);
// everything that closes afterwards is "forward": it fills paper orders and feeds the signal engine.
const BAR = 300;

function parseYahoo(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) throw new Error('unexpected Yahoo reply' + (j && j.chart && j.chart.error ? ': ' + JSON.stringify(j.chart.error) : ''));
  const q = r.indicators.quote[0], out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if ([o, h, l, c].some(x => x === null || x === undefined || !Number.isFinite(x))) continue;     // a missing bar is null
    out.push([r.timestamp[i], o, h, l, c]);
  }
  return out;
}
function parseTwelve(j) {
  if (!j || j.status === 'error' || !Array.isArray(j.values)) throw new Error('Twelve Data: ' + (j && (j.message || j.status) || 'bad reply'));
  const out = [];
  for (const v of j.values) {
    const t = Date.parse(String(v.datetime).replace(' ', 'T') + 'Z') / 1000, o = +v.open, h = +v.high, l = +v.low, c = +v.close;
    if (![t, o, h, l, c].every(Number.isFinite)) continue;
    out.push([t, o, h, l, c]);
  }
  return out;
}

class Feed {
  // opts: { kind, symbol, key, base, warmupDays, fetchJson(url, headers), now(), state (persisted object), history(rows), bar(row, evaluate), save(), log }
  constructor(o) {
    this.o = o; this.kind = o.kind; this.st = o.state;
    this.symbol = o.symbol || (o.kind === 'yahoo' ? 'NQ=F' : 'QQQ');
    this.warmupDays = Math.max(1, Math.min(o.kind === 'yahoo' ? 59 : 60, Number(o.warmupDays) || 30));
    this.timer = null; this.retries = 0;
  }
  url(first) {
    const b = this.o.base;
    if (this.kind === 'yahoo') return `${b || 'https://query1.finance.yahoo.com'}/v8/finance/chart/${encodeURIComponent(this.symbol)}?interval=5m&range=${first ? this.warmupDays + 'd' : '1d'}&includePrePost=true`;
    const n = first ? 5000 : 30;
    return `${b || 'https://api.twelvedata.com'}/time_series?symbol=${encodeURIComponent(this.symbol)}&interval=5min&outputsize=${n}&timezone=UTC&order=desc&apikey=${encodeURIComponent(this.o.key || '')}`;
  }
  async poll() {
    const now = this.o.now(), st = this.st, first = !st.forwardStart;
    let rows;
    try {
      const j = await this.o.fetchJson(this.url(first), this.kind === 'yahoo' ? { 'user-agent': 'Mozilla/5.0 (compatible; chartdesk-paper)' } : {});
      rows = this.kind === 'yahoo' ? parseYahoo(j) : parseTwelve(j);
      st.lastError = '';
    } catch (e) { st.lastError = String(e.message || e).slice(0, 200); st.lastPollT = now; this.o.save(); this.o.log('feed error: ' + st.lastError); return { error: st.lastError, fresh: 0 }; }
    st.lastPollT = now;
    if (first) st.forwardStart = now;
    rows = rows.filter(r => r[0] + BAR <= now - 2).sort((a, b) => a[0] - b[0]);       // closed bars only (the last row of a feed is usually still forming)
    const hist = [], live = []; let fresh = 0;
    for (const r of rows) {
      if (r[0] <= (st.lastT || 0)) continue;
      fresh++; st.lastT = r[0];
      if (r[0] + BAR <= st.forwardStart) hist.push(r);
      else live.push(r);
    }
    if (hist.length) this.o.history(hist);
    for (const r of live) this.o.bar(r, now - (r[0] + BAR) <= 900);      // bars that closed long ago (server was down) only move the account, they make no signals
    st.fresh = fresh; this.o.save();
    if (fresh) this.o.log(`feed: ${hist.length} warm-up bars, ${live.length} forward bars, last ${new Date(st.lastT * 1000).toISOString()}`);
    return { fresh, history: hist.length, forward: live.length };
  }
  // poll just after each 5-minute boundary; if the market was moving a moment ago and the new bar is not there yet, retry a few times
  next() {
    const now = this.o.now(), boundary = Math.floor(now / BAR) * BAR + BAR + 6;
    const wait = this.retries > 0 ? 25 : boundary - now + (this.o.offset || 0);
    return Math.max(5, wait);
  }
  start(delayMs = 1000) {
    const loop = async () => {
      let r; try { r = await this.poll(); } catch (e) { this.o.log('feed crash: ' + e.message); r = { fresh: 0 }; }
      const marketOpen = r.fresh > 0 || this.st.lastFresh > 0;
      if (r.fresh === 0 && marketOpen && this.retries < 2 && !r.error) this.retries++; else this.retries = 0;
      if (r.error) this.retries = 0;
      this.st.lastFresh = r.fresh || 0;
      this.timer = setTimeout(loop, this.next() * 1000);
    };
    this.timer = setTimeout(loop, delayMs);
  }
  stop() { clearTimeout(this.timer); }
}
module.exports = { Feed, parseYahoo, parseTwelve };
