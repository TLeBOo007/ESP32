'use strict';
// Chart Desk BPE - cloud side.
//   TradingView (Pine alerts) --webhook--> /tv : closed bars (prices) and trade signals
//   ESP32 ("the trader")      --HTTPS-->   /api/signals, /api/order ... : reads signals, decides, sends orders
// The signal engine (lib/bpe.js, the BPE ICT rules) runs here too: every closed M5 bar produces signals for the ESP32.
// This server keeps the signal queue and the virtual (paper) account, fills orders against the bars that
// TradingView sends, serves the dashboard, and sends alerts (LINE / Telegram / generic webhook).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Engine } = require('./engine');
const { toServer, serverToUtc } = require('./lib/timeutil');
const { Bpe } = require('./lib/bpe');
const { Feed } = require('./lib/feed');
const crypto = require('crypto');
const { Status, dailyText, statusText } = require('./lib/status');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'paper.json');
// EXAM=1: run this server as a Topstep-style evaluation account (futures contracts, trailing loss limit, target ...). See lib/exam.js and README_TH.md.
const EXAM_ON = process.env.EXAM === '1';
const hmToMin = (x, d) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(x || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : d; };
const EXAM_CFG = !EXAM_ON ? null : Object.assign({
  start: Number(process.env.START_BALANCE || 50000), target: Number(process.env.EXAM_TARGET || 3000), mll: Number(process.env.EXAM_MLL || 2000), dll: Number(process.env.EXAM_DLL || 0),
  consistency: Number(process.env.EXAM_CONSISTENCY || 55) / 100, minDays: Number(process.env.EXAM_MIN_DAYS || 2), flatNY: hmToMin(process.env.EXAM_FLAT_NY, 16 * 60 + 5), openNY: hmToMin(process.env.EXAM_OPEN_NY, 18 * 60),
  capContracts: Number(process.env.EXAM_CAP || 50), riskPct: Number(process.env.EXAM_RISK_PCT || 0.5), commissionRT: Number(process.env.EXAM_COMMISSION_RT || 0), mllOnEquity: process.env.EXAM_MLL_EQUITY !== '0',
}, process.env.EXAM_CONFIG ? JSON.parse(process.env.EXAM_CONFIG) : {});
const START_BALANCE = EXAM_ON ? EXAM_CFG.start : Number(process.env.START_BALANCE || 10000);
const MIN_VOLUME = Number(process.env.MIN_VOLUME || (EXAM_ON ? 100 : 1)), STEP_VOLUME = Number(process.env.STEP_VOLUME || (EXAM_ON ? 100 : 1)), MAX_VOLUME = Number(process.env.MAX_VOLUME || (EXAM_ON ? EXAM_CFG.capContracts * 100 : 1000000));   // volume unit = 1/100 contract
const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || '';
const LINE_TO = process.env.LINE_TO || '';
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || '';              // only needed for the "สถานะ" chat command (webhook signature check)
const ST_SETUP = process.env.LINE_STATUS_SETUP_STAGE === undefined ? 3 : Number(process.env.LINE_STATUS_SETUP_STAGE);   // tell me when a setup reaches this stage (0 = never)
const ST_DAILY = process.env.LINE_STATUS_DAILY !== '0', ST_FEED = process.env.LINE_STATUS_FEED !== '0';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const NOTIFY_URL = process.env.NOTIFY_WEBHOOK_URL || '';
const BPE_ON = (process.env.BPE_ENABLED || '1') !== '0';
const FEED_KIND = (process.env.FEED || 'none').toLowerCase();
const MAX_OPEN_TOTAL = Number(process.env.BPE_MAX_OPEN || 3);          // positions + pending orders across all instruments (0 = no cap)

if (!API_KEY || API_KEY.length < 12) {
  console.error('API_KEY is missing or shorter than 12 characters. Set it in the Railway Variables tab.');
  process.exit(1);
}

