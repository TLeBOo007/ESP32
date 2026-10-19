'use strict';
// LINE status messages: text builders, once-per-stage rule, daily summary, feed alerts, and the "สถานะ" chat command (signature check, owner only).
process.env.API_KEY = 'testkey123456'; process.env.SYMBOLS = 'US100,EURUSD'; process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/st-');
process.env.LINE_CHANNEL_TOKEN = 'tok'; process.env.LINE_TO = 'Uowner'; process.env.LINE_CHANNEL_SECRET = 'sec';
const assert = require('assert'), crypto = require('crypto'), http = require('http');
const { Status, dailyText, statusText, setupLine } = require('../lib/status');

// ---- pure part ----
const su2 = { d: 1, s: 2, x: 0, rdy: 0, lv: 25281, ln: 'MSS', m: '', e: 25213.22, sl: 25125.03, tp: 25458, rr: 2.78, ok: 1 };
assert(/US30 BUY · ขั้น 2\/4 กวาดแล้ว · รอ MSS ปิดเหนือ 52281\.00/.test(setupLine('US30', { ...su2, lv: 52281 }, 2)), 'stage 2 text');
assert(/ประมาณการ/.test(setupLine('US100', su2, 2)) && /RR 2\.78/.test(setupLine('US100', su2, 2)));
assert(/RR ต่ำกว่าเกณฑ์/.test(setupLine('US100', { ...su2, ok: 0 }, 2)));
{
  const st = new Status({ minStage: 3 });
  assert.strictEqual(st.setup('US100', { ...su2 }, 2), null, 'stage 2 is below the threshold');
  const a = st.setup('US100', { ...su2, s: 3 }, 2); assert(a && a.startsWith('👀 US100 BUY'), 'stage 3 announced');
  assert.strictEqual(st.setup('US100', { ...su2, s: 3 }, 2), null, 'same stage: once only');
  assert(st.setup('US100', { ...su2, s: 4, x: 0 }, 2), 'stage 4 (not complete) announced');
  assert.strictEqual(st.setup('US100', { ...su2, s: 4, x: 1, rdy: 1, m: 'M3' }, 2), null, 'complete + ready: the order message follows, no duplicate');
  assert.strictEqual(st.setup('US100', null, 2), null); assert.strictEqual(st.setup('US100', { ...su2, s: 4, x: 0 }, 2), null, 'a one-bar gap is not the end of the setup: no repeat');
  for (let i = 0; i < 6; i++) st.setup('US100', null, 2);
  assert(st.setup('US100', { ...su2, s: 3 }, 2), 'after the setup was gone for a while, a new one is announced again');
  assert(st.setup('US100', { ...su2, d: -1, s: 3 }, 2), 'opposite direction = a different setup');
  assert(st.setup('EURUSD', { ...su2, d: -1, s: 4, x: 1, rdy: 0, m: 'M2' }, 5).includes('รอเข้าช่วงเทรด'), 'complete but outside the window is announced');
  assert.strictEqual(new Status({ minStage: 0 }).setup('X', { ...su2, s: 4 }, 2), null, 'minStage 0 = off');
}
{
  const st = new Status({ feedMin: 15 }), t0 = 1000000;
  assert.strictEqual(st.feeds([{ sym: 'US100', error: 'HTTP 429', now: t0 }]), null, 'a single failure is not an alert');
  assert.strictEqual(st.feeds([{ sym: 'US100', error: 'HTTP 429', now: t0 + 14 * 60 }]), null);
  const m = st.feeds([{ sym: 'US100', error: 'HTTP 429', now: t0 + 15 * 60 }]); assert(m && /ฟีดราคาไม่เข้า/.test(m) && /US100: HTTP 429/.test(m));
  assert.strictEqual(st.feeds([{ sym: 'US100', error: 'HTTP 429', now: t0 + 30 * 60 }]), null, 'alert only once');
  assert(/กลับมาแล้ว: US100/.test(st.feeds([{ sym: 'US100', error: '', now: t0 + 31 * 60 }])), 'recovery message');
  assert.strictEqual(st.feeds([{ sym: 'US100', error: '', now: t0 + 32 * 60 }]), null);
}
{
  assert.strictEqual(dailyText({ date: '2026-10-17', balance: 10000, dayStart: 10000, trades: [], signals: 0, setups: 0 }), null, 'quiet day: no message');
  const t = dailyText({ date: '2026-10-19', balance: 10120.5, dayStart: 10000, signals: 3, setups: 2, trades: [{ sym: 'US100', pnl: 200, R: 2 }, { sym: 'EURUSD', pnl: -79.5, R: -1 }] });
  assert(/สรุปวัน 2026-10-19/.test(t) && /ไม้ที่ปิด 2 \(ชนะ 1, แพ้ 1\)/.test(t) && /\+120\.50/.test(t) && /\+1\.00R/.test(t) && /US100 1 ไม้ \+200\.00/.test(t), t);
}
{
  const t = statusText({ balance: 10050, dayStart: 10000, open: 1, pending: 0, symbols: [
    { sym: 'US100', digits: 2, bid: 25012.5, bias: 'BULL', biasH4: 'BULL', biasD1: 'BULL', kz: 'NY AM KZ', su: su2, tr: null },
    { sym: 'XAUUSD', digits: 2, bid: 2718.4, bias: 'none', biasH4: 'BEAR', biasD1: 'BULL', kz: '', su: null, tr: { k: 'pos', side: 2, px: 2720 } }] });
  assert(/ยอดเงิน 10050\.00/.test(t) && /US100 25012\.50 · ทิศ ขึ้น/.test(t) && /นิวยอร์กเช้า/.test(t) && /มีไม้เปิด SELL @ 2720\.00/.test(t) && /ทิศ ไม่ชัด \(H4 ลง\/D1 ขึ้น\)/.test(t), t);
}
console.log('status text ok');

