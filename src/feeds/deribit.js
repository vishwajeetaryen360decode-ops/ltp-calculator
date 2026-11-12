'use strict';
/**
 * Crypto option chain: Deribit PUBLIC WebSocket (login / API key ki zaroorat nahi).
 * BTC, ETH  -> inverse options (mark price underlying coin me)   [frontend crypto ke liye mark*spot karta hai]
 * SOL       -> SOL_USDC linear options (mark USDC me; hum spot se bhaag kar coin-units me badalte hain)
 * Nearest expiry ka poora chain subscribe hota hai (ticker.<instrument>.agg2).
 */
const { WebSocket } = require('ws');

const URL = 'wss://www.deribit.com/ws/api/v2';
const INDEX_CH = { BTC: 'btc_usd', ETH: 'eth_usd', SOL: 'sol_usdc' };
const MIN_LEFT_MS = 2 * 3600e3;

function stepOf(strikes, spot) {
  const near = strikes.filter((k) => Math.abs(k - spot) <= spot * 0.1);
  const arr = near.length > 3 ? near : strikes;
  const cnt = new Map();
  for (let i = 1; i < arr.length; i++) {
    const d = Math.round((arr[i] - arr[i - 1]) * 1e4) / 1e4;
    if (d > 0) cnt.set(d, (cnt.get(d) || 0) + 1);
  }
  let best = 0, bc = 0;
  for (const [d, n] of cnt) if (n > bc || (n === bc && d < best)) { best = d; bc = n; }
  return best || 1;
}

const expLabel = (ms) =>
  new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });

class DeribitFeed {
  constructor(hub, oibase) {
    this.hub = hub;
    this.oibase = oibase;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
    this.wanted = new Set();
    this.sym = new Map(); // BTC -> state
    this.byChannel = new Map(); // channel -> {s, name}
    this.backoff = 0;
    this.connected = false;
    this.timer = null;
    this.roll = setInterval(() => this._rollCheck(), 10 * 60e3);
    this.roll.unref();
  }

  status() { return { socket: this.connected, symbols: [...this.sym.keys()] }; }

  /* ----- wanted ----- */
  setWanted(list) {
    const want = new Set(list);
    for (const s of [...this.sym.keys()]) if (!want.has(s)) this._drop(s);
    for (const s of want) if (!this.sym.has(s) && INDEX_CH[s]) this._add(s);
    if (want.size && !this.ws) this._open();
    if (!want.size && this.ws) this._close();
  }

  _add(s) {
    this.sym.set(s, { s, q: new Map(), inst: new Map(), spot: 0, dirty: false, channels: [] });
    if (this.connected) this._init(s).catch((e) => console.error('[deribit] init', s, e.message));
  }

  _drop(s) {
    const st = this.sym.get(s);
    if (!st) return;
    if (this.connected && st.channels.length) this._send('public/unsubscribe', { channels: st.channels }).catch(() => {});
    st.channels.forEach((c) => this.byChannel.delete(c));
    this.sym.delete(s);
  }

