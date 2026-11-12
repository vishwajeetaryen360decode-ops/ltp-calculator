'use strict';
// Hub: browser clients <-> feeds. Har client apni subscription bhejta hai, hub sabka union nikal kar feeds ko batata hai.
// Data sirf WebSocket se jata hai; koi REST polling nahi.
const SYM_RE = /^[A-Z0-9&-]{1,20}$/;
const CRYPTO = new Set(['BTC', 'ETH', 'SOL']);
const MARKETS = new Set(['crypto', 'fyers', 'mcx']);

class Hub {
  constructor() {
    this.clients = new Set();
    this.latest = new Map(); // "m:s" -> last JSON message string
    this.feeds = {};
    this.lastNotice = new Map();
    this.timer = setInterval(() => this.flush(), 1000);
  }

  attach(name, feed) { this.feeds[name] = feed; }

  add(ws, user) {
    const c = { ws, user, subs: new Set() };
    this.clients.add(c);
    return c;
  }

  remove(c) {
    this.clients.delete(c);
    this.recompute();
  }

  setSubs(c, items) {
    const subs = new Set();
    if (Array.isArray(items)) {
      for (const it of items.slice(0, 150)) {
        if (!it || typeof it.s !== 'string' || typeof it.m !== 'string') continue;
        const s = it.s.toUpperCase();
        const m = it.m;
        if (!SYM_RE.test(s) || !MARKETS.has(m)) continue;
        if (m === 'crypto' && !CRYPTO.has(s)) continue;
        if (m !== 'crypto' && CRYPTO.has(s)) continue;
        subs.add(`${m}:${s}`);
      }
    }
    c.subs = subs;
    for (const k of subs) {
      const msg = this.latest.get(k);
      if (msg) this.send(c, msg);
    }
    this.recompute();
  }

  recompute() {
    const w = { crypto: new Set(), fyers: new Set(), mcx: new Set() };
    for (const c of this.clients) {
      for (const k of c.subs) {
        const i = k.indexOf(':');
        w[k.slice(0, i)].add(k.slice(i + 1));
      }
    }
    if (this.feeds.crypto) this.feeds.crypto.setWanted([...w.crypto]);
    if (this.feeds.fyers) {
      this.feeds.fyers.setWanted(
        [...w.fyers].map((s) => ({ s, m: 'fyers' })).concat([...w.mcx].map((s) => ({ s, m: 'mcx' })))
      );
    }
  }

  send(c, msg) {
    const ws = c.ws;
    if (ws.readyState === 1 && ws.bufferedAmount < 1e6) ws.send(msg);
  }

  deliver(m, s, b) {
    const key = `${m}:${s}`;
    const msg = JSON.stringify({ t: 'book', m, s, b });
    this.latest.set(key, msg);
    for (const c of this.clients) if (c.subs.has(key)) this.send(c, msg);
  }

  flush() {
    for (const name of Object.keys(this.feeds)) {
      let out = [];
      try { out = this.feeds[name].flush() || []; } catch (e) { console.error(`[hub] ${name}.flush`, e.message); }
      for (const r of out) this.deliver(r.m, r.s, r.b);
    }
  }

  // Frontend ka {t:'err'} status badge me dikhta hai; {t:'info'} ignore hota hai.
  broadcast(type, msg) {
    const k = type + msg;
    const now = Date.now();
    if (now - (this.lastNotice.get(k) || 0) < 30000) return;
    this.lastNotice.set(k, now);
    const payload = JSON.stringify({ t: type, msg });
    for (const c of this.clients) this.send(c, payload);
  }
  error(_feed, msg) { this.broadcast('err', msg); }
  info(msg) { this.broadcast('info', msg); }
}

module.exports = Hub;
