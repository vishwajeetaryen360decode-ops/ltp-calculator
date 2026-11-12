'use strict';
// Offline smoke test: network / npm packages ke bina logic verify karta hai (mock SDK + mock CSV).
process.env.NODE_ENV = 'test';
const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');

/* ---- mocks ---- */
class FakeSock extends EventEmitter {
  constructor() { super(); this.subs = new Set(); this.unsubs = []; }
  subscribe(l) { l.forEach((t) => this.subs.add(t)); }
  unsubscribe(l) { l.forEach((t) => this.subs.delete(t)); this.unsubs.push(...l); }
  mode() {} connect() { setImmediate(() => this.emit('connect')); } close() {} autoreconnect() {}
}
let fake = null;
const fakeLib = { fyersDataSocket: { getInstance: () => (fake = new FakeSock()) } };
const origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === 'fyers-api-v3') return fakeLib;
  if (req === 'ws') return { WebSocket: class {}, WebSocketServer: class {} };
  if (req === '@supabase/supabase-js') return { createClient: () => ({}) };
  return origLoad.call(this, req, ...a);
};

const { impliedVol, price } = require('../src/bs');
const Hub = require('../src/hub');
const OiBase = require('../src/oibase');
const FyersFeed = require('../src/feeds/fyers');
const DeribitFeed = require('../src/feeds/deribit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

(async () => {
  /* 1. Black-Scholes IV round trip */
  const S = 25000, K = 25100, T = 7 / 365, v = 0.14;
  const p = price(S, K, T, 0.065, v, true);
  const iv = impliedVol(p, S, K, T, true, 0.065);
  assert(Math.abs(iv - 14) < 0.05, 'iv ' + iv);
  assert.strictEqual(impliedVol(0.0, S, K, T, true), null);
  ok('implied vol round-trip (14% -> ' + iv + '%)');

  /* 2. Hub subscription validation */
  const hub = new Hub();
  clearInterval(hub.timer);
  const got = [];
  const c = hub.add({ readyState: 1, bufferedAmount: 0, send: (m) => got.push(JSON.parse(m)) }, { id: 'u' });
  hub.setSubs(c, [
    { s: 'NIFTY', m: 'fyers', f: 'NSE:X' }, { s: 'btc', m: 'crypto' }, { s: 'BTC', m: 'fyers' }, // BTC fyers = reject
    { s: 'CRUDEOIL', m: 'mcx' }, { s: 'bad sym!', m: 'fyers' }, { s: 'ETH', m: 'evil' }, null, { s: 'SOL' },
  ]);
  assert.deepStrictEqual([...c.subs].sort(), ['crypto:BTC', 'fyers:NIFTY', 'mcx:CRUDEOIL']);
  ok('hub subscription sanitising');

  /* 3. Fyers: fake symbol master -> chain -> ticks -> book */
  const expiry = Math.floor(Date.now() / 1000) + 3 * 86400;
  const rows = [];
  for (let k = 24000; k <= 26000; k += 50) for (const t of ['CE', 'PE']) {
    rows.push(['1', 'NIFTY', '14', '75', '0.05', '', '', '', expiry, `NSE:NIFTY26NOV${k}${t}`, '', '', '', 'NIFTY', '', '', '', k, t].join(','));
  }
  rows.push(['9', 'NIFTY FUT', '11', '75', '0.05', '', '', '', expiry, 'NSE:NIFTY26NOVFUT', '', '', '', 'NIFTY', '', '', '', '-1', 'XX'].join(','));
  // purani expiry (ignore honi chahiye)
  rows.push(['2', 'x', '14', '75', '0.05', '', '', '', expiry - 30 * 86400, 'NSE:NIFTY26OLD25000CE', '', '', '', 'NIFTY', '', '', '', 25000, 'CE'].join(','));
  global.fetch = async () => ({ ok: true, text: async () => rows.join('\n') });

  const oibase = new OiBase();
  const hub2 = new Hub(); clearInterval(hub2.timer);
  const fy = new FyersFeed(hub2, oibase);
  fy.token = 'tok';
  fy._connect();
  await sleep(10);
  assert(fy.connected, 'socket connect');
  fy.setWanted([{ s: 'NIFTY', m: 'fyers' }]);
  await sleep(50);
  assert(fake.subs.has('NSE:NIFTY50-INDEX'), 'spot subscribed');
  fy._onMsg({ symbol: 'NSE:NIFTY50-INDEX', ltp: 25012.5 });
  const W = require('../src/config').strikeWindow;
  const optSubs = [...fake.subs].filter((t) => t.includes('NIFTY26NOV2'));
  assert.strictEqual(optSubs.length, (2 * W + 1) * 2, 'window strikes subscribed: ' + optSubs.length);
  assert(!fake.subs.has('NSE:NIFTY26OLD25000CE'), 'old expiry ignored');
  ok(`fyers: spot -> ${optSubs.length} option tickers subscribed (ATM ±${W})`);

  fy._onMsg({ symbol: 'NSE:NIFTY26NOV25000CE', ltp: 160.5, oi: 750000, vol_traded_today: 150000 });
  fy._onMsg({ symbol: 'NSE:NIFTY26NOV25000PE', ltp: 110.2, oi: 1500000, vol_traded_today: 300000 });
  fy._onMsg({ symbol: 'NSE:NIFTY26NOV25000CE', ltp: 161.0, oi: 825000 });
  const out = fy.flush();
  assert.strictEqual(out.length, 1);
  const b = out[0].b;
  assert.strictEqual(out[0].s, 'NIFTY');
  assert.strictEqual(b.spot, 25012.5);
  assert.strictEqual(b.step, 50);
  const r = b.strikes[25000];
  assert.strictEqual(r.callOi, 11000); // 825000 / 75
  assert.strictEqual(r.callOiChg, 1000); // (825000-750000)/75
  assert.strictEqual(r.putOi, 20000);
  assert.strictEqual(r.callMark, 161);
  assert(r.callIv > 5 && r.callIv < 60, 'callIv ' + r.callIv);
  assert.strictEqual(b.pcr, 1.82);
  ok(`fyers: book shape ok (spot ${b.spot}, step ${b.step}, pcr ${b.pcr}, callIv ${r.callIv}%, expiry ${b.expiry})`);

  // spot door jaye -> window re-center
  fy._onMsg({ symbol: 'NSE:NIFTY50-INDEX', ltp: 25500 });
  assert(fake.subs.has('NSE:NIFTY26NOV25500CE') && fake.subs.has('NSE:NIFTY26NOV25800CE'), 'recentered up');
  assert(fake.unsubs.length > 0, 'far strikes unsubscribed');
  ok('fyers: ATM shift pe window re-center + purane strikes unsubscribe');

  // symbol hatne par sab unsubscribe
  fy.setWanted([]);
  assert.strictEqual([...fake.subs].filter((t) => t.includes('NIFTY')).length, 0);
  ok('fyers: symbol drop -> saare tickers unsubscribe');

  /* 4. Deribit: instruments -> ticks -> book */
  const hub3 = new Hub(); clearInterval(hub3.timer);
  const db = new DeribitFeed(hub3, new OiBase());
  clearInterval(db.roll);
  const exp = Date.now() + 5 * 86400e3;
  const inst = [];
  for (let k = 70000; k <= 90000; k += 1000) for (const t of ['call', 'put']) {
    inst.push({ instrument_name: `BTC-27MAR26-${k}-${t === 'call' ? 'C' : 'P'}`, expiration_timestamp: exp, strike: k, option_type: t });
  }
  inst.push({ instrument_name: 'BTC-OLD-1-C', expiration_timestamp: Date.now() + 1000, strike: 1, option_type: 'call' });
  db.sym.set('BTC', { s: 'BTC', q: new Map(), inst: new Map(), spot: 0, dirty: false, channels: [] });
  const st = db.sym.get('BTC');
  db.setup(st, inst);
  assert.strictEqual(st.inst.size, 42);
  assert(st.channels.includes('deribit_price_index.btc_usd'));
  db.onData('deribit_price_index.btc_usd', { price: 80123.4 });
  db.onData('ticker.BTC-27MAR26-80000-C.agg2', { mark_price: 0.0412, mark_iv: 51.234, open_interest: 1234.5, stats: { volume: 88 } });
  db.onData('ticker.BTC-27MAR26-80000-P.agg2', { mark_price: 0.0301, mark_iv: 52.1, open_interest: 2000, stats: { volume: 40 } });
  const o = db.flush();
  assert.strictEqual(o.length, 1);
  const bb = o[0].b;
  assert.strictEqual(bb.step, 1000);
  assert.strictEqual(bb.strikes[80000].callMark, 0.0412);
  assert.strictEqual(bb.strikes[80000].putOi, 2000);
  assert.strictEqual(bb.strikes[80000].callIv, 51.23);
  assert.strictEqual(o[0].m, 'crypto');
  ok(`deribit: instruments -> book ok (spot ${bb.spot}, step ${bb.step}, pcr ${bb.pcr})`);

  console.log(`\nAll ${passed} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.message); console.error(e.stack); process.exit(1); });