// ---- instruments -------------------------------------------------------------------------------
// mult = account currency per 1.00 price unit per 1.00 lot. Spreads are typical retail values (price units).
// yahoo / twelve: the symbol of that free feed. td: spread to use when the Twelve Data ETF proxy is the source.
const PRESETS = {
  US100:  { digits: 2, spread: 1.0,     mult: 1,      yahoo: 'NQ=F',      twelve: 'QQQ',     spreadTD: 0.02 },
  US30:   { digits: 2, spread: 2.0,     mult: 1,      yahoo: 'YM=F',      twelve: 'DIA',     spreadTD: 0.02 },
  EURUSD: { digits: 5, spread: 0.00012, mult: 100000, yahoo: 'EURUSD=X',  twelve: 'EUR/USD', bpe: { waitEquityOpen: false } },
  USDJPY: { digits: 3, spread: 0.012,   mult: 100000 / 150, jpy: true, yahoo: 'JPY=X', twelve: 'USD/JPY', bpe: { waitEquityOpen: false } },
  US500:  { digits: 2, spread: 0.5,     mult: 1,      yahoo: 'ES=F',      twelve: 'SPY',     spreadTD: 0.02 },
  GBPUSD: { digits: 5, spread: 0.00015, mult: 100000, yahoo: 'GBPUSD=X',  twelve: 'GBP/USD', bpe: { waitEquityOpen: false } },
  AUDUSD: { digits: 5, spread: 0.00014, mult: 100000, yahoo: 'AUDUSD=X',  twelve: 'AUD/USD', bpe: { waitEquityOpen: false } },
  USDCAD: { digits: 5, spread: 0.00018, mult: 100000 / 1.37, jpy: true, yahoo: 'CAD=X', twelve: 'USD/CAD', bpe: { waitEquityOpen: false } },   // jpy:true = USD is the base, profit is in the quote currency (CAD) -> converted at the current rate
  XAGUSD: { digits: 3, spread: 0.03,    mult: 5000,   yahoo: 'SI=F',      twelve: 'XAG/USD', bpe: { waitEquityOpen: false } },
  XAUUSD: { digits: 2, spread: 0.30,    mult: 100,    yahoo: 'GC=F',      twelve: 'XAU/USD', bpe: { waitEquityOpen: false, biasMode: 0 } }   // gold: H4-only bias (H4 vs D1 often conflict -> no trades); such trades get grade B/C,
};
// Exam mode trades micro futures: mult = dollars per 1.00 price unit per contract (MNQ $2/point, MES $5, MYM $0.50, MGC $10 per $1/oz,
// M6E 12,500 EUR, M6B 6,250 GBP, M6A 10,000 AUD, SIL 1,000 oz); spread = about one tick. Check the contract list your evaluation allows.
const FUT = {
  US100:  { digits: 2, spread: 0.25,    mult: 2 },
  US500:  { digits: 2, spread: 0.25,    mult: 5 },
  US30:   { digits: 2, spread: 1.0,     mult: 0.5 },
  XAUUSD: { digits: 2, spread: 0.10,    mult: 10 },
  XAGUSD: { digits: 3, spread: 0.005,   mult: 1000 },
  EURUSD: { digits: 5, spread: 0.00005, mult: 12500 },
  GBPUSD: { digits: 5, spread: 0.0001,  mult: 6250 },
  AUDUSD: { digits: 5, spread: 0.0001,  mult: 10000 },
};
const LEGACY = !process.env.SYMBOLS && !EXAM_ON;                                       // old single-symbol setup: SYMBOL / DIGITS / SPREAD / MULTIPLIER decide everything
const SYM_LIST = (process.env.SYMBOLS || process.env.SYMBOL || 'US100').split(',').map(x => x.trim().toUpperCase()).filter(Boolean).filter(x => { if (EXAM_ON && !FUT[x]) { console.warn('EXAM: ' + x + ' has no micro-futures preset (USDJPY / USDCAD are quoted the other way round) - skipped'); return false; } return true; });
if (!SYM_LIST.length) { console.error('EXAM: no usable symbols. Use SYMBOLS=' + Object.keys(FUT).join(',')); process.exit(1); }
const ENTRY = new Set(['buy', 'sell', 'buy_limit', 'sell_limit']);
const now0 = () => Math.floor(Date.now() / 1000);

const acct = { balance: START_BALANCE, nextId: 1001 };
const insts = new Map();                                                   // symbol -> { sym, cfg, engine, bpe, feed }
for (const sym of SYM_LIST) {
  const pr = EXAM_ON ? { ...(PRESETS[sym] || {}), ...FUT[sym], jpy: false } : (PRESETS[sym] || {}), E = k => process.env[k + '_' + sym];
  const cfg = LEGACY
    ? { digits: Number(process.env.DIGITS || 2), spread: Number(process.env.SPREAD || 0), mult: Number(process.env.MULTIPLIER || 1), jpy: false, bpe: {} }
    : { digits: Number(E('DIGITS') || pr.digits || 2), mult: Number(E('MULT') || pr.mult || 1), jpy: !!pr.jpy, bpe: pr.bpe || {},
        spread: Number(E('SPREAD') || (FEED_KIND === 'twelvedata' && pr.spreadTD) || pr.spread || 0) };
  cfg.feedSymbol = (LEGACY ? process.env.FEED_SYMBOL : E('FEED_SYMBOL')) || (FEED_KIND === 'twelvedata' ? pr.twelve : pr.yahoo) || undefined;
  const point = Math.pow(10, -cfg.digits);
  const inst = { sym, cfg, feed: null };
  inst.engine = new Engine({ startBalance: START_BALANCE, multiplier: cfg.mult, acct, sym, commissionRT: EXAM_ON ? EXAM_CFG.commissionRT : 0 });
  inst.engine.spread = cfg.spread;
  inst.bpe = new Bpe(Object.assign({
    symbol: sym, digits: cfg.digits, point, tickSize: point, tickValue: point * cfg.mult,
    minLot: MIN_VOLUME / 100, lotStep: STEP_VOLUME / 100, maxLot: MAX_VOLUME / 100,
    riskPercent: Number(process.env.BPE_RISK_PERCENT || (EXAM_ON ? EXAM_CFG.riskPct : 2)), maxTradesPerDay: Number(process.env.BPE_MAX_TRADES || 3), dailyLossPct: Number(process.env.BPE_DAILY_LOSS || (EXAM_ON ? 2 : 10)),
  }, process.env.BPE_CONFIG ? JSON.parse(process.env.BPE_CONFIG) : {}, cfg.bpe, E('BPE_CONFIG') ? JSON.parse(E('BPE_CONFIG')) : {}), {   // order: global BPE_CONFIG < the preset of this instrument < BPE_CONFIG_<SYM>
    balance: () => acct.balance,
    ours: () => {
      const out = [], en = inst.engine;
      for (const p of en.positions) out.push({ type: p.side === 1 ? 'buy' : 'sell', pending: false, openT: p.openT, tp: p.tp, sl: p.sl, price: p.open });
      for (const o of en.orders) out.push({ type: o.side === 1 ? 'buylimit' : 'selllimit', pending: true, openT: o.createdT, tp: o.tp, sl: o.sl, price: o.price });
      for (const g of meta.signals) if (g.sym === sym && g.status === 'new' && ENTRY.has(g.action) && now() - g.recvT < 900) out.push({ local: true, type: g.action.replace('_', ''), pending: g.action.endsWith('limit'), openT: 0, tp: g.tp, sl: g.sl, price: g.price });
      return out;
    },
    today: () => {
      const d0 = Math.floor(toServer(now()) / 86400) * 86400; let open = 0;
      for (const i of insts.values()) open += i.engine.positions.length + i.engine.orders.length;
      const mine = inst.engine.positions.length + inst.engine.orders.length;
      const t = { opened: inst.engine.trades.filter(x => x.openT >= d0).length, pl: acct.balance - meta.dayStartBalance };
      if (MAX_OPEN_TOTAL > 0 && open - mine >= MAX_OPEN_TOTAL) t.blocked = 'too many open trades across instruments (' + (open - mine) + '/' + MAX_OPEN_TOTAL + ')';
      return t;
    },
  });
  insts.set(sym, inst);
}
const FIRST = insts.get(SYM_LIST[0]);
const engine = FIRST.engine, bpe = FIRST.bpe;                              // single-symbol aliases (tests and old code)
const instOf = x => insts.get(String(x || '').toUpperCase()) || FIRST;
const ownerOfId = id => { for (const i of insts.values()) if (i.engine.orders.some(o => o.id === id) || i.engine.positions.some(p => p.id === id)) return i; return null; };
const allTrades = () => [].concat(...[...insts.values()].map(i => i.engine.trades)).sort((a, b) => a.closeT - b.closeT);
const allPositions = () => [].concat(...[...insts.values()].map(i => i.engine.positions));
const allOrders = () => [].concat(...[...insts.values()].map(i => i.engine.orders));

