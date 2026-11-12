'use strict';
// Supabase JWT verification + allow-list + admin check.
const crypto = require('crypto');
const cfg = require('./config');

let anon = null;
function client() {
  if (!anon) {
    const { createClient } = require('@supabase/supabase-js');
    anon = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return anon;
}

const cache = new Map(); // sha256(token) -> {user, until}
const TTL = 60 * 1000;

function jwtExpMs(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    return p.exp ? p.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function verify(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  const h = crypto.createHash('sha256').update(token).digest('hex');
  const hit = cache.get(h);
  if (hit && hit.until > Date.now()) return hit.user;

  const { data, error } = await client().auth.getUser(token);
  if (error || !data || !data.user) return null;
  const email = String(data.user.email || '').toLowerCase();
  if (!email) return null;
  if (cfg.allowedEmails.size && !cfg.allowedEmails.has(email)) return null;

  const user = { id: data.user.id, email, isAdmin: cfg.adminEmails.has(email), expMs: jwtExpMs(token) };
  if (cache.size > 200) cache.clear();
  cache.set(h, { user, until: Date.now() + TTL });
  return user;
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

async function requireUser(req, res, next) {
  try {
    const user = await verify(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'Login required' });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ ok: false, error: 'Login required' });
  }
}

function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ ok: false, error: 'Admin only' });
    next();
  });
}

module.exports = { verify, requireUser, requireAdmin };
