'use strict';
// Chart Desk BPE - cloud side.
//   TradingView (Pine alerts) --webhook--> /tv : closed bars (prices) and trade signals
//   ESP32 ("the trader")      --HTTPS-->   /api/signals, /api/order ... : reads signals, decides, sends orders
// This server keeps the signal queue and the virtual (paper) account, fills orders against the bars that
// TradingView sends, serves the dashboard, and sends alerts (LINE / Telegram / generic webhook).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Engine } = require('./engine');
const { toServer } = require('./lib/timeutil');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'paper.json');
const SYMBOL = process.env.SYMBOL || 'US100';
const DIGITS = Number(process.env.DIGITS || 2);
const SPREAD = Number(process.env.SPREAD || 0);                 // price units added to the bid for the ask
const START_BALANCE = Number(process.env.START_BALANCE || 10000);
const MULTIPLIER = Number(process.env.MULTIPLIER || 1);
const MIN_VOLUME = Number(process.env.MIN_VOLUME || 1), STEP_VOLUME = Number(process.env.STEP_VOLUME || 1), MAX_VOLUME = Number(process.env.MAX_VOLUME || 1000000);
const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || '';
const LINE_TO = process.env.LINE_TO || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const NOTIFY_URL = process.env.NOTIFY_WEBHOOK_URL || '';

if (!API_KEY || API_KEY.length < 12) {
  console.error('API_KEY is missing or shorter than 12 characters. Set it in the Railway Variables tab.');
  process.exit(1);
}

const engine = new Engine({ startBalance: START_BALANCE, multiplier: MULTIPLIER });
const meta = { signals: [], nextSig: 1, dayKey: -1, dayStartBalance: START_BALANCE, takenToday: 0, barCount: 0, lastBarWall: 0 };
let testNow = 0;                                                  // TEST_MODE only: lets the simulator drive the clock
const now = () => testNow || Math.floor(Date.now() / 1000);

try {
  if (fs.existsSync(DATA_FILE)) {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    engine.load(JSON.stringify(d.engine)); Object.assign(meta, d.meta || {});
    console.log('state loaded:', engine.trades.length, 'trades,', meta.signals.length, 'signals');
  }
} catch (e) { console.error('could not load state:', e.message); }

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify({ engine: JSON.parse(engine.serialize()), meta }));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) { console.error('save failed:', e.message); }
  }, 300);
}

// ---- trading day (server time = New York + 7h, midnight to midnight like MT4) ------------
function rollDay() {
  const dk = Math.floor(toServer(now()) / 86400);
  if (dk !== meta.dayKey) { meta.dayKey = dk; meta.dayStartBalance = engine.balance; meta.takenToday = 0; save(); }
}

// ---- notifications -----------------------------------------------------------------------
const sideName = s => (s === 1 ? 'BUY' : 'SELL');
const fx = x => (typeof x === 'number' ? x.toFixed(DIGITS) : x);
function describe(ev) {
  if (ev.type === 'signal') { const s = ev.signal; return `📡 สัญญาณจาก TradingView: ${s.action.toUpperCase()} ${SYMBOL}${s.price ? ' @ ' + fx(s.price) : ''}${s.sl ? '\nSL ' + fx(s.sl) + '  TP ' + fx(s.tp) : ''}${s.comment ? '\n' + s.comment : ''}`; }
  if (ev.type === 'decision') { const s = ev.signal; return s.status === 'taken' ? `✅ ESP32 รับสัญญาณ #${s.id} (${s.action}) ${s.note || ''}`.trim() : `⏭ ESP32 ข้ามสัญญาณ #${s.id} (${s.action}): ${s.reason || ''}`; }
  if (ev.type === 'order') { const o = ev.order; return `📝 วาง ${sideName(o.side)} LIMIT ${SYMBOL} @ ${fx(o.price)}\nSL ${fx(o.sl)}  TP ${fx(o.tp)}  ขนาด ${o.volume / 100}`; }
  if (ev.type === 'cancel') return `🚫 ยกเลิก limit #${ev.order.id} (${sideName(ev.order.side)} @ ${fx(ev.order.price)})`;
  if (ev.type === 'open') { const p = ev.pos; return `🟢 เปิด ${sideName(p.side)} ${SYMBOL} @ ${fx(p.open)} (${ev.via})\nSL ${fx(p.sl)}  TP ${fx(p.tp)}  ขนาด ${p.volume / 100}`; }
  if (ev.type === 'close') { const t = ev.trade; return `${t.pnl >= 0 ? '💰' : '🔻'} ปิด ${sideName(t.side)} ${SYMBOL} ${fx(t.open)} → ${fx(t.close)} [${t.reason}]\nกำไร/ขาดทุน ${t.pnl}  (${t.R}R)  ยอดเงิน ${ev.balance}`; }
  return '';
}
function pushLine(text) {
  if (!LINE_TOKEN || !LINE_TO) return Promise.resolve(false);
  return fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + LINE_TOKEN },
    body: JSON.stringify({ to: LINE_TO, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  }).then(async r => { if (!r.ok) console.error('line:', r.status, await r.text()); return r.ok; }).catch(e => { console.error('line:', e.message); return false; });
}
async function notify(events) {
  const lines = events.map(describe).filter(Boolean);
  if (!lines.length) return;
  pushLine('[PAPER] ' + lines.join('\n\n'));       // one push per call: spares the monthly message quota
  for (const ev of events) {
    const text = '[PAPER] ' + describe(ev);
    if (TG_TOKEN && TG_CHAT) fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text }) }).catch(e => console.error('telegram:', e.message));
    if (NOTIFY_URL) fetch(NOTIFY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'chartdesk-bpe-paper', symbol: SYMBOL, text, event: ev }) }).catch(e => console.error('notify webhook:', e.message));
  }
}
function flush(extra = []) { const ev = extra.concat(engine.takeEvents()); if (ev.length) { notify(ev); save(); } return ev; }

