'use strict';
/**
 * FYERS feed (NSE / BSE index + stocks + MCX)
 *
 * - Login: server-side (admin ek baar roz subah login karta hai). Token Supabase me save hota hai.
 * - Option chain: Fyers ki public symbol-master CSV (din me 1 baar download) se strikes/tickers nikalte hain.
 * - Live data: Fyers Data WebSocket (official `fyers-api-v3` SDK). Koi REST quote polling NAHI.
 * - Har symbol ke ATM +/- STRIKE_WINDOW strikes subscribe hote hain; spot hilne par window sarakti hai.
 */
const crypto = require('crypto');
const cfg = require('../config');
const store = require('../store');
const { impliedVol } = require('../bs');

const INDEX_MAP = {
  NIFTY: 'NSE:NIFTY50-INDEX',
  BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
  FINNIFTY: 'NSE:FINNIFTY-INDEX',
  MIDCAPNIFTY: 'NSE:MIDCPNIFTY-INDEX',
  SENSEX: 'BSE:SENSEX-INDEX',
  BANKEX: 'BSE:BANKEX-INDEX',
};
const UNDER_ALIAS = { MIDCAPNIFTY: 'MIDCPNIFTY' };
const BSE_UNDER = new Set(['SENSEX', 'BANKEX']);
const SEG_URL = {
  NSE_FO: 'https://public.fyers.in/sym_details/NSE_FO.csv',
  BSE_FO: 'https://public.fyers.in/sym_details/BSE_FO.csv',
  MCX_COM: 'https://public.fyers.in/sym_details/MCX_COM.csv',
};
const MAX_SUBS = 4500; // Fyers limit 5000 symbols / connection
const GRACE_MS = 3600e3; // expiry ke 1 ghante baad agle expiry pe shift

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

/* ---------------- symbol master ---------------- */

/**
 * Fyers symbol master columns (docs): 0 Fytoken, 1 Symbol details, 2 Instrument type, 3 Lot size, 4 Tick,
 * 5 ISIN, 6 Session, 7 Last update, 8 Expiry (epoch sec), 9 Symbol ticker, 10 Exchange, 11 Segment,
 * 12 Scrip code, 13 Underlying scrip code, 14 Underlying fytoken, 15-16 reserved, 17 Strike, 18 Option type (CE/PE/XX)
 */
function parseMaster(text) {
  const byUnder = new Map();
  let rows = 0;
  for (const line of text.split('\n')) {
    const c = line.split(',');
    if (c.length < 19) continue;
    const ticker = (c[9] || '').trim();
    const expiry = Number(c[8]);
    if (!ticker || !expiry) continue;
    const type = (c[18] || '').trim();
    let under = (c[13] || '').trim();
    if (!under || /^\d+$/.test(under)) {
      const m = /^[A-Z]+:([A-Z&-]+?)(?=\d)/.exec(ticker);
      under = m ? m[1] : '';
    }
    if (!under) continue;
    let u = byUnder.get(under);
    if (!u) byUnder.set(under, (u = { expiries: new Map(), futs: [] }));
    if (type === 'CE' || type === 'PE') {
      const strike = Number(c[17]);
      if (!(strike > 0)) continue;
      let e = u.expiries.get(expiry);
      if (!e) u.expiries.set(expiry, (e = { lot: Number(c[3]) || 1, strikes: new Map() }));
      let pair = e.strikes.get(strike);
      if (!pair) e.strikes.set(strike, (pair = {}));
      pair[type === 'CE' ? 'ce' : 'pe'] = ticker;
      rows++;
    } else if (/FUT$/.test(ticker)) {
      u.futs.push({ expiry, ticker });
    }
  }
  for (const u of byUnder.values()) u.futs.sort((a, b) => a.expiry - b.expiry);
  return { at: Date.now(), byUnder, rows };
}

