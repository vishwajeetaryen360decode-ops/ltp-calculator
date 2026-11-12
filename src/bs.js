'use strict';
// Black-Scholes implied volatility (percent me). Fyers feed me IV nahi aata, to LTP se nikalte hain.
function ncdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + s * y);
}

function price(S, K, T, r, v, call) {
  const sq = v * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (v * v) / 2) * T) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-r * T);
  return call ? S * ncdf(d1) - K * df * ncdf(d2) : K * df * ncdf(-d2) - S * ncdf(-d1);
}

function impliedVol(mkt, S, K, T, call, r = 0.065) {
  if (!(mkt > 0 && S > 0 && K > 0 && T > 0)) return null;
  const df = Math.exp(-r * T);
  const intrinsic = call ? Math.max(0, S - K * df) : Math.max(0, K * df - S);
  if (mkt <= intrinsic + 1e-9) return null;
  let lo = 0.01, hi = 5;
  if (price(S, K, T, r, hi, call) < mkt) return null;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (price(S, K, T, r, mid, call) > mkt) hi = mid; else lo = mid;
  }
  return Math.round(((lo + hi) / 2) * 10000) / 100;
}

module.exports = { impliedVol, price };