// ---- TradingView webhook ---------------------------------------------------------------------
const ACTIONS = { buy: 'buy', long: 'buy', sell: 'sell', short: 'sell', buy_limit: 'buy_limit', sell_limit: 'sell_limit', cancel: 'cancel', close: 'close', close_all: 'close' };
const nz = x => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

function tradingView(b) {
  const ev = String(b.event || (b.action ? 'signal' : '')).toLowerCase();
  if (ev === 'bar') {
    const t = nz(b.t), o = nz(b.o), h = nz(b.h), l = nz(b.l), c = nz(b.c);
    if (t > 1e11) return { error: 'TIME_IN_MS' };                       // Pine `time` is milliseconds: send time/1000
    if (!(t > 1e9 && o > 0 && h >= l && c > 0)) return { error: 'BAD_BAR' };
    engine.setQuote(c, c + SPREAD, t);
    const ok = engine.processBar({ t: toServer(t), o, h, l, c }, SPREAD);
    if (ok) { meta.barCount++; meta.lastBarWall = now(); }
    rollDay(); flush();
    return { ok, processed: ok ? 1 : 0, lastBarT: engine.lastBarT };
  }
  if (ev === 'signal') {
    const action = ACTIONS[String(b.action || '').toLowerCase()];
    if (!action) return { error: 'BAD_ACTION' };
    const sig = { id: meta.nextSig++, recvT: now(), action, price: nz(b.price), sl: nz(b.sl), tp: nz(b.tp), comment: String(b.comment || '').slice(0, 80), tvId: String(b.id || ''), barT: nz(b.t), status: 'new', reason: '', note: '' };
    meta.signals.push(sig); if (meta.signals.length > 500) meta.signals.splice(0, meta.signals.length - 500);
    flush([{ type: 'signal', signal: { ...sig } }]);
    return { id: sig.id };
  }
  return { error: 'BAD_EVENT' };
}

let failAck = 0;                                                 // TEST_MODE only: make the next N acks fail
function ack(b) {
  if (failAck > 0) { failAck--; return { error: 'TEST_FAIL' }; }
  const s = meta.signals.find(x => x.id === Number(b.id));
  if (!s) return { error: 'NOT_FOUND' };
  if (s.status !== 'new') return { ok: true, already: true };
  s.status = b.status === 'taken' ? 'taken' : 'skipped'; s.reason = String(b.reason || '').slice(0, 120); s.note = String(b.note || '').slice(0, 120);
  s.orderId = nz(b.orderId); s.decidedT = now();
  rollDay();
  if (s.status === 'taken' && (s.action === 'buy' || s.action === 'sell' || s.action === 'buy_limit' || s.action === 'sell_limit')) meta.takenToday++;
  flush([{ type: 'decision', signal: { ...s } }]);
  return { ok: true };
}