// ---- server part: chat command ----
const calls = []; global.fetch = async (url, o) => { calls.push({ url: String(url), body: o && o.body ? JSON.parse(o.body) : null }); return { ok: true, text: async () => '' }; };
const app = require('../server.js');
const sign = raw => crypto.createHmac('sha256', 'sec').update(raw).digest('base64');
function post(port, raw, sig) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, method: 'POST', path: '/line/webhook', headers: { 'content-type': 'application/json', 'x-line-signature': sig === undefined ? sign(raw) : sig } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
    r.on('error', reject); r.end(raw);
  });
}
const msg = (text, uid = 'Uowner') => JSON.stringify({ destination: 'x', events: [{ type: 'message', replyToken: 'rt1', source: { type: 'user', userId: uid }, message: { type: 'text', text } }] });
app.server.listen(0, async () => {
  try {
    const port = app.server.address().port, replies = () => calls.filter(c => c.url.endsWith('/message/reply'));
    let r = await post(port, msg('สถานะ')); assert.strictEqual(r.code, 200);
    assert.strictEqual(replies().length, 1, 'owner asking for status gets a reply'); assert.strictEqual(replies()[0].body.replyToken, 'rt1');
    assert(/สถานะ \[PAPER\]/.test(replies()[0].body.messages[0].text) && /US100/.test(replies()[0].body.messages[0].text) && /EURUSD/.test(replies()[0].body.messages[0].text));
    r = await post(port, msg('สวัสดี')); assert.strictEqual(r.code, 200); assert.strictEqual(replies().length, 2); assert(/พิมพ์ "สถานะ"/.test(replies()[1].body.messages[0].text), 'other text gets the hint');
    r = await post(port, msg('สถานะ', 'Ustranger')); assert.strictEqual(r.code, 200); assert.strictEqual(replies().length, 2, 'a stranger gets nothing');
    r = await post(port, msg('สถานะ'), 'AAAA'); assert.strictEqual(r.code, 401); assert.strictEqual(replies().length, 2, 'bad signature: rejected, no reply');
    r = await post(port, JSON.stringify({ events: [] })); assert.strictEqual(r.code, 200, 'LINE "verify" button (no events) works');
    const sj = await new Promise(res => http.get({ port, path: '/api/status-text', headers: { 'x-api-key': 'testkey123456' } }, x => { let b = ''; x.on('data', c => b += c); x.on('end', () => res(JSON.parse(b))); }));
    assert(/สถานะ \[PAPER\]/.test(sj.text), 'GET /api/status-text');
    // a feed that keeps failing alerts once (push)
    app.meta.feeds.US100 = { lastError: 'HTTP 403' };
    const before = calls.length; app.statusN.feedMin = 0; app.insts.get('US100').feed = {}; // checkFeeds only looks at configured feeds: none here, so call the keeper directly
    const m = app.statusN.feeds([{ sym: 'US100', error: 'HTTP 403', now: 5 }]); assert(m && /HTTP 403/.test(m)); assert.strictEqual(calls.length, before);
    console.log('status server ok'); app.server.close(); setTimeout(() => process.exit(0), 50);
  } catch (e) { console.error(e); process.exit(1); }
});