const meta = { signals: [], nextSig: 1, dayKey: -1, dayStartBalance: START_BALANCE, takenToday: 0, barCount: 0, lastBarWall: 0, feeds: {} };
let testNow = 0;                                                  // TEST_MODE only: lets the simulator drive the clock
const now = () => testNow || now0();

try {
  if (fs.existsSync(DATA_FILE)) {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    Object.assign(meta, d.meta || {}); if (!meta.feeds) meta.feeds = {};
    if (d.acct) Object.assign(acct, d.acct);
    const engines = d.engines || (d.engine ? { [FIRST.sym]: d.engine } : {});          // old single-symbol save files load into the first symbol
    for (const [sym, e] of Object.entries(engines)) { const i = insts.get(sym); if (i) i.engine.load(JSON.stringify(e)); }
    if (d.acct) Object.assign(acct, d.acct);
    if (meta.feed && !meta.feeds[FIRST.sym]) meta.feeds[FIRST.sym] = meta.feed;
    const bpes = d.bpes || (d.bpe ? { [FIRST.sym]: d.bpe } : {});
    for (const [sym, b] of Object.entries(bpes)) { const i = insts.get(sym); if (i) try { i.bpe.load(b); } catch (e) { console.error('could not load signal engine state for', sym + ':', e.message); } }
    console.log('state loaded:', allTrades().length, 'trades,', meta.signals.length, 'signals,', insts.size, 'instruments');
  }
} catch (e) { console.error('could not load state:', e.message); }

// ---- exam mode ---------------------------------------------------------------------------
const { Exam } = require('./lib/exam');
const exam = EXAM_ON ? new Exam(EXAM_CFG, meta.exam || {}) : null;
let examView = null, examBusy = false;
function examFlatten(reason, t) {
  for (const i of insts.values()) {
    for (const p of [...i.engine.positions]) i.engine.close(p.id, undefined, t, undefined, 'exam');
    for (const o of [...i.engine.orders]) i.engine.cancel(o.id);
    flush(i);
  }
  console.log('EXAM: everything closed (' + reason + ')');
}
function examEval() {
  if (!exam || examBusy) return examView;
  examBusy = true;
  try {
    const t = toServer(now());
    const run = () => exam.evaluate({ trades: allTrades(), balance: acct.balance, floating: floatingAll(), open: allPositions().length, serverT: t });
    let r = run(); const events = r.events.slice();
    if (r.flatten) { examFlatten(r.flatten, t); r = run(); events.push(...r.events); }
    meta.exam = exam.serialize(); examView = r.view;
    if (events.length) { notify(events.map(text => ({ type: 'status', text: '🎓 ' + text }))); save(); }
  } catch (e) { console.error('exam:', e); }
  examBusy = false;
  return examView;
}
// Guard for every NEW order (the ESP32 decides, the server enforces the evaluation rules): status, trading day, daily loss, stop required,
// size clamped to the per-trade risk limit, contract cap. Returns {error} to refuse, or may lower b.volume.
function examGuard(inst, b) {
  if (!exam) return null;
  const view = examEval(), t = toServer(now()), side = b.side === 2 ? 2 : 1, kind = b.kind === 'market' ? 'market' : 'limit', q = inst.engine.quote;
  const entry = kind === 'market' ? (side === 1 ? Number(b.ask || q.ask) : Number(b.bid || q.bid)) : Number(b.price), sl = Number(b.sl) || 0;
  let vol = Math.round(Number(b.volume));
  if (!(vol > 0)) return { error: 'BAD_VOLUME' };
  if (!(sl > 0) || !(entry > 0)) return { error: 'EXAM_NO_STOP: an order needs a price and a stop loss' };
  const perContract = Math.abs(entry - sl) * inst.engine.mult, maxRisk = exam.c.riskPct / 100 * exam.c.start;
  const fit = Math.floor(maxRisk / (perContract + exam.c.commissionRT) + 1e-9);
  if (fit < 1) return { error: `EXAM_RISK: 1 contract risks about $${perContract.toFixed(0)}, over the limit of $${maxRisk.toFixed(0)} per trade` };
  if (vol > fit * 100) vol = fit * 100;
  const contracts = (allPositions().reduce((a, p) => a + p.volume, 0) + allOrders().reduce((a, o) => a + o.volume, 0)) / 100;
  const g = exam.canOpen(view, t, contracts, vol / 100);
  if (!g.ok) return { error: g.why };
  b.volume = vol; return null;
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const engines = {}, bpes = {};
      for (const i of insts.values()) { engines[i.sym] = JSON.parse(i.engine.serialize()); bpes[i.sym] = i.bpe.serialize(); }
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify({ v: 2, acct, engines, meta, bpes }));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) { console.error('save failed:', e.message); }
  }, 300);
}

