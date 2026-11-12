'use strict';
/**
 * Kotak Neo (Trade API v2) - LOGIN + SESSION.
 *
 * Flow (Neo API docs ke hisaab se): consumer key + mobile + UCC + TOTP  ->  tradeApiLogin (view token + sid)
 *                                    view token + MPIN                  ->  tradeApiValidate (trade token + sid + baseUrl)
 * Session Supabase me save hota hai (service key + RLS ke peeche). Credentials (MPIN/TOTP) kabhi save/log nahi hote.
 *
 * !!  LIVE TICK FEED yahan NAHI hai: Kotak ka market-data WebSocket (HSM) binary protocol hai jise bina docs/network ke
 *     main verify nahi kar sakta tha. Isliye abhi NSE/BSE/MCX live data Fyers se aata hai. Interface ready hai
 *     (neeche `feedStatus`), HSM adapter baad me yahin jod sakte hain.
 */
const store = require('../store');

const BASE = 'https://mis.kotaksecurities.com';

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || j.errMsg || j.error || `Kotak HTTP ${res.status}`);
  return j;
}

function validate(b) {
  const bad = (m) => { throw new Error(m); };
  if (!b || typeof b !== 'object') bad('Invalid body');
  const { consumerKey, mobile, ucc, totp, mpin } = b;
  if (typeof consumerKey !== 'string' || consumerKey.length < 10 || consumerKey.length > 300) bad('Consumer key galat');
  if (!/^\+?\d{10,13}$/.test(String(mobile || ''))) bad('Mobile format: +919876543210');
  if (!/^[A-Za-z0-9]{3,20}$/.test(String(ucc || ''))) bad('UCC galat');
  if (!/^\d{6}$/.test(String(totp || ''))) bad('TOTP 6 digit ka hona chahiye');
  if (!/^\d{4,6}$/.test(String(mpin || ''))) bad('MPIN galat');
}

async function login(body) {
  validate(body);
  const { consumerKey, mobile, ucc, totp, mpin } = body;
  const h = { Authorization: consumerKey, 'neo-fin-key': 'neotradeapi' };

  const a = await post(`${BASE}/login/1.0/tradeApiLogin`, h, { mobileNumber: mobile, ucc, totp });
  const view = a && a.data;
  if (!view || !view.token || !view.sid) throw new Error((a && a.message) || 'Kotak login (step 1) fail');

  const b = await post(`${BASE}/login/1.0/tradeApiValidate`, { ...h, sid: view.sid, Auth: view.token }, { mpin });
  const t = b && b.data;
  if (!t || !t.token) throw new Error((b && b.message) || 'Kotak MPIN validate fail');

  await store.set('kotak', {
    sid: t.sid, token: t.token, baseUrl: t.baseUrl, hsServerId: t.hsServerId, dataCenter: t.dataCenter,
    consumerKey, savedAt: Date.now(),
  });
  return { ok: true };
}

async function status() {
  const s = await store.get('kotak');
  return {
    loggedIn: !!(s && s.token),
    ageHours: s && s.savedAt ? Math.round(((Date.now() - s.savedAt) / 3600e3) * 10) / 10 : null,
    feedStatus: 'not_implemented', // live ticks abhi Fyers se
  };
}

module.exports = { login, status };