const masters = {};
async function loadMaster(seg) {
  const m = masters[seg];
  if (m && m.data && Date.now() - m.data.at < 12 * 3600e3) return m.data;
  if (m && m.pending) return m.pending;
  const pending = (async () => {
    const res = await fetch(SEG_URL[seg], { signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw new Error(`symbol master ${seg} HTTP ${res.status}`);
    const data = parseMaster(await res.text());
    if (!data.rows && !cfg.isTest) throw new Error(`symbol master ${seg} empty/format changed`);
    masters[seg] = { data };
    return data;
  })();
  masters[seg] = { ...(m || {}), pending };
  try { return await pending; } finally { if (masters[seg]) delete masters[seg].pending; }
}

function pickChain(master, under) {
  const u = master.byUnder.get(under);
  if (!u) return null;
  const now = Date.now();
  const exps = [...u.expiries.keys()].filter((e) => e * 1000 + GRACE_MS > now).sort((a, b) => a - b);
  if (!exps.length) return null;
  const exp = exps[0];
  const e = u.expiries.get(exp);
  const strikes = [...e.strikes.keys()].sort((a, b) => a - b);
  const futs = u.futs.filter((f) => f.expiry * 1000 + GRACE_MS > now);
  return { exp, lot: e.lot, strikes, map: e.strikes, futs };
}

// ATM ke aas-paas ke strikes ka sabse common gap
function stepOf(strikes, spot) {
  const near = strikes.filter((k) => Math.abs(k - spot) <= spot * 0.05);
  const arr = near.length > 3 ? near : strikes;
  const cnt = new Map();
  for (let i = 1; i < arr.length; i++) {
    const d = Math.round((arr[i] - arr[i - 1]) * 100) / 100;
    if (d > 0) cnt.set(d, (cnt.get(d) || 0) + 1);
  }
  let best = 0, bc = 0;
  for (const [d, n] of cnt) if (n > bc || (n === bc && d < best)) { best = d; bc = n; }
  return best || 1;
}

const expLabel = (epoch) =>
  new Date(epoch * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' });

/* ---------------- feed ---------------- */

class FyersFeed {
  constructor(hub, oibase) {
    this.hub = hub;
    this.oibase = oibase;
    this.token = null;
    this.savedAt = 0;
    this.sock = null;
    this.connected = false;
    this.sym = new Map(); // symbol -> state
    this.tmap = new Map(); // ticker -> {s, kind:'spot'|'ce'|'pe', K}
    this.wanted = new Set(); // tickers jo subscribe hone chahiye
    this.samples = [];
    this.seenOpt = false;
    this.seenOi = false;
    this.oiWarned = false;
    this.connectedAt = 0;
  }

  async init() {
    const t = await store.get('fyers');
    if (t && t.accessToken) {
      this.token = t.accessToken;
      this.savedAt = t.savedAt || 0;
      console.log('[fyers] saved token mila (age %sh)', ((Date.now() - this.savedAt) / 3600e3).toFixed(1));
      this._connect();
    } else {
      console.log('[fyers] token nahi hai - admin ko FYERS login karna hoga');
    }
  }

  status() {
    return {
      hasToken: !!this.token,
      ageHours: this.token ? Math.round(((Date.now() - this.savedAt) / 3600e3) * 10) / 10 : null,
      socket: this.connected,
      symbols: this.sym.size,
      subscriptions: this.wanted.size,
      lastError: this.lastError || null,
    };
  }

  /* ----- login ----- */
  loginUrl(state) {
    const q = new URLSearchParams({
      client_id: cfg.fyers.appId,
      redirect_uri: cfg.fyers.redirectUrl,
      response_type: 'code',
      state,
    });
    return `https://api-t1.fyers.in/api/v3/generate-authcode?${q}`;
  }

  async exchange(authCode) {
    const appIdHash = crypto.createHash('sha256').update(`${cfg.fyers.appId}:${cfg.fyers.secret}`).digest('hex');
    const res = await fetch('https://api-t1.fyers.in/api/v3/validate-authcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code: authCode }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(j.message || `FYERS HTTP ${res.status}`);
    await this.setToken(j.access_token);
  }

  async setToken(token) {
    const changed = this.token && this.token !== token;
    this.token = token;
    this.savedAt = Date.now();
    this.lastError = null;
    await store.set('fyers', { accessToken: token, savedAt: this.savedAt });
    this._connect(!!changed);
  }

  /* ----- socket ----- */
  _closeSock() {
    const s = this.sock;
    if (!s) return;
    try { if (typeof s.removeAllListeners === 'function') s.removeAllListeners(); } catch {}
    try { s.close(); } catch {}
    this.connected = false;
  }

  _connect(tokenChanged = false) {
    if (!this.token) return;
    const prev = this.sock;
    this._closeSock();
    let lib;
    try { lib = require('fyers-api-v3'); } catch (e) {
      this.lastError = 'fyers-api-v3 package install nahi hua';
      this.hub.error('fyers', this.lastError);
      return;
    }
    const sock = lib.fyersDataSocket.getInstance(`${cfg.fyers.appId}:${this.token}`, '', false);
    if (tokenChanged && prev && prev === sock) {
      // SDK singleton purane token ke saath chipka hai -> process restart (Render auto-restart karega, naya token store se load hoga)
      console.warn('[fyers] SDK singleton stale token - restarting process');
      setTimeout(() => process.exit(0), 500);
      return;
    }
    this.sock = sock;
    sock.on('connect', () => {
      this.connected = true;
      this.connectedAt = Date.now();
      this.lastError = null;
      console.log('[fyers] data socket connected');
      this._chunk('subscribe', [...this.wanted]);
      try { if (sock.FullMode !== undefined) sock.mode(sock.FullMode); } catch {}
    });
    sock.on('message', (m) => this._onMsg(m));
    sock.on('error', (e) => {
      this.connected = false;
      this.lastError = String((e && e.message) || (typeof e === 'string' ? e : JSON.stringify(e)));
      this.hub.error('fyers', `FYERS socket: ${this.lastError.slice(0, 120)}`);
    });
    sock.on('close', () => { this.connected = false; });
    try { sock.autoreconnect(8); } catch {}
    sock.connect();
  }

  _chunk(fn, list) {
    if (!this.sock || !this.connected || !list.length) return;
    for (let i = 0; i < list.length; i += 200) {
      try { this.sock[fn](list.slice(i, i + 200)); } catch (e) { console.error('[fyers]', fn, e.message); }
    }
  }

  _want(list) {
    const add = [];
    for (const t of list) {
      if (this.wanted.has(t)) continue;
      if (this.wanted.size >= MAX_SUBS) { this.hub.info('FYERS subscription limit full (4500)'); break; }
      this.wanted.add(t);
      add.push(t);
    }
    this._chunk('subscribe', add);
  }

  _unwant(list) {
    const rem = list.filter((t) => this.wanted.delete(t));
    this._chunk('unsubscribe', rem);
  }

  /* ----- wanted symbols (hub se) ----- */
  setWanted(items) {
    const want = new Map(items.map((i) => [i.s, i.m]));
    for (const [s, st] of this.sym) {
      if (!want.has(s)) this._drop(st);
    }
    for (const [s, m] of want) {
      if (!this.sym.has(s)) {
        const st = { s, m, active: new Map(), q: new Map(), dirty: false, spot: 0 };
        this.sym.set(s, st);
        this._initSymbol(st);
      }
    }
  }

  _drop(st) {
    const rm = [];
    for (const [t, v] of this.tmap) if (v.s === st.s) rm.push(t);
    rm.forEach((t) => this.tmap.delete(t));
    this._unwant(rm);
    this.sym.delete(st.s);
    st.dead = true;
  }

  async _initSymbol(st) {
    try {
      const seg = st.m === 'mcx' ? 'MCX_COM' : BSE_UNDER.has(st.s) ? 'BSE_FO' : 'NSE_FO';
      const master = await loadMaster(seg);
      if (st.dead) return;
      const ch = pickChain(master, UNDER_ALIAS[st.s] || st.s);
      if (!ch) { this.hub.info(`${st.s}: F&O option chain nahi mili`); st.failed = true; return; }
      st.chain = ch;
      st.rate = st.m === 'mcx' ? 0 : 0.065;
      if (st.m === 'mcx') {
        if (!ch.futs[0]) { this.hub.info(`${st.s}: MCX future ticker nahi mila`); st.failed = true; return; }
        st.spotTicker = ch.futs[0].ticker;
      } else {
        st.spotTicker = INDEX_MAP[st.s] || `NSE:${st.s}-EQ`;
      }
      this.tmap.set(st.spotTicker, { s: st.s, kind: 'spot' });
      this._want([st.spotTicker]);
    } catch (e) {
      console.error('[fyers] initSymbol', st.s, e.message);
      this.hub.info(`${st.s}: setup fail (${e.message})`);
      setTimeout(() => { if (!st.dead) this._initSymbol(st); }, 60000).unref();
    }
  }

  /* ATM badalne par strike window re-center */
  _recenter(st) {
    const ks = st.chain.strikes;
    if (!ks.length || !st.spot) return;
    let idx = 0, best = Infinity;
    for (let i = 0; i < ks.length; i++) {
      const d = Math.abs(ks[i] - st.spot);
      if (d < best) { best = d; idx = i; }
    }
    if (st.centerIdx !== undefined && Math.abs(idx - st.centerIdx) < 3) return;
    st.centerIdx = idx;
    const W = cfg.strikeWindow;
    const add = [];
    for (let i = Math.max(0, idx - W); i <= Math.min(ks.length - 1, idx + W); i++) {
      const k = ks[i];
      if (st.active.has(k)) continue;
      const pair = st.chain.map.get(k);
      st.active.set(k, pair);
      if (pair.ce) { this.tmap.set(pair.ce, { s: st.s, kind: 'ce', K: k }); add.push(pair.ce); }
      if (pair.pe) { this.tmap.set(pair.pe, { s: st.s, kind: 'pe', K: k }); add.push(pair.pe); }
    }
    const rem = [];
    for (const [k, pair] of [...st.active]) {
      const i = ks.indexOf(k);
      if (Math.abs(i - idx) > W + 5) {
        st.active.delete(k);
        for (const t of [pair.ce, pair.pe]) {
          if (!t) continue;
          this.tmap.delete(t);
          st.q.delete(t);
          rem.push(t);
        }
      }
    }
    this._want(add);
    this._unwant(rem);
  }

  /* ----- tick ----- */
  _onMsg(m) {
    if (Array.isArray(m)) return m.forEach((x) => this._onMsg(x));
    if (!m || typeof m !== 'object' || !m.symbol) return;
    const t = this.tmap.get(m.symbol);
    if (!t) return;
    const st = this.sym.get(t.s);
    if (!st) return;
    if (this.samples.length < 8 || (t.kind !== 'spot' && this.samples.length < 12)) {
      this.samples.push({ kind: t.kind, raw: JSON.stringify(m).slice(0, 600) });
    }
    const ltp = num(m.ltp);
    if (t.kind === 'spot') {
      if (ltp > 0) { st.spot = ltp; st.dirty = true; this._recenter(st); }
      return;
    }
    const cur = st.q.get(m.symbol) || {};
    if (ltp !== undefined) cur.ltp = ltp;
    const oi = num(m.oi !== undefined ? m.oi : m.OI !== undefined ? m.OI : m.open_interest);
    if (oi !== undefined) { cur.oi = oi; this.seenOi = true; this.oibase.chg(m.symbol, oi); } // baseline pehle tick pe set
    const vol = num(m.vol_traded_today !== undefined ? m.vol_traded_today : m.volume);
    if (vol !== undefined) cur.vol = vol;
    st.q.set(m.symbol, cur);
    st.dirty = true;
    this.seenOpt = true;
  }

  /* ----- book (frontend ka format) ----- */
  _book(st) {
    if (!st.chain || !st.spot || !st.active.size) return null;
    const lot = st.chain.lot || 1;
    const T = Math.max((st.chain.exp * 1000 - Date.now()) / 31536e6, 1 / 8760);
    const strikes = {};
    let cOi = 0, pOi = 0, any = false;
    for (const [K, pair] of st.active) {
      const c = pair.ce ? st.q.get(pair.ce) : null;
      const p = pair.pe ? st.q.get(pair.pe) : null;
      if (!c && !p) continue;
      any = true;
      const row = {};
      if (c) {
        const oi = c.oi || 0;
        row.callOi = Math.round(oi / lot);
        row.callOiChg = Math.round(this.oibase.chg(pair.ce, oi) / lot);
        row.callVol = Math.round((c.vol || 0) / lot);
        row.callMark = c.ltp || 0;
        row.callIv = impliedVol(c.ltp, st.spot, K, T, true, st.rate);
        cOi += row.callOi;
      }
      if (p) {
        const oi = p.oi || 0;
        row.putOi = Math.round(oi / lot);
        row.putOiChg = Math.round(this.oibase.chg(pair.pe, oi) / lot);
        row.putVol = Math.round((p.vol || 0) / lot);
        row.putMark = p.ltp || 0;
        row.putIv = impliedVol(p.ltp, st.spot, K, T, false, st.rate);
        pOi += row.putOi;
      }
      strikes[K] = row;
    }
    if (!any) return null;
    return {
      spot: st.spot,
      pcr: cOi > 0 ? Math.round((pOi / cOi) * 100) / 100 : 1,
      step: stepOf(st.chain.strikes, st.spot),
      lot,
      expiry: expLabel(st.chain.exp),
      strikes,
    };
  }

  flush() {
    const out = [];
    for (const st of this.sym.values()) {
      if (!st.dirty || st.dead) continue;
      st.dirty = false;
      const b = this._book(st);
      if (b) out.push({ m: st.m, s: st.s, b });
    }
    if (!this.oiWarned && this.seenOpt && !this.seenOi && this.connectedAt && Date.now() - this.connectedAt > 60000) {
      this.oiWarned = true;
      this.hub.info('FYERS option ticks me OI field nahi aa raha - /api/admin/samples check karo');
      console.warn('[fyers] option ticks aa rahe hain par OI field nahi mila. Raw sample: /api/admin/samples');
    }
    return out;
  }

  /* ----- debug (admin) ----- */
  async resolve(symbol) {
    const mcx = ['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATURALGASM', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM'].includes(symbol);
    const seg = mcx ? 'MCX_COM' : BSE_UNDER.has(symbol) ? 'BSE_FO' : 'NSE_FO';
    const master = await loadMaster(seg);
    const ch = pickChain(master, UNDER_ALIAS[symbol] || symbol);
    if (!ch) return { found: false, seg, hint: 'underlying naam master me nahi mila', unders: [...master.byUnder.keys()].slice(0, 40) };
    return {
      found: true, seg, expiry: expLabel(ch.exp), lot: ch.lot, strikes: ch.strikes.length,
      step: stepOf(ch.strikes, ch.strikes[Math.floor(ch.strikes.length / 2)]),
      sampleCE: ch.map.get(ch.strikes[Math.floor(ch.strikes.length / 2)]),
      nearestFuture: ch.futs[0] || null,
    };
  }
  debugSamples() { return this.samples; }
}

module.exports = FyersFeed;
module.exports._test = { parseMaster, pickChain, stepOf, loadMaster };