// ---- trading day (server time = New York + 7h, midnight to midnight like MT4) ------------
function rollDay() {
  const dk = Math.floor(toServer(now()) / 86400);
  if (dk !== meta.dayKey) {
    const old = meta.dayKey;
    if (old > 0 && ST_DAILY) sendDaily(old, meta.dayStartBalance);                  // summary of the day that just ended
    meta.dayKey = dk; meta.dayStartBalance = acct.balance; meta.takenToday = 0; meta.setupsToday = 0; save();
  }
}

// ---- notifications -----------------------------------------------------------------------
const sideName = s => (s === 1 ? 'BUY' : 'SELL');
const fxs = (x, sym) => (typeof x === 'number' ? x.toFixed(instOf(sym).cfg.digits) : x);
function describe(ev) {
  if (ev.type === 'status') return ev.text;
  const SYMBOL = ev.sym || FIRST.sym, fx = x => fxs(x, SYMBOL);
  if (ev.type === 'signal') { const s = ev.signal; return `📡 สัญญาณ ${s.action.toUpperCase()} ${SYMBOL}${s.price ? ' @ ' + fx(s.price) : ''}${s.sl ? '\nSL ' + fx(s.sl) + '  TP ' + fx(s.tp) : ''}${s.comment ? '\n' + s.comment : ''}`; }
  if (ev.type === 'decision') { const s = ev.signal; return s.status === 'taken' ? `✅ ESP32 รับสัญญาณ #${s.id} ${SYMBOL} (${s.action}) ${s.note || ''}`.trim() : `⏭ ESP32 ข้ามสัญญาณ #${s.id} ${SYMBOL} (${s.action}): ${s.reason || ''}`; }
  if (ev.type === 'order') { const o = ev.order; return `📝 วาง ${sideName(o.side)} LIMIT ${SYMBOL} @ ${fx(o.price)}\nSL ${fx(o.sl)}  TP ${fx(o.tp)}  ขนาด ${o.volume / 100}`; }
  if (ev.type === 'cancel') return `🚫 ยกเลิก limit #${ev.order.id} ${SYMBOL} (${sideName(ev.order.side)} @ ${fx(ev.order.price)})`;
  if (ev.type === 'open') { const p = ev.pos; return `🟢 เปิด ${sideName(p.side)} ${SYMBOL} @ ${fx(p.open)} (${ev.via})\nSL ${fx(p.sl)}  TP ${fx(p.tp)}  ขนาด ${p.volume / 100}${p.why ? '\n— ทำไมถึงเข้า —\n' + p.why.text : ''}`; }
  if (ev.type === 'close') { const t = ev.trade; return `${t.pnl >= 0 ? '💰' : '🔻'} ปิด ${sideName(t.side)} ${SYMBOL} ${fx(t.open)} → ${fx(t.close)} [${t.reason}]\nกำไร/ขาดทุน ${t.pnl}  (${t.R}R)  ยอดเงิน ${ev.balance}${t.exitWhy ? '\n— ทำไมถึงออก —\n' + t.exitWhy : ''}`; }
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
    if (NOTIFY_URL) fetch(NOTIFY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'chartdesk-bpe-paper', symbol: ev.sym || FIRST.sym, text, event: ev }) }).catch(e => console.error('notify webhook:', e.message));
  }
}
function flush(inst, extra = []) { const ev = extra.concat(inst.engine.takeEvents()); for (const e of ev) e.sym = inst.sym; if (ev.length) { notify(ev); save(); } return ev; }

