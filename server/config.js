const fs = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const CFG_FILE  = path.join(DATA_DIR, 'config.json');
const STAT_FILE = path.join(DATA_DIR, 'stats.json');
const ACT_FILE  = path.join(DATA_DIR, 'activity.json');

const TIERS = ['Iron','Bronze','Silver','Gold','Platinum','Diamond','Ascendant','Immortal','Radiant'];

function defaultTiers(priceKey, hoursKey, defaultPrice = 0) {
  const out = {};
  TIERS.forEach(t => { out[t] = { [priceKey]: defaultPrice, [hoursKey]: 1, skip: false }; });
  return out;
}

const DEFAULTS = {
  regions: ['NA', 'LATAM'],
  refresh_interval_seconds: 3,
  reject_console: true,
  fast_mode: { enabled: false },
  headless: false,
  discord_webhook: {
    enabled: false, url: '',
    notify_new_order: true, notify_buyer_message: true, notify_order_accepted: true,
  },
  rank_boost: {
    enabled: true,
    tiers: {
      Iron:      { price_per_division: 3,  hours_per_division: 4,  skip: false },
      Bronze:    { price_per_division: 4,  hours_per_division: 4,  skip: false },
      Silver:    { price_per_division: 5,  hours_per_division: 4,  skip: false },
      Gold:      { price_per_division: 7,  hours_per_division: 8,  skip: false },
      Platinum:  { price_per_division: 10, hours_per_division: 12, skip: false },
      Diamond:   { price_per_division: 15, hours_per_division: 24, skip: false },
      Ascendant: { price_per_division: 0,  hours_per_division: 1,  skip: true  },
      Immortal:  { price_per_division: 0,  hours_per_division: 1,  skip: true  },
      Radiant:   { price_per_division: 0,  hours_per_division: 1,  skip: true  },
    },
    completion_method: {
      Solo: { multiplier: 1.0, skip: false },
      Duo:  { multiplier: 1.5, skip: true  },
    },
    modifiers: {
      'Offline mode': { extra_multiplier: 1.0, skip: false },
      'Solo queue':   { extra_multiplier: 1.0, skip: true  },
      'No 5 stack':   { extra_multiplier: 1.0, skip: false },
      'Stream':       { extra_multiplier: 1.0, skip: true  },
    },
  },
  placement: {
    enabled: false,
    price_per_game: 3,
    total_games: 5,
    delivery_days: 1,
  },
  net_wins: {
    enabled: false,
    tiers: defaultTiers('price_per_win', 'hours_per_win'),
    completion_method: { Solo: { multiplier: 1.0, skip: false }, Duo: { multiplier: 1.5, skip: true } },
  },
  coaching: {
    enabled: false,
    tiers: defaultTiers('price_per_game', 'hours_per_game'),
    completion_method: { Solo: { multiplier: 1.0, skip: false }, Duo: { multiplier: 1.5, skip: true } },
  },
  chat_messages: {
    enabled: true,
    messages: [
      'Valorant Boosting – Affordable & Trustworthy 🎯🔥',
      '',
      '✨ New booster building reputation = lower prices for you',
      '⚡ Fast rank ups (Iron → Immortal)',
      '✔️ Safe & secure (VPN + no risky behavior)',
      '🌙 Offline mode available on request',
      '💬 Chill communication + regular updates',
      '',
      '🎮 I play on your account carefully like it\'s my own — no throwing, no weird stats.',
      '',
      '📩 DM me your current rank + goal, and I\'ll give you a fair price!',
    ],
    images: [],
  },
};

class Config {
  constructor() { this.data = null; }

  async init() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(path.join(DATA_DIR, 'chat_images'))) {
      fs.mkdirSync(path.join(DATA_DIR, 'chat_images'), { recursive: true });
    }
    if (!fs.existsSync(CFG_FILE)) {
      this.data = JSON.parse(JSON.stringify(DEFAULTS));
      this._save();
    } else {
      try {
        const raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
        this.data = this._merge(DEFAULTS, raw);
      } catch (e) {
        this.data = JSON.parse(JSON.stringify(DEFAULTS));
        this._save();
      }
    }
  }

  get() { return this.data; }

  update(newCfg) {
    this.data = this._merge(DEFAULTS, newCfg);
    this._save();
    return this.data;
  }

  _save() { fs.writeFileSync(CFG_FILE, JSON.stringify(this.data, null, 2), 'utf8'); }

  _merge(def, over) {
    const r = JSON.parse(JSON.stringify(def));
    for (const k of Object.keys(over)) {
      if (typeof over[k] === 'object' && !Array.isArray(over[k]) && over[k] !== null
          && typeof r[k] === 'object' && !Array.isArray(r[k])) {
        r[k] = this._merge(r[k], over[k]);
      } else {
        r[k] = over[k];
      }
    }
    return r;
  }

  // ── Stats persistence ──────────────────────────────────────────────────────
  getStats() {
    try {
      if (fs.existsSync(STAT_FILE)) return JSON.parse(fs.readFileSync(STAT_FILE, 'utf8'));
    } catch (e) {}
    return this._emptyStats();
  }

  recordOffer(price) {
    const stats = this.getStats();
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date !== today) { stats.date = today; stats.today = { offers: 0, revenue: 0 }; }
    stats.today.offers++;
    stats.today.revenue = Math.round((stats.today.revenue + price) * 100) / 100;
    stats.weekly_offers++;
    stats.weekly_revenue = Math.round((stats.weekly_revenue + price) * 100) / 100;
    fs.writeFileSync(STAT_FILE, JSON.stringify(stats, null, 2), 'utf8');
    return stats;
  }

  _emptyStats() {
    return { date: new Date().toISOString().slice(0, 10), today: { offers: 0, revenue: 0 }, weekly_offers: 0, weekly_revenue: 0 };
  }

  // ── Activity log ───────────────────────────────────────────────────────────
  getActivity() {
    try {
      if (fs.existsSync(ACT_FILE)) return JSON.parse(fs.readFileSync(ACT_FILE, 'utf8'));
    } catch (e) {}
    return { entries: [] };
  }

  addActivity(entry) {
    const log = this.getActivity();
    log.entries.unshift(entry);
    if (log.entries.length > 500) log.entries = log.entries.slice(0, 500);
    fs.writeFileSync(ACT_FILE, JSON.stringify(log, null, 2), 'utf8');
  }
}

module.exports = new Config();
