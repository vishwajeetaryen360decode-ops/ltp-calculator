'use strict';
// Broker tokens ka storage. Supabase table `broker_sessions` (service key se) -> restart ke baad bhi bacha rehta hai.
const cfg = require('./config');

let sb = null;
if (cfg.supabaseServiceKey && cfg.supabaseUrl) {
  const { createClient } = require('@supabase/supabase-js');
  sb = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
} else if (!cfg.isTest) {
  console.warn('[store] SUPABASE_SERVICE_KEY nahi mila -> tokens sirf memory me rahenge (restart pe login dobara).');
}
const mem = new Map();

async function get(key) {
  if (!sb) return mem.get(key) || null;
  try {
    const { data, error } = await sb.from('broker_sessions').select('data').eq('broker', key).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? data.data : mem.get(key) || null;
  } catch (e) {
    console.error('[store.get]', key, e.message);
    return mem.get(key) || null;
  }
}

async function set(key, value) {
  mem.set(key, value);
  if (!sb) return;
  try {
    const { error } = await sb
      .from('broker_sessions')
      .upsert({ broker: key, data: value, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error('[store.set]', key, e.message);
  }
}

module.exports = { get, set };