// ---- status messages (setup progress, daily summary, feed alerts, on demand) ----------------
const statusN = new Status({ minStage: ST_SETUP });
function sendDaily(dayKey, startBal) {
  try {
    const trades = allTrades().filter(t => Math.floor(t.closeT / 86400) === dayKey).map(t => ({ sym: t.sym, pnl: t.pnl, R: t.R }));
    const signals = meta.signals.filter(g => g.source === 'bpe' && Math.floor(toServer(g.recvT) / 86400) === dayKey).length;
    const text = dailyText({ date: new Date(dayKey * 86400 * 1000).toISOString().slice(0, 10), balance: acct.balance, dayStart: startBal, trades, signals, setups: meta.setupsToday || 0 });
    if (text) notify([{ type: 'status', text }]);
  } catch (e) { console.error('daily summary:', e.message); }
}
function statusData() {
  rollDay();
  return { exam: exam ? examEval() : null, balance: acct.balance, dayStart: meta.dayStartBalance, open: allPositions().length, pending: allOrders().length,
    symbols: [...insts.values()].map(i => { const s = i.bpe.status(); return { sym: i.sym, digits: i.cfg.digits, bid: i.engine.quote.bid, bias: s.bias, biasH4: s.biasH4, biasD1: s.biasD1, kz: s.kz, su: setupBrief(i), tr: tradeBrief(i) }; }) };
}
function checkFeeds() {
  if (!ST_FEED || FEED_KIND === 'none') return null;
  const msg = statusN.feeds([...feeds.keys()].map(sym => ({ sym, error: (meta.feeds[sym] || {}).lastError || '', now: now() })));
  if (msg) notify([{ type: 'status', text: msg }]);
  return msg;
}
function replyLine(token, text) {
  if (!LINE_TOKEN) return Promise.resolve(false);
  return fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + LINE_TOKEN },
    body: JSON.stringify({ replyToken: token, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  }).then(async r => { if (!r.ok) console.error('line reply:', r.status, await r.text()); return r.ok; }).catch(e => { console.error('line reply:', e.message); return false; });
}
// LINE sends chat messages here (set the webhook URL to https://<app>/line/webhook). Replies are free (they do not use the push quota).
async function lineWebhook(raw, signature) {
  if (!LINE_SECRET) return { code: 404, body: { error: 'NOT_ENABLED' } };
  const want = crypto.createHmac('sha256', LINE_SECRET).update(raw).digest(), got = Buffer.from(String(signature || ''), 'base64');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { code: 401, body: { error: 'BAD_SIGNATURE' } };
  let j; try { j = JSON.parse(raw.toString('utf8') || '{}'); } catch (e) { return { code: 400, body: { error: 'bad json' } }; }
  for (const ev of j.events || []) {
    if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !ev.replyToken) continue;
    if (LINE_TO && !(ev.source && ev.source.userId === LINE_TO)) continue;           // only the owner may ask
    const t = String(ev.message.text || '').trim().toLowerCase();
    await replyLine(ev.replyToken, /^(สถานะ|ขอสถานะ|status|พอร์ต)/.test(t) ? statusText(statusData()) : 'พิมพ์ "สถานะ" เพื่อดูสถานะของระบบตอนนี้');
  }
  return { code: 200, body: { ok: true } };
}

// ---- TradingView webhook ---------------------------------------------------------------------
const ACTIONS = { buy: 'buy', long: 'buy', sell: 'sell', short: 'sell', buy_limit: 'buy_limit', sell_limit: 'sell_limit', cancel: 'cancel', close: 'close', close_all: 'close' };
const nz = x => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

function pushSignal(f) {
  const sig = { sym: f.sym || FIRST.sym, why: f.why || null, id: meta.nextSig++, recvT: now(), action: f.action, price: nz(f.price), sl: nz(f.sl), tp: nz(f.tp), comment: String(f.comment || '').slice(0, 80), tvId: String(f.tvId || ''), barT: nz(f.barT), source: f.source || 'tv', status: 'new', reason: '', note: '' };
  meta.signals.push(sig); if (meta.signals.length > 500) meta.signals.splice(0, meta.signals.length - 500);
  return sig;
}
// One closed M5 bar (t = bar start). Fills paper orders, then lets the signal engine look at it.
function ingestBar(inst, t, o, h, l, c, isServerTime, evaluate = true) {
  const { engine, bpe, cfg } = inst, SPREAD = cfg.spread;
  const ts = isServerTime ? t : toServer(t), tu = isServerTime ? serverToUtc(t) : t;
  if (cfg.jpy && c > 0) { engine.mult = 1e5 / c; bpe.c.tickValue = bpe.c.tickSize * 1e5 / c; }        // profit of a USD/JPY lot is in yen: convert at the current rate
  engine.setQuote(c, c + SPREAD, tu);
  const ok = engine.processBar({ t: ts, o, h, l, c }, SPREAD);
  if (ok) { meta.barCount++; meta.lastBarWall = now(); }
  rollDay();
  const events = []; let made = 0;
  if (ok && BPE_ON) {
    let acts = [];
    try { acts = evaluate ? bpe.onBar(ts, o, h, l, c, { bid: c, ask: c + SPREAD }) : (bpe.addHistory(ts, o, h, l, c), []); } catch (e) { console.error('signal engine (' + inst.sym + '):', e); }
    if (evaluate) { const txt = statusN.setup(inst.sym, setupBrief(inst), cfg.digits); if (txt) { events.push({ type: 'status', text: txt }); meta.setupsToday = (meta.setupsToday || 0) + 1; } }
    for (const a of acts) {
      const comment = a.action === 'cancel' || a.action === 'close' ? a.comment : `${a.comment} ${a.model} RR${a.rr.toFixed(1)} ${a.tpName}`;
      const sig = pushSignal({ sym: inst.sym, action: a.action, price: a.price, sl: a.sl, tp: a.tp, comment, barT: tu, source: 'bpe', why: a.why });
      events.push({ type: 'signal', signal: { ...sig } }); made++;
    }
  }
  flush(inst, events);
  if (exam && ok && evaluate) examEval();
  return { ok, processed: ok ? 1 : 0, lastBarT: engine.lastBarT, signals: made, sym: inst.sym };
}

function importHistory(b) {
  const bpe = instOf(b.sym || b.symbol).bpe;
  let bars = b.bars;
  if (!Array.isArray(bars) && typeof b.csv === 'string') bars = b.csv.split('\n').map(l => l.trim().split(',').map(Number)).filter(r => r.length >= 5 && r.every(Number.isFinite));
  if (!Array.isArray(bars)) return { error: 'NO_BARS' };
  const isServer = b.serverTime === true || b.serverTime === 1; let added = 0;
  for (const r of bars) {
    const [t, o, h, l, c] = r.map(Number);
    if (!(t > 1e9 && t < 1e11 && o > 0 && h >= l && c > 0)) continue;
    if (bpe.addHistory(isServer ? t : toServer(t), o, h, l, c)) added++;
  }
  save();
  return { ok: true, added, skipped: bars.length - added, ...bpe.status().bars };
}

