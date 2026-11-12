# AI ALGO LTP — WebSocket Backend (Fyers + Crypto + Kotak) + Supabase Login

```
Browser (index.html) ──WSS──►  Node server (Render)  ──WS──►  Fyers Data Socket   (NSE / BSE / MCX)
   Supabase login (JWT)            │                  └─WS──►  Deribit public WS   (BTC / ETH / SOL)
                                   └─ Supabase table: broker tokens + OI baseline
```
* Option-chain data **sirf WebSocket** se aata hai. Fyers/Deribit ke liye koi REST quote polling nahi.
  (Sirf: roz 1 baar symbol-master CSV download, aur login ke time token exchange.)
* Browser kabhi broker ko directly call nahi karta. Fyers secret / Kotak MPIN browser me store nahi hote.
* Sirf tumhare banaye hue Supabase users (max 5) andar aa sakte hain.

---
## 1) Supabase (10 min)
1. https://supabase.com → New project.
2. **SQL Editor** → `supabase/schema.sql` ka poora code paste karke Run.
3. **Authentication → Sign In / Providers → Email**: *"Allow new users to sign up"* **OFF** karo (taaki bahar ka koi account na bana sake).
4. **Authentication → Users → Add user** → apne + 4 doston ke email/password banao (Auto-confirm ON).
5. **Project Settings → API** se copy karo: `Project URL`, `anon public key`, `service_role key`.
   `service_role` **secret** hai — sirf Render env me daalna, kabhi GitHub/frontend me nahi.

## 2) FYERS app
1. https://myapi.fyers.in → Create App. **Redirect URL** abhi ke liye kuch bhi; Render URL milne ke baad ise
   `https://<tumhara-render-url>/api/fyers/callback` kar dena (EXACT yahi).
2. App ID (`XXXX-100`) aur Secret copy karo.

## 3) GitHub
```bash
cd algo-ltp
git init && git add . && git commit -m "init"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git   # PRIVATE repo banao
git push -u origin main
```
`.env` gitignore me hai — kabhi commit mat karna.

## 4) Render
1. Render → **New → Blueprint** → apna repo chuno (`render.yaml` apne aap padhega) *ya* New → Web Service
   (Build: `npm install --omit=dev`, Start: `npm start`, Health check: `/healthz`).
2. Environment variables bharo (`.env.example` dekho):
   `SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, ADMIN_EMAILS, ALLOWED_EMAILS, FYERS_APP_ID, FYERS_SECRET, PUBLIC_URL`
   (`APP_SECRET` Render khud generate karta hai.)
3. Deploy ke baad URL milega (`https://xxx.onrender.com`) → `PUBLIC_URL` me wahi daalo → FYERS app ka Redirect URL update karo.
4. **Plan: Starter lo.** Free plan 15 min idle pe sleep ho jata hai → live feed toot jayega.

## 5) Roz ka kaam
* Site kholo → Supabase email/password se login.
* **Admin** (ADMIN_EMAILS wala) subah market se pehle: `🔌 Login → FYERS Login` → FYERS pe login → "FYERS connected". Bas.
  Baaki 4 users ko kuch nahi karna; unhe live data seedha mil jata hai.
* FYERS token roz expire hota hai, isliye har trading din ek baar.
* Kotak: `🔌 Login` panel me (sirf admin) Consumer key + mobile + UCC + TOTP + MPIN.

## 6) Pehli baar chalane par verify karo (zaroori)
Mai live Fyers/Kotak/Deribit se test nahi kar paya (sandbox me internet nahi tha); logic mock data se test hua hai (`npm test`).
Pehle din ye 3 cheezein dekh lo. Site pe login karke browser console (F12) me:
```js
const H={headers:{Authorization:'Bearer '+APP_CONFIG.token}};
fetch('/api/admin/resolve?symbol=NIFTY',H).then(r=>r.json()).then(console.log)      // chain mili? expiry/lot/step
fetch('/api/admin/resolve?symbol=CRUDEOIL',H).then(r=>r.json()).then(console.log)   // MCX naam sahi resolve hua?
fetch('/api/admin/samples',H).then(r=>r.json()).then(console.log)                   // Fyers ke raw ticks (oi field hai?)
```
* `resolve` me `found:false` aaye to `unders` list me asli naam dikhega — `src/feeds/fyers.js` ke `UNDER_ALIAS` me map kar do.
* `samples` me option ticks me `oi` na ho to batao, field name badal denge.

## 7) Security jo laga hai
* Supabase JWT har WebSocket/API pe verify; `ALLOWED_EMAILS` allow-list; broker login sirf `ADMIN_EMAILS`.
* WS: Origin check, max connections (user/total), message rate-limit, 64KB payload cap, token expire hote hi disconnect
  (hataya gaya user ≤1 ghante me out).
* Helmet (CSP, HSTS…), rate-limit (global + login routes), request body 10KB cap.
* Fyers login callback signed + one-time `state` (CSRF safe). Secrets sirf env me. Broker tokens Supabase table me,
  RLS ON + koi policy nahi => browser/anon unhe padh nahi sakta.
* Kotak MPIN/TOTP kabhi store/log nahi hote.

## 8) Limitations (seedhi baat)
* **Kotak live tick feed abhi nahi hai** — Kotak ka market-data WebSocket binary (HSM) hai, jise bina docs ke verify nahi kar sakta tha.
  Login + session ready hai; NSE/BSE/MCX live data Fyers se aa raha hai.
* **OI change** = us din ka pehla dekha hua OI se difference (Fyers/Deribit feed me "previous day OI" nahi aata). Supabase me
  baseline save hota hai to restart par bhi theek rehta hai, par server din ke beech pehli baar chala to us waqt se count hoga.
* OI/Volume **lots** me bheje jate hain (OI ÷ lot size), jaise tumhare fake-data me display hota tha.
* IV Fyers ke liye server khud Black-Scholes se LTP se nikalta hai (r=6.5%, MCX r=0).
* Fyers limit 5000 symbols; scanner ON karke 100 symbols par ~4300 tickers lagte hain. `STRIKE_WINDOW` kam karke bachat kar sakte ho.
* SOL options Deribit ke `SOL_USDC` instruments se; agar Deribit unhe list na kare to SOL chain nahi dikhegi.

## Local run
```bash
npm install
cp .env.example .env     # values bharo
npm run dev              # http://localhost:8787  (FYERS redirect ke liye PUBLIC_URL/redirect URL local set karna padega)
npm test                 # offline smoke tests
```
