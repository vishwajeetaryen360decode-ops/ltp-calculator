'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');

const cfg = require('./config');
const auth = require('./auth');
const Hub = require('./hub');
const OiBase = require('./oibase');
const FyersFeed = require('./feeds/fyers');
const DeribitFeed = require('./feeds/deribit');
const kotak = require('./feeds/kotak');

const hub = new Hub();
const oibase = new OiBase();
const fyers = new FyersFeed(hub, oibase);
const deribit = new DeribitFeed(hub, oibase);
hub.attach('fyers', fyers);
hub.attach('crypto', deribit);

/* ---------------- HTTP ---------------- */
const app = express();
app.set('trust proxy', 1); // Render proxy ke peeche
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'], // frontend inline scripts use karta hai
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'wss:', 'https://*.supabase.co'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(express.json({ limit: '10kb' }));
app.use(rateLimit({ windowMs: 60e3, limit: 300, standardHeaders: true, legacyHeaders: false }));
const loginLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 15, standardHeaders: true, legacyHeaders: false });

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Frontend config (anon key public hoti hai; service key kabhi nahi bheji jaati)
app.get('/config.js', (req, res) => {
  const proto = req.protocol === 'https' ? 'wss' : 'ws';
  const conf = { wsUrl: `${proto}://${req.get('host')}/ws`, supabaseUrl: cfg.supabaseUrl, supabaseKey: cfg.supabaseAnonKey };
  res.set('Cache-Control', 'no-store').type('application/javascript').send(`window.APP_CONFIG=${JSON.stringify(conf)};`);
});

app.get('/api/status', auth.requireUser, async (req, res) => {
  res.json({
    ok: true,
    user: { email: req.user.email, isAdmin: req.user.isAdmin },
    fyers: fyers.status(),
    crypto: deribit.status(),
    kotak: await kotak.status(),
    clients: hub.clients.size,
  });
});

/* --- FYERS login (server side) --- */
const signState = (ts) => crypto.createHmac('sha256', cfg.appSecret).update(ts).digest('hex').slice(0, 32);
const usedStates = new Set();

app.get('/api/fyers/login-url', auth.requireAdmin, (_req, res) => {
  if (!cfg.fyers.appId || !cfg.fyers.secret) return res.status(500).json({ ok: false, error: 'FYERS_APP_ID / FYERS_SECRET server env me set nahi hain' });
  const ts = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  res.json({ ok: true, url: fyers.loginUrl(`${ts}.${signState(ts)}`) });
});

function stateOk(state) {
  const [ts, sig] = String(state || '').split('.');
  if (!ts || !sig || usedStates.has(state)) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(signState(ts));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const born = parseInt(ts.split('-')[0], 36);
  return Date.now() - born < 10 * 60e3;
}

const page = (msg, ok) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FYERS</title>` +
  `<body style="font-family:system-ui;background:#0f1115;color:#e7e9ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
  `<div style="text-align:center;padding:20px"><div style="font-size:42px">${ok ? '🟢' : '🔴'}</div><p>${msg}</p></div>`;

app.get('/api/fyers/callback', loginLimiter, async (req, res) => {
  const code = String(req.query.auth_code || '');
  const state = String(req.query.state || '');
  if (!code || !stateOk(state)) return res.status(400).send(page('Invalid / expired login link. App me dobara FYERS Login dabao.', false));
  usedStates.add(state);
  try {
    await fyers.exchange(code);
    res.send(page('FYERS connected. Ye tab band karke app pe wapas jao.', true));
  } catch (e) {
    console.error('[fyers] exchange fail:', e.message);
    res.status(400).send(page('FYERS login fail: ' + String(e.message).replace(/[<>&]/g, ''), false));
  }
});

/* --- Kotak --- */
app.post('/api/kotak/login', loginLimiter, auth.requireAdmin, async (req, res) => {
  try {
    res.json(await kotak.login(req.body));
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message).slice(0, 200) });
  }
});

/* --- admin debug --- */
app.get('/api/admin/resolve', auth.requireAdmin, async (req, res) => {
  const s = String(req.query.symbol || '').toUpperCase();
  if (!/^[A-Z0-9&-]{1,20}$/.test(s)) return res.status(400).json({ ok: false });
  try { res.json({ ok: true, ...(await fyers.resolve(s)) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/admin/samples', auth.requireAdmin, (_req, res) => res.json({ ok: true, samples: fyers.debugSamples() }));

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));
app.use((_req, res) => res.status(404).send('Not found'));

/* ---------------- WebSocket ---------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true, maxPayload: 64 * 1024 });
const perUser = new Map();

function originOk(req) {
  const o = req.headers.origin;
  if (!o) return false; // browser hamesha Origin bhejta hai
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

server.on('upgrade', async (req, socket, head) => {
  socket.on('error', () => {});
  const deny = (code, txt) => { try { socket.write(`HTTP/1.1 ${code} ${txt}\r\nConnection: close\r\n\r\n`); } catch {} socket.destroy(); };
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    if (!originOk(req)) return deny(403, 'Forbidden');
    const user = await auth.verify(url.searchParams.get('token'));
    if (!user) return deny(401, 'Unauthorized');
    if (wss.clients.size >= cfg.maxWsTotal) return deny(503, 'Busy');
    if ((perUser.get(user.id) || 0) >= cfg.maxWsPerUser) return deny(429, 'Too many connections');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
  } catch {
    deny(400, 'Bad Request');
  }
});

function onConnection(ws, user) {
  perUser.set(user.id, (perUser.get(user.id) || 0) + 1);
  const client = hub.add(ws, user);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Token expire hote hi connection band (client naye token se auto-reconnect karta hai) -> hataya gaya user 1 ghante me out
  const left = user.expMs ? user.expMs - Date.now() : 55 * 60e3;
  const killer = setTimeout(() => ws.close(4001, 'token expired'), Math.max(5000, left));

  let n = 0;
  const rl = setInterval(() => { n = 0; }, 1000);

  ws.on('message', (raw) => {
    if (++n > 20) return ws.close(1008, 'rate limit');
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m && m.t === 'sub') hub.setSubs(client, m.items);
    else if (m && m.t === 'ping') ws.send('{"t":"pong"}');
  });
  ws.on('close', () => {
    clearTimeout(killer);
    clearInterval(rl);
    perUser.set(user.id, Math.max(0, (perUser.get(user.id) || 1) - 1));
    hub.remove(client);
  });
  ws.on('error', () => {});
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000).unref();

/* ---------------- start / stop ---------------- */
(async () => {
  await oibase.load();
  await fyers.init();
  server.listen(cfg.port, '0.0.0.0', () => console.log(`[server] listening on :${cfg.port}`));
})().catch((e) => { console.error('[fatal]', e); process.exit(1); });

async function shutdown() {
  console.log('[server] shutting down');
  try { await oibase.flush(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message));