  /* ----- socket ----- */
  _open() {
    if (this.ws) return;
    const ws = new WebSocket(URL, { perMessageDeflate: true });
    this.ws = ws;
    ws.on('open', async () => {
      this.connected = true;
      this.backoff = 0;
      console.log('[deribit] connected');
      this._send('public/set_heartbeat', { interval: 30 }).catch(() => {});
      for (const s of this.sym.keys()) this._init(s).catch((e) => console.error('[deribit] init', s, e.message));
    });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      this._onMsg(m);
    });
    ws.on('error', (e) => console.error('[deribit] ws error', e.message));
    ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      for (const p of this.pending.values()) p.reject(new Error('closed'));
      this.pending.clear();
      for (const st of this.sym.values()) { st.channels = []; }
      this.byChannel.clear();
      if (this.sym.size) {
        this.hub.error('crypto', 'Deribit WebSocket disconnected - reconnecting');
        const wait = Math.min(15000, 1000 * 2 ** this.backoff++);
        this.timer = setTimeout(() => this._open(), wait);
        this.timer.unref();
      }
    });
  }

  _close() {
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) { ws.removeAllListeners('close'); try { ws.close(); } catch {} }
    this.byChannel.clear();
    for (const st of this.sym.values()) st.channels = [];
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('not connected'));
      const id = this.id++;
      const to = setTimeout(() => { this.pending.delete(id); reject(new Error('rpc timeout')); }, 15000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(to); resolve(v); },
        reject: (e) => { clearTimeout(to); reject(e); },
      });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /* ----- instruments + subscribe ----- */
  async _init(s) {
    const st = this.sym.get(s);
    if (!st) return;
    const isSol = s === 'SOL';
    const r = await this._send('public/get_instruments', { currency: isSol ? 'USDC' : s, kind: 'option', expired: false });
    const prefix = isSol ? 'SOL_USDC-' : `${s}-`;
    this.setup(st, (r.result || []).filter((i) => i.instrument_name.startsWith(prefix)));
    if (!st.channels.length) return this.hub.info(`${s}: Deribit options nahi mile`);
    for (let i = 0; i < st.channels.length; i += 50) {
      await this._send('public/subscribe', { channels: st.channels.slice(i, i + 50) });
    }
  }

  // pure logic (test ke liye alag): nearest expiry chun kar channels banata hai
  setup(st, list) {
    const now = Date.now();
    const exps = [...new Set(list.map((i) => i.expiration_timestamp))].filter((e) => e > now + MIN_LEFT_MS).sort((a, b) => a - b);
    if (!exps.length) return;
    st.exp = exps[0];
    st.inst = new Map();
    st.q = new Map();
    const chans = [];
    for (const i of list) {
      if (i.expiration_timestamp !== st.exp) continue;
      st.inst.set(i.instrument_name, { K: i.strike, call: i.option_type === 'call' });
      chans.push(`ticker.${i.instrument_name}.agg2`);
    }
    st.strikesSorted = [...new Set([...st.inst.values()].map((v) => v.K))].sort((a, b) => a - b);
    const idx = `deribit_price_index.${INDEX_CH[st.s]}`;
    chans.push(idx);
    st.channels = chans.slice(0, 250);
    for (const c of st.channels) this.byChannel.set(c, { s: st.s });
  }

  _rollCheck() {
    for (const st of this.sym.values()) {
      if (st.exp && st.exp < Date.now() + MIN_LEFT_MS && this.connected) {
        const old = st.channels;
        st.channels = [];
        old.forEach((c) => this.byChannel.delete(c));
        this._send('public/unsubscribe', { channels: old }).catch(() => {});
        this._init(st.s).catch(() => {});
      }
    }
  }

  /* ----- messages ----- */
  _onMsg(m) {
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || 'rpc error')); else p.resolve(m);
      return;
    }
    if (m.method === 'heartbeat') {
      if (m.params && m.params.type === 'test_request') this._send('public/test', {}).catch(() => {});
      return;
    }
    if (m.method === 'subscription' && m.params) this.onData(m.params.channel, m.params.data);
  }

  onData(channel, d) {
    const ref = this.byChannel.get(channel);
    if (!ref || !d) return;
    const st = this.sym.get(ref.s);
    if (!st) return;
    if (channel.startsWith('deribit_price_index.')) {
      if (d.price > 0) { st.spot = d.price; st.dirty = true; }
      return;
    }
    const name = channel.split('.')[1];
    const i = st.inst.get(name);
    if (!i) return;
    if (!st.spot && d.index_price > 0) st.spot = d.index_price;
    if (d.open_interest !== undefined) this.oibase.chg(name, d.open_interest); // baseline pehle tick pe set
    st.q.set(name, {
      mark: d.mark_price,
      iv: d.mark_iv,
      oi: d.open_interest,
      vol: d.stats ? d.stats.volume : 0,
    });
    st.dirty = true;
  }

  flush() {
    const out = [];
    for (const st of this.sym.values()) {
      if (!st.dirty) continue;
      st.dirty = false;
      const b = this.book(st);
      if (b) out.push({ m: 'crypto', s: st.s, b });
    }
    return out;
  }

  book(st) {
    if (!st.spot || !st.q.size) return null;
    const linear = st.s === 'SOL';
    const strikes = {};
    let cOi = 0, pOi = 0;
    for (const [name, q] of st.q) {
      const i = st.inst.get(name);
      if (!i) continue;
      const row = strikes[i.K] || (strikes[i.K] = {});
      const mark = linear ? (q.mark || 0) / st.spot : q.mark || 0; // coin units me (frontend * spot karta hai)
      const oi = q.oi || 0;
      const chg = this.oibase.chg(name, oi);
      const iv = q.iv > 0 ? Math.round(q.iv * 100) / 100 : null;
      if (i.call) {
        Object.assign(row, { callOi: oi, callOiChg: Math.round(chg * 100) / 100, callVol: q.vol || 0, callMark: mark, callIv: iv });
        cOi += oi;
      } else {
        Object.assign(row, { putOi: oi, putOiChg: Math.round(chg * 100) / 100, putVol: q.vol || 0, putMark: mark, putIv: iv });
        pOi += oi;
      }
    }
    return {
      spot: st.spot,
      pcr: cOi > 0 ? Math.round((pOi / cOi) * 100) / 100 : 1,
      step: stepOf(st.strikesSorted, st.spot),
      lot: 1,
      expiry: expLabel(st.exp),
      strikes,
    };
  }
}

module.exports = DeribitFeed;