// ---- views for the ESP32 / dashboard -------------------------------------------------------
function metaView() {
  rollDay();
  const st = engine.state();
  const q = st.quote.bid ? st.quote : { bid: 0, ask: 0, t: 0 };
  return {
    utc: now(), symbol: SYMBOL, digits: DIGITS, multiplier: MULTIPLIER, minVolume: MIN_VOLUME, stepVolume: STEP_VOLUME, maxVolume: MAX_VOLUME,
    bid: q.bid, ask: q.ask, lastBarT: st.lastBarT, barAge: meta.lastBarWall ? now() - meta.lastBarWall : -1,
    balance: st.balance, equity: st.equity, startBalance: st.startBalance, dayStartBalance: meta.dayStartBalance, todayPnl: Math.round((st.balance - meta.dayStartBalance) * 100) / 100,
    takenToday: meta.takenToday, positions: st.positions, orders: st.orders, tradeCount: st.tradeCount,
    pending: meta.signals.filter(s => s.status === 'new').length, equityTail: engine.equity.slice(-30).map(e => e[1]),
  };
}

// ---- http --------------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 512 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8').trim(); if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function send(res, code, obj, type = 'application/json') {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function authed(req, alt) {
  const k = String(req.headers['x-api-key'] || alt || '');
  if (k.length !== API_KEY.length) return false;
  let d = 0; for (let i = 0; i < k.length; i++) d |= k.charCodeAt(i) ^ API_KEY.charCodeAt(i);
  return d === 0;
}

const handlers = {
  'GET /api/meta': () => metaView(),
  'GET /api/state': () => engine.state(),
  'GET /api/stats': () => engine.stats(),
  'GET /api/trades': (_b, url) => ({ trades: engine.trades.slice(-Number(url.searchParams.get('limit') || 200)), equity: engine.equity.slice(-500) }),
  'GET /api/signals': (_b, url) => {
    const after = url.searchParams.get('after');
    const list = after !== null ? meta.signals.filter(s => s.id > Number(after)).slice(0, 20) : meta.signals.slice(-60).reverse();
    return { signals: list };
  },
  'POST /api/signals/ack': b => ack(b),
  'POST /api/order': b => { rollDay(); if (b.afterBarUtc > 0) b.afterT = toServer(Number(b.afterBarUtc)); const r = engine.placeOrder(b); flush(); return r; },
  'POST /api/cancel': b => { const r = engine.cancel(Number(b.id)); flush(); return r; },
  'POST /api/amend': b => { const r = engine.amend(Number(b.id), Number(b.sl), Number(b.tp)); save(); return r; },
  'POST /api/close': b => { const r = engine.close(Number(b.id), Number(b.price), Number(b.t), Number(b.volume), b.reason || 'time'); flush(); return r; },
  'POST /api/notify-test': async () => ({ line: await pushLine('[PAPER] ทดสอบแจ้งเตือน LINE จาก BPE Paper Server'), telegram: !!(TG_TOKEN && TG_CHAT) }),
  'POST /api/test/now': b => { if (process.env.TEST_MODE !== '1') return { error: 'NOT_ENABLED' }; testNow = Number(b.utc) || 0; return { ok: true }; },
  'POST /api/test/failack': b => { if (process.env.TEST_MODE !== '1') return { error: 'NOT_ENABLED' }; failAck = Number(b.n) || 0; return { ok: true }; },
  'POST /api/reset': b => { if (b.balance > 0) engine.startBalance = Number(b.balance); engine.reset(); meta.signals = []; meta.nextSig = 1; meta.dayKey = -1; meta.dayStartBalance = engine.balance; meta.takenToday = 0; save(); return { ok: true, balance: engine.balance }; },
};

const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, trades: engine.trades.length, lastBarT: engine.lastBarT, bars: meta.barCount });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, page, 'text/html; charset=utf-8');
    if (req.method === 'POST' && url.pathname === '/tv') {          // TradingView cannot send headers: key goes in ?key= or in the JSON body
      const b = await readBody(req);
      if (!authed(req, url.searchParams.get('key') || b.key)) return send(res, 401, { error: 'BAD_KEY' });
      const out = tradingView(b);
      return send(res, out.error ? 400 : 200, out);
    }
    const h = handlers[req.method + ' ' + url.pathname];
    if (!h) return send(res, 404, { error: 'NOT_FOUND' });
    if (!authed(req)) return send(res, 401, { error: 'BAD_KEY' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    const out = await h(body, url);
    if (out && out.error) return send(res, 400, out);
    return send(res, 200, out);
  } catch (e) {
    if (e.message === 'bad json' || e.message === 'too large') return send(res, 400, { error: e.message });
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`paper server on :${PORT}, symbol ${SYMBOL}, start balance ${engine.startBalance}, data ${DATA_FILE}`));
}
module.exports = { server, engine, meta };
