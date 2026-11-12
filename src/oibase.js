'use strict';
// "OI change" ke liye din ka pehla dekha hua OI baseline maante hain; Supabase me save hota hai (restart safe).
const store = require('./store');

const istDay = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

class OiBase {
  constructor() {
    this.day = istDay();
    this.map = new Map();
    this.dirty = false;
  }
  async load() {
    const r = await store.get('oibase');
    if (r && r.day === this.day && r.map) this.map = new Map(Object.entries(r.map));
    this.timer = setInterval(() => this.flush().catch(() => {}), 120e3);
    if (this.timer.unref) this.timer.unref();
  }
  chg(key, oi) {
    const d = istDay();
    if (d !== this.day) { this.day = d; this.map.clear(); this.dirty = true; }
    if (!this.map.has(key)) { this.map.set(key, oi); this.dirty = true; }
    return oi - this.map.get(key);
  }
  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    await store.set('oibase', { day: this.day, map: Object.fromEntries(this.map) });
  }
}
module.exports = OiBase;