function tradingView(b) {
  const ev = String(b.event || (b.action ? 'signal' : '')).toLowerCase();
  if (ev === 'bar') {
    const t = nz(b.t), o = nz(b.o), h = nz(b.h), l = nz(b.l), c = nz(b.c);
    if (t > 1e11) return { error: 'TIME_IN_MS' };                       // Pine `time` is milliseconds: send time/1000
    if (!(t > 1e9 && o > 0 && h >= l && c > 0)) return { error: 'BAD_BAR' };
    return ingestBar(instOf(b.sym || b.symbol), t, o, h, l, c, b.serverTime === true || b.serverTime === 1);
  }
  if (ev === 'signal') {
    const action = ACTIONS[String(b.action || '').toLowerCase()];
    if (!action) return { error: 'BAD_ACTION' };
    const inst = instOf(b.sym || b.symbol), sig = pushSignal({ sym: inst.sym, action, price: b.price, sl: b.sl, tp: b.tp, comment: b.comment, tvId: b.id, barT: b.t, source: 'tv' });
    flush(inst, [{ type: 'signal', signal: { ...sig } }]);
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
  if (s.status === 'taken' && s.why && s.orderId) {          // hand the reason to the paper order / position so it ends up on the closed trade
    const en = instOf(s.sym).engine, tgt = en.orders.find(x => x.id === s.orderId) || en.positions.find(x => x.id === s.orderId);
    if (tgt) { tgt.why = s.why; tgt.sigId = s.id; }
  }
  rollDay();
  if (s.status === 'taken' && (s.action === 'buy' || s.action === 'sell' || s.action === 'buy_limit' || s.action === 'sell_limit')) meta.takenToday++;
  flush(instOf(s.sym), [{ type: 'decision', signal: { ...s } }]);
  return { ok: true };
}

// ---- views for the ESP32 / dashboard -------------------------------------------------------
function floatingAll() { let f = 0; for (const i of insts.values()) f += i.engine.floating(); return f; }
// the one trade (open position, else pending limit) that the ESP32 shows on the page of this instrument
function tradeBrief(i) {
  const en = i.engine, q = en.quote, p = en.positions[0], o = en.orders[0], d = i.cfg.digits;
  const r = x => Math.round(x * Math.pow(10, d + 1)) / Math.pow(10, d + 1);
  if (p) { const dir = p.side === 1 ? 1 : -1, px = dir === 1 ? q.bid : q.ask; return { k: 'pos', side: p.side, vol: p.volume, px: r(p.open), sl: r(p.sl), tp: r(p.tp), fl: Math.round(dir * (px - p.open) * p.volume / 100 * en.mult * 100) / 100 }; }
  if (o) return { k: 'ord', side: o.side, vol: o.volume, px: r(o.price), sl: r(o.sl), tp: r(o.tp), fl: 0 };
  return null;
}
// Compact view of the waiting setup for the ESP32 screen (same data as the dashboard banner; read-only, never an order).
// s: 1 sweep, 2 waiting MSS/CISD, 3 waiting FVG, 4 FVG found (x=1 model complete), 5 M4 box. e/sl/tp/rr = projected entry (an estimate unless x=1).
function setupBrief(i) {
  const p = i.bpe.preview; if (!p) return null;
  const pj = p.proj, S = { sweep: 1, mss: 2, fvgwait: 3, fvg: 4, box: 5 }[p.stage]; if (!S) return null;
  return { d: p.dir, s: S, x: p.exact ? 1 : 0, rdy: p.ready ? 1 : 0, lv: p.level || 0, ln: p.levelName || '', m: p.model || '',
    e: pj ? pj.entry : 0, sl: pj ? pj.sl : 0, tp: pj ? pj.tp : 0, rr: pj ? pj.rr : 0, ok: pj && pj.okRR ? 1 : 0 };
}
function metaView(inst) {
  rollDay();
  const en = inst.engine, st = en.state(), q = st.quote.bid ? st.quote : { bid: 0, ask: 0, t: 0 }, cf = inst.bpe.c;
  return {
    utc: now(), symbol: inst.sym, digits: inst.cfg.digits, multiplier: en.mult, minVolume: MIN_VOLUME, stepVolume: STEP_VOLUME, maxVolume: MAX_VOLUME,
    bid: q.bid, ask: q.ask, lastBarT: st.lastBarT, barAge: meta.lastBarWall ? now() - meta.lastBarWall : -1,
    balance: Math.round(acct.balance * 100) / 100, equity: Math.round((acct.balance + floatingAll()) * 100) / 100, startBalance: st.startBalance, dayStartBalance: meta.dayStartBalance, todayPnl: Math.round((acct.balance - meta.dayStartBalance) * 100) / 100,
    takenToday: meta.takenToday, positions: st.positions, orders: st.orders, tradeCount: allTrades().length,
    pending: meta.signals.filter(s => s.status === 'new').length, equityTail: allEquity().slice(-30).map(e => e[1]),
    kz: { asia: !!inst.bpe.kzA, london: !!inst.bpe.kzL, nyam: !!inst.bpe.kzAM, nypm: !!inst.bpe.kzPM, waitEquityOpen: !!cf.waitEquityOpen },
    symbols: [...insts.values()].map(i => ({ sym: i.sym, digits: i.cfg.digits, mult: i.engine.mult, bid: i.engine.quote.bid, ask: i.engine.quote.ask, lastBarT: i.engine.lastBarT, open: i.engine.positions.length, pend: i.engine.orders.length, bias: i.bpe.bias, tr: tradeBrief(i), su: setupBrief(i), kz: { asia: !!i.bpe.kzA, london: !!i.bpe.kzL, nyam: !!i.bpe.kzAM, nypm: !!i.bpe.kzPM, waitEquityOpen: !!i.bpe.c.waitEquityOpen } })),
    openAll: allPositions().length + allOrders().length, positionsAll: allPositions(), ordersAll: allOrders(),
  };
}
function allEquity() { return [].concat(...[...insts.values()].map(i => i.engine.equity)).sort((a, b) => a[0] - b[0]); }
function allStats() {
  const en = FIRST.engine, tmp = { trades: allTrades(), startBalance: en.startBalance, balance: acct.balance };
  return Object.assign(en.stats.call(tmp), { bySymbol: [...insts.values()].map(i => { const st = i.engine.stats.call({ trades: i.engine.trades, startBalance: 0, balance: i.engine.trades.reduce((a, t) => a + t.pnl, 0) }); return { sym: i.sym, trades: st.trades, winRate: st.winRate, netPnl: st.netPnl, sumR: st.sumR, profitFactor: st.profitFactor }; }) });
}
function symStatus(inst) {
  const f = feeds.get(inst.sym);
  return { enabled: BPE_ON, sym: inst.sym, feed: { kind: FEED_KIND, symbol: f ? f.symbol : '', ...(meta.feeds[inst.sym] || {}) }, ...inst.bpe.status() };
}

// ---- http --------------------------------------------------------------------------------
function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
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

const symOf = (b, url) => instOf((b && (b.sym || b.symbol)) || (url && url.searchParams.get('sym')));
const handlers = {
  'GET /api/meta': (_b, url) => metaView(symOf(null, url)),
  'GET /api/exam': () => (exam ? { ...examEval(), instruments: [...insts.values()].map(i => ({ sym: i.sym, mult: i.engine.mult, spread: i.cfg.spread })) } : { enabled: false }),
  'GET /api/state': (_b, url) => symOf(null, url).engine.state(),
  'GET /api/stats': () => allStats(),
  'GET /api/trades': (_b, url) => { const sym = url.searchParams.get('sym'); let t = allTrades(); if (sym) t = t.filter(x => x.sym === sym.toUpperCase()); return { trades: t.slice(-Number(url.searchParams.get('limit') || 200)), equity: allEquity().slice(-500) }; },
  'GET /api/signals': (_b, url) => {
    const after = url.searchParams.get('after'), sym = url.searchParams.get('sym');
    let all = meta.signals; if (sym) all = all.filter(s => s.sym === sym.toUpperCase());
    const list = after !== null ? all.filter(s => s.id > Number(after)).slice(0, 20) : all.slice(-60).reverse();
    return { signals: list };
  },
  'POST /api/signals/ack': b => ack(b),
  'POST /api/history': b => importHistory(b),
  'POST /api/order': b => { rollDay(); if (b.afterBarUtc > 0) b.afterT = toServer(Number(b.afterBarUtc)); const inst = symOf(b); const g = examGuard(inst, b); if (g) return g; const r = inst.engine.placeOrder(b); flush(inst); return r; },
  'POST /api/cancel': b => { const inst = ownerOfId(Number(b.id)) || symOf(b); const r = inst.engine.cancel(Number(b.id)); flush(inst); return r; },
  'POST /api/amend': b => { const inst = ownerOfId(Number(b.id)) || symOf(b); const r = inst.engine.amend(Number(b.id), Number(b.sl), Number(b.tp)); save(); return r; },
  'POST /api/close': b => { const inst = ownerOfId(Number(b.id)) || symOf(b); const r = inst.engine.close(Number(b.id), Number(b.price), Number(b.t), Number(b.volume), b.reason || 'time'); flush(inst); return r; },
  'GET /api/bpe': (_b, url) => ({ ...symStatus(symOf(null, url)), symbols: [...insts.values()].map(i => { const x = symStatus(i); return { sym: i.sym, kz: x.kz, bias: x.bias, biasH4: x.biasH4, biasD1: x.biasD1, state: x.state, last: x.last, ny: x.ny, feed: x.feed, bars: x.bars, kzf: { asia: !!i.bpe.kzA, london: !!i.bpe.kzL, nyam: !!i.bpe.kzAM, nypm: !!i.bpe.kzPM, wait: !!i.bpe.c.waitEquityOpen }, digits: i.cfg.digits }; }) }),
  // candles for the dashboard chart: closed bars the signal engine keeps (server time), its POI zones, open orders/positions and closed trades of this symbol
  'GET /api/chart': (_b, url) => {
    const inst = symOf(null, url), bp = inst.bpe, tfq = Number(url.searchParams.get('tf')), tf = tfq === 5 ? 5 : bp.c.poiTF;
    const n = Math.max(20, Math.min(600, Number(url.searchParams.get('n')) || (tf === 5 ? 200 : 160))), d = bp.st.tf[tf], from = Math.max(0, d.t.length - n), t0 = d.t[from] || 0;
    const bars = []; for (let i = from; i < d.t.length; i++) bars.push([d.t[i], d.o[i], d.h[i], d.l[i], d.c[i]]);
    const en = inst.engine, slim = x => ({ id: x.id, side: x.side, price: x.price || x.open, sl: x.sl, tp: x.tp, t: x.openT || x.createdT || 0, comment: x.comment || '' });
    return {
      sym: inst.sym, tf, poiTF: bp.c.poiTF, digits: inst.cfg.digits, bars, bias: bp.status().bias, state: bp.stateTxt, quote: en.quote,
      setup: bp.preview ? { ...bp.preview } : null,                  // the waiting setup, read-only (stage, zones, projected entry/SL/TP)
      poi: bp.poi.map(p => ({ top: p.top, bot: p.bot, type: p.type === 0 ? 'FVG' : 'OB' })),
      orders: en.orders.map(slim), positions: en.positions.map(x => ({ ...slim(x), price: x.open })),
      trades: en.trades.filter(x => x.closeT >= t0).map(x => ({ id: x.id, side: x.side, open: x.open, close: x.close, openT: x.openT, closeT: x.closeT, reason: x.reason, R: x.R, pnl: x.pnl, comment: x.comment || '' })),
    };
  },
  'GET /api/status-text': () => ({ text: statusText(statusData()) }),
  'POST /api/notify-status': async () => ({ line: await pushLine('[PAPER] ' + statusText(statusData())) }),
  'POST /api/notify-test': async () => ({ line: await pushLine('[PAPER] ทดสอบแจ้งเตือน LINE จาก BPE Paper Server'), telegram: !!(TG_TOKEN && TG_CHAT) }),
  'POST /api/test/now': b => { if (process.env.TEST_MODE !== '1') return { error: 'NOT_ENABLED' }; testNow = Number(b.utc) || 0; return { ok: true }; },
  'POST /api/test/failack': b => { if (process.env.TEST_MODE !== '1') return { error: 'NOT_ENABLED' }; failAck = Number(b.n) || 0; return { ok: true }; },
  'POST /api/reset': b => {
    if (b.balance > 0) for (const i of insts.values()) i.engine.startBalance = Number(b.balance);
    for (const i of insts.values()) { i.engine.reset(); i.bpe.used = []; i.bpe.s.state = 0; }
    if (exam) { exam.reset(); meta.exam = exam.serialize(); }
    meta.signals = []; meta.nextSig = 1; meta.dayKey = -1; meta.dayStartBalance = acct.balance; meta.takenToday = 0; save(); return { ok: true, balance: acct.balance };
  },
};

const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, trades: allTrades().length, lastBarT: engine.lastBarT, bars: meta.barCount, signalEngine: BPE_ON ? bpe.status().bars : 'off', feed: FEED_KIND, symbols: SYM_LIST });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, page, 'text/html; charset=utf-8');
    if (req.method === 'POST' && url.pathname === '/tv') {          // TradingView cannot send headers: key goes in ?key= or in the JSON body
      const b = await readBody(req);
      if (!authed(req, url.searchParams.get('key') || b.key)) return send(res, 401, { error: 'BAD_KEY' });
      const out = tradingView(b);
      return send(res, out.error ? 400 : 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/line/webhook') {          // LINE chat command: authenticated by the X-Line-Signature, not by the API key
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > 256 * 1024) return send(res, 400, { error: 'too large' }); chunks.push(c); }
      const out = await lineWebhook(Buffer.concat(chunks), req.headers['x-line-signature']);
      return send(res, out.code, out.body);
    }
    const h = handlers[req.method + ' ' + url.pathname];
    if (!h) return send(res, 404, { error: 'NOT_FOUND' });
    if (!authed(req)) return send(res, 401, { error: 'BAD_KEY' });
    const body = req.method === 'POST' ? await readBody(req, url.pathname === '/api/history' ? 30 * 1024 * 1024 : undefined) : {};
    const out = await h(body, url);
    if (out && out.error) return send(res, 400, out);
    return send(res, 200, out);
  } catch (e) {
    if (e.message === 'bad json' || e.message === 'too large') return send(res, 400, { error: e.message });
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

const feeds = new Map(); let feed = null;
if (FEED_KIND !== 'none') {
  let k = 0;
  for (const inst of insts.values()) {
    if (!meta.feeds[inst.sym]) meta.feeds[inst.sym] = {};
    const f = new Feed({
      kind: FEED_KIND, symbol: inst.cfg.feedSymbol, key: process.env.FEED_KEY, base: process.env.FEED_BASE_URL, warmupDays: process.env.FEED_WARMUP_DAYS,
      state: meta.feeds[inst.sym], now, save, log: m => console.log('[' + inst.sym + '] ' + m), offset: 3 * (k++),       // staggered: the free Twelve Data plan allows 8 requests a minute
      fetchJson: async (url, headers) => { const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
      history: rows => { for (const r of rows) inst.bpe.addHistory(toServer(r[0]), r[1], r[2], r[3], r[4]); },
      bar: (r, evaluate) => ingestBar(inst, r[0], r[1], r[2], r[3], r[4], false, evaluate),
    });
    inst.feed = f; feeds.set(inst.sym, f);
  }
  feed = FIRST.feed;
}
if (require.main === module) {
  server.listen(PORT, () => { console.log(`paper server on :${PORT}, symbols ${SYM_LIST.join(',')}, start balance ${engine.startBalance}, data ${DATA_FILE}, feed ${FEED_KIND}`); let d = 1000; for (const f of feeds.values()) { f.start(d); d += 4000; } setInterval(checkFeeds, 60000).unref(); if (exam) setInterval(examEval, 30000).unref(); });
}
module.exports = { server, engine, meta, bpe, feed, insts, acct, statusN, checkFeeds, sendDaily, exam, examEval, examGuard };
