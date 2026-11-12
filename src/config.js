'use strict';
const env = process.env;
const isTest = env.NODE_ENV === 'test';

const must = (k) => {
  if (!env[k] && !isTest) throw new Error(`Environment variable missing: ${k}`);
  return env[k] || '';
};
const list = (k) =>
  new Set((env[k] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const port = Number(env.PORT || 8787);
const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, '');

const cfg = {
  isTest,
  port,
  publicUrl,
  appSecret: must('APP_SECRET'),
  supabaseUrl: must('SUPABASE_URL'),
  supabaseAnonKey: must('SUPABASE_ANON_KEY'),
  supabaseServiceKey: env.SUPABASE_SERVICE_KEY || '',
  adminEmails: list('ADMIN_EMAILS'),
  allowedEmails: list('ALLOWED_EMAILS'),
  maxWsPerUser: Number(env.MAX_WS_PER_USER || 3),
  maxWsTotal: Number(env.MAX_WS_TOTAL || 15),
  strikeWindow: Math.min(25, Math.max(8, Number(env.STRIKE_WINDOW || 12))),
  fyers: {
    appId: env.FYERS_APP_ID || '',
    secret: env.FYERS_SECRET || '',
    redirectUrl: env.FYERS_REDIRECT_URL || `${publicUrl}/api/fyers/callback`,
  },
};

if (!isTest && cfg.adminEmails.size === 0) {
  throw new Error('ADMIN_EMAILS set karo (broker login sirf admin kar sakta hai).');
}
if (!isTest && cfg.appSecret.length < 24) {
  throw new Error('APP_SECRET kam se kam 24 characters ka hona chahiye.');
}
module.exports = cfg;
