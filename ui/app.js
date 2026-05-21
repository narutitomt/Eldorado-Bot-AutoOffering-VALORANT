
/* ═══════════════════════════════════════════════════════════════════
   Eldorado Valorant Bot — Frontend
   ═══════════════════════════════════════════════════════════════════ */

const PORT = 8477;
const API  = 'http://127.0.0.1:' + PORT + '/api';

const TIERS     = ['Iron','Bronze','Silver','Gold','Platinum','Diamond','Ascendant','Immortal','Radiant'];
const REGIONS   = ['NA','EU','LATAM','BR','KR','AP'];
const MODIFIERS = ['Offline mode','Solo queue','No 5 stack','Stream'];

let config = {};
let socket = null;
let lastConsoleTime = 0;
let uptimeSeconds = 0;
let uptimeTimer = null;
let actPage = 1;
const ACT_PER_PAGE = 10;
const ACT_MAX_PAGES = 5;

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupTitlebar();
  setupNav();
  connectSocket();
  await loadConfig();
  await loadStats();
  loadActivity();
  setInterval(loadStats, 10000);
  setInterval(loadActivity, 15000);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveConfig(); }
  });
});

// ── Titlebar ──────────────────────────────────────────────────────────────────
function setupTitlebar() {
  if (!window.electronAPI) return;
  document.getElementById('tbMin').onclick   = () => window.electronAPI.minimize();
  document.getElementById('tbMax').onclick   = () => window.electronAPI.maximize();
  document.getElementById('tbClose').onclick = () => window.electronAPI.close();
}

// ── Navigation ────────────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.onclick = () => goTo(btn.dataset.page);
  });
}

function goTo(page) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io('http://127.0.0.1:' + PORT, { reconnection: true, reconnectionDelay: 1000 });

  socket.on('connect', () => console.log('[Socket] connected'));

  socket.on('snapshot', snap => {
    updateBotUI(snap.status, snap.uptime);
    if (snap.lines) snap.lines.forEach(appendConsoleLine);
  });

  socket.on('bot:status', ({ status, uptime }) => updateBotUI(status, uptime));

  socket.on('console:line', line => appendConsoleLine(line));

  socket.on('stats:updated', stats => renderStats(stats));

  socket.on('activity:new', entry => {
    actPage = 1;
    loadActivity();
  });

  socket.on('config:updated', cfg => { config = cfg; renderConfig(); });
}

// ── Bot Controls ──────────────────────────────────────────────────────────────
async function startBot() {
  showToast('Starting bot...', 'info');
  try {
    const r = await post('/bot/start');
    if (!r.ok) showToast(r.msg || 'Failed to start', 'error');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function stopBot() {
  try {
    const r = await post('/bot/stop');
    if (!r.ok) showToast(r.msg || 'Failed to stop', 'error');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function toggleFastMode() {
  const enabled = document.getElementById('fastModeToggle').checked;
  if (!config.fast_mode) config.fast_mode = {};
  config.fast_mode.enabled = enabled;
  try {
    await post('/config', config);
    showToast(enabled ? '⚡ Fast Mode ON (restart bot to apply)' : 'Normal Mode (restart bot to apply)', 'success');
  } catch (e) { showToast('Save failed', 'error'); }
}

function updateBotUI(status, uptime) {
  const running      = status === 'running';
  const waitingLogin = status === 'waiting_login';
  const active       = running || waitingLogin;

  // Titlebar dot + text
  const dot = document.getElementById('tbDot');
  const txt = document.getElementById('tbStatusText');
  dot.className = 'status-dot ' + (waitingLogin ? 'starting' : status);
  const labels = { running: 'Running', stopped: 'Stopped', waiting_login: 'Waiting Login', error: 'Error', starting: 'Starting' };
  txt.textContent = labels[status] || status;

  // Sidebar mini
  document.getElementById('miniDot').className = dot.className;
  document.getElementById('miniStatusText').textContent = txt.textContent;

  // Login banner — show when waiting for login
  const banner = document.getElementById('loginBanner');
  if (banner) banner.style.display = waitingLogin ? 'flex' : 'none';

  // Start/Stop buttons
  ['btnStart','btnStart2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = active ? 'none' : 'inline-flex';
  });
  ['btnStop','btnStop2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = active ? 'inline-flex' : 'none';
  });

  // Uptime counter
  const uptimeDisplay = document.getElementById('uptimeDisplay');
  if (running) {
    uptimeDisplay.style.display = 'flex';
    if (uptime !== undefined) uptimeSeconds = Math.floor(uptime);
    if (!uptimeTimer) {
      uptimeTimer = setInterval(() => {
        uptimeSeconds++;
        document.getElementById('uptimeText').textContent = formatUptime(uptimeSeconds);
      }, 1000);
    }
  } else {
    uptimeDisplay.style.display = 'none';
    uptimeSeconds = 0;
    if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; }
  }
}

function formatUptime(s) {
  const h = String(Math.floor(s/3600)).padStart(2,'0');
  const m = String(Math.floor((s%3600)/60)).padStart(2,'0');
  const sec = String(s%60).padStart(2,'0');
  return h + ':' + m + ':' + sec;
}

// ── Config ────────────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    config = await get('/config');
    renderConfig();
  } catch (e) { console.error('loadConfig failed:', e); }
}

function renderConfig() {
  // Fast mode
  const fm = document.getElementById('fastModeToggle');
  if (fm) fm.checked = config.fast_mode?.enabled === true;

  // Regions
  const grid = document.getElementById('regionsGrid');
  if (grid) {
    grid.innerHTML = REGIONS.map(r => `
      <label class="checkbox-item">
        <input type="checkbox" data-region="${r}" ${(config.regions||[]).includes(r) ? 'checked' : ''}>
        <span>${r}</span>
      </label>`).join('');
  }

  // General
  setVal('cfgRefresh', config.refresh_interval_seconds);
  setCheck('cfgRejectConsole', config.reject_console !== false);

  // Discord
  const dw = config.discord_webhook || {};
  setCheck('cfgDwEnabled',   dw.enabled === true);
  setVal('cfgDwUrl',         dw.url || '');
  setCheck('cfgDwNewOrder',  dw.notify_new_order !== false);
  setCheck('cfgDwMsg',       dw.notify_buyer_message !== false);
  setCheck('cfgDwAccepted',  dw.notify_order_accepted !== false);

  // Rank boost
  setCheck('cfgRbEnabled', config.rank_boost?.enabled !== false);
  renderTierTable('rbTiers',    config.rank_boost?.tiers || {},              'price_per_division', 'hours_per_division');
  renderMethodTable('rbMethods', config.rank_boost?.completion_method || {});
  renderModTable('rbModifiers',  config.rank_boost?.modifiers || {});

  // Placement
  setCheck('cfgPlEnabled',  config.placement?.enabled === true);
  setVal('cfgPlPrice',      config.placement?.price_per_game);
  setVal('cfgPlGames',      config.placement?.total_games);
  setVal('cfgPlDelivery',   config.placement?.delivery_days);

  // Net Wins
  setCheck('cfgNwEnabled',  config.net_wins?.enabled === true);
  renderTierTable('nwTiers', config.net_wins?.tiers || {}, 'price_per_win', 'hours_per_win');

  // Coaching
  setCheck('cfgCoEnabled',  config.coaching?.enabled === true);
  renderTierTable('coTiers', config.coaching?.tiers || {}, 'price_per_game', 'hours_per_game');

  // Chat
  setCheck('cfgChatEnabled', config.chat_messages?.enabled !== false);
  setVal('cfgChatMessages', (config.chat_messages?.messages || []).join('\n'));

  renderChatImages();
}

function renderTierTable(id, tiers, priceKey, hoursKey) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = TIERS.map(tier => {
    const t = tiers[tier] || {};
    return `<div class="tier-row" data-tier="${tier}">
      <span class="tier-name">${tier}</span>
      <input type="number" step="0.5" min="0" class="input-field" data-field="${priceKey}" value="${t[priceKey] || 0}"/>
      <input type="number" min="1" class="input-field" data-field="${hoursKey}" value="${t[hoursKey] || 1}"/>
      <label class="toggle"><input type="checkbox" data-field="skip" ${t.skip ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>`;
  }).join('');
}

function renderMethodTable(id, methods) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = ['Solo','Duo'].map(m => {
    const cfg = methods[m] || {};
    return `<div class="tier-row" data-method="${m}">
      <span class="tier-name">${m}</span>
      <input type="number" step="0.1" min="0.1" class="input-field" data-field="multiplier" value="${cfg.multiplier || 1.0}"/>
      <label class="toggle"><input type="checkbox" data-field="skip" ${cfg.skip ? 'checked' : ''}><span class="toggle-slider"></span></label>
      <span></span>
    </div>`;
  }).join('');
}

function renderModTable(id, mods) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = MODIFIERS.map(mod => {
    const m = mods[mod] || {};
    return `<div class="tier-row" data-modifier="${mod}">
      <span class="tier-name">${mod}</span>
      <input type="number" step="0.1" min="1" class="input-field" data-field="extra_multiplier" value="${m.extra_multiplier || 1.0}"/>
      <label class="toggle"><input type="checkbox" data-field="skip" ${m.skip ? 'checked' : ''}><span class="toggle-slider"></span></label>
      <span></span>
    </div>`;
  }).join('');
}

async function renderChatImages() {
  const el = document.getElementById('chatImagesList');
  if (!el) return;
  try {
    const data = await get('/chat-images');
    const imgs = data.images || [];
    if (!imgs.length) { el.innerHTML = ''; return; }
    el.innerHTML = imgs.map(img => {
      const previewUrl = img.path.startsWith('chat_images/')
        ? 'http://127.0.0.1:' + PORT + '/chat-images/' + img.path.split('/').slice(1).join('/') + '?t=' + Date.now()
        : '';
      const thumb = previewUrl && img.exists
        ? `<img src="${previewUrl}" alt="${esc(img.name)}">`
        : `<div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:10px">${img.exists ? '?' : '✗'}</div>`;
      return `<div class="img-chip">
        ${thumb}
        <span class="img-name">${esc(img.name)}</span>
        <button class="img-remove" onclick="removeImage('${img.path.replace(/'/g,"\\'")}')">×</button>
      </div>`;
    }).join('');
  } catch (e) {}
}

async function uploadImage(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    // Remove existing image first
    const existing = config.chat_messages?.images || [];
    if (existing.length) {
      await post('/chat-images/remove', { path: existing[0] });
    }
    try {
      const r = await post('/chat-images/upload', { filename: file.name, data: base64 });
      if (r.ok) { showToast('Image uploaded ✓', 'success'); await loadConfig(); }
      else showToast('Upload failed: ' + r.msg, 'error');
    } catch (e) { showToast('Upload error: ' + e.message, 'error'); }
  };
  reader.readAsDataURL(file);
  input.value = '';
}

async function removeImage(path) {
  try {
    const r = await post('/chat-images/remove', { path });
    if (r.ok) { showToast('Image removed', 'success'); await loadConfig(); }
    else showToast('Remove failed', 'error');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function saveConfig() {
  const cfg = {};

  cfg.regions = [];
  document.querySelectorAll('[data-region]').forEach(cb => { if (cb.checked) cfg.regions.push(cb.dataset.region); });

  cfg.refresh_interval_seconds = parseInt(val('cfgRefresh')) || 3;
  cfg.reject_console = chk('cfgRejectConsole');
  cfg.fast_mode = { enabled: config.fast_mode?.enabled || false };

  cfg.discord_webhook = {
    enabled: chk('cfgDwEnabled'),
    url: val('cfgDwUrl').trim(),
    notify_new_order: chk('cfgDwNewOrder'),
    notify_buyer_message: chk('cfgDwMsg'),
    notify_order_accepted: chk('cfgDwAccepted'),
  };

  cfg.rank_boost = {
    enabled: chk('cfgRbEnabled'),
    tiers: gatherTiers('rbTiers', 'price_per_division', 'hours_per_division'),
    completion_method: gatherMethods('rbMethods'),
    modifiers: gatherMods('rbModifiers'),
  };

  cfg.placement = {
    enabled: chk('cfgPlEnabled'),
    price_per_game: parseFloat(val('cfgPlPrice')) || 3,
    total_games: parseInt(val('cfgPlGames')) || 5,
    delivery_days: parseInt(val('cfgPlDelivery')) || 1,
  };

  cfg.net_wins = {
    enabled: chk('cfgNwEnabled'),
    tiers: gatherTiers('nwTiers', 'price_per_win', 'hours_per_win'),
    completion_method: cfg.rank_boost.completion_method,
  };

  cfg.coaching = {
    enabled: chk('cfgCoEnabled'),
    tiers: gatherTiers('coTiers', 'price_per_game', 'hours_per_game'),
    completion_method: cfg.rank_boost.completion_method,
  };

  const rawMsg = val('cfgChatMessages');
  cfg.chat_messages = {
    enabled: chk('cfgChatEnabled'),
    messages: rawMsg ? rawMsg.split('\n') : [],
    images: config.chat_messages?.images || [],
  };

  try {
    const r = await post('/config', cfg);
    if (r.ok) {
      showToast('Configuration saved ✓', 'success');
      document.querySelectorAll('.btn-save').forEach(b => {
        b.classList.add('saved');
        const orig = b.innerHTML;
        b.innerHTML = '✓ Saved!';
        setTimeout(() => { b.classList.remove('saved'); b.innerHTML = orig; }, 2000);
      });
    } else {
      showToast('Error: ' + r.msg, 'error');
    }
  } catch (e) {
    showToast('Failed to save: ' + e.message, 'error');
  }
}

async function testAndSaveDiscord() {
  const url = val('cfgDwUrl').trim();
  if (!url) { showToast('Paste a webhook URL first', 'error'); return; }
  showToast('Testing...', 'info');
  try {
    const r = await post('/discord-test', { url });
    if (r.ok) { await saveConfig(); showToast('Test sent + config saved ✓', 'success'); }
    else showToast('Test failed: ' + r.msg, 'error');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

function gatherTiers(id, priceKey, hoursKey) {
  const out = {};
  document.querySelectorAll('#' + id + ' .tier-row').forEach(row => {
    const tier = row.dataset.tier;
    if (!tier) return;
    out[tier] = {
      [priceKey]: parseFloat(row.querySelector('[data-field="'+priceKey+'"]').value) || 0,
      [hoursKey]: parseInt(row.querySelector('[data-field="'+hoursKey+'"]').value) || 1,
      skip: row.querySelector('[data-field="skip"]').checked,
    };
  });
  return out;
}

function gatherMethods(id) {
  const out = {};
  document.querySelectorAll('#' + id + ' .tier-row').forEach(row => {
    const method = row.dataset.method;
    if (!method) return;
    out[method] = {
      multiplier: parseFloat(row.querySelector('[data-field="multiplier"]').value) || 1,
      skip: row.querySelector('[data-field="skip"]').checked,
    };
  });
  return out;
}

function gatherMods(id) {
  const out = {};
  document.querySelectorAll('#' + id + ' .tier-row').forEach(row => {
    const mod = row.dataset.modifier;
    if (!mod) return;
    out[mod] = {
      extra_multiplier: parseFloat(row.querySelector('[data-field="extra_multiplier"]').value) || 1,
      skip: row.querySelector('[data-field="skip"]').checked,
    };
  });
  return out;
}

// ── Console ───────────────────────────────────────────────────────────────────
function appendConsoleLine(line) {
  const mini = document.getElementById('consoleMini');
  const full = document.getElementById('consoleFull');

  const el = buildConsoleLine(line);
  if (mini) { mini.appendChild(el.cloneNode(true)); while (mini.children.length > 60) mini.removeChild(mini.firstChild); mini.scrollTop = mini.scrollHeight; }
  if (full) { full.appendChild(el); full.scrollTop = full.scrollHeight; }

  lastConsoleTime = Math.max(lastConsoleTime, line.time || 0);
}

function buildConsoleLine(line) {
  const div = document.createElement('div');
  div.className = 'console-line';
  const text = line.text || '';
  if (text.includes('[ERROR]') || text.includes('FAILED')) div.classList.add('error');
  else if (text.includes('[OK]') || text.includes('✓'))   div.classList.add('ok');
  else if (text.includes('[*]') && (text.includes('OFFER') || text.includes('$') || text.includes('order'))) div.classList.add('offer');
  else if (text.includes('[!]'))                           div.classList.add('warn');
  else                                                     div.classList.add('info');

  const t = line.time ? new Date(line.time * 1000).toLocaleTimeString('en-US', { hour12: false }) : '';
  div.innerHTML = `<span class="time">${t}</span>${esc(text)}`;
  return div;
}

function clearConsole() {
  ['consoleMini','consoleFull'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
}

async function sendInput(which) {
  const inputId = which === 'mini' ? 'miniInput' : 'fullInput';
  const input = document.getElementById(inputId);
  const text = input.value.trim();
  if (!text) return;
  try {
    await post('/bot/input', { text });
    input.value = '';
  } catch (e) { showToast('Send failed', 'error'); }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const s = await get('/stats');
    renderStats(s);
  } catch (e) {}
}

function renderStats(s) {
  setEl('statOffersToday',  s.today?.offers || 0);
  setEl('statRevenueToday', '$' + (s.today?.revenue || 0).toFixed(2));
  setEl('statOffersWeek',   s.weekly_offers || 0);
  setEl('statRevenueWeek',  '$' + (s.weekly_revenue || 0).toFixed(2));
}

// ── Activity ──────────────────────────────────────────────────────────────────
async function loadActivity() {
  try {
    const data = await get('/activity');
    renderActivity(data.entries || []);
  } catch (e) {}
}

function renderActivity(entries) {
  const tbody  = document.getElementById('activityTbody');
  const filter = document.getElementById('actFilter')?.value || 'all';
  let filtered = filter === 'all' ? entries : entries.filter(e => e.type === filter);
  filtered = filtered.slice(0, ACT_MAX_PAGES * ACT_PER_PAGE);

  if (!filtered.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No activity yet. Start the bot to see offers here.</td></tr>';
    renderPagination(0);
    return;
  }

  const totalPages = Math.min(Math.ceil(filtered.length / ACT_PER_PAGE), ACT_MAX_PAGES);
  if (actPage > totalPages) actPage = 1;
  const slice = filtered.slice((actPage-1)*ACT_PER_PAGE, actPage*ACT_PER_PAGE);

  tbody.innerHTML = slice.map(e => {
    const boost = e.rank_from && e.rank_to ? `${e.rank_from} → ${e.rank_to}` : (e.rank_from || '—');
    const price = e.price ? `$${e.price.toFixed(2)}` : '—';
    const link  = e.url ? `<a href="${e.url}" class="offer-link" onclick="openExt('${e.url}');return false" title="Open on Eldorado">↗</a>` : '';
    return `<tr>
      <td class="time-cell">${e.time || ''}</td>
      <td><span class="type-badge offer_sent">${(e.type||'').replace('_',' ').toUpperCase()}</span></td>
      <td><span class="region-badge">${e.region || '—'}</span></td>
      <td class="boost-cell">${boost}</td>
      <td class="price-cell">${price}</td>
      <td>${link}</td>
    </tr>`;
  }).join('');

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const el = document.getElementById('actPagination');
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = Array.from({length: totalPages}, (_,i) =>
    `<button class="page-btn ${i+1===actPage?'active':''}" onclick="actPage=${i+1};loadActivity()">${i+1}</button>`
  ).join('');
}

function openExt(url) {
  if (window.electronAPI) window.electronAPI.openExternal(url);
  else window.open(url, '_blank');
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast visible ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('visible'), 3000);
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function get(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function post(path, body = {}) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.msg || 'HTTP ' + r.status); }
  return r.json();
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function setVal(id, v)   { const el = document.getElementById(id); if (el) el.value = v ?? ''; }
function setCheck(id, v) { const el = document.getElementById(id); if (el) el.checked = !!v; }
function setEl(id, v)    { const el = document.getElementById(id); if (el) el.textContent = v; }
function val(id)         { return document.getElementById(id)?.value || ''; }
function chk(id)         { return document.getElementById(id)?.checked || false; }
function esc(s)          { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Login banner ──────────────────────────────────────────────────────────────
// Show banner when bot logs "Not logged in"
const _origAppend = appendConsoleLine;
appendConsoleLine = function(line) {
  _origAppend(line);
  const banner = document.getElementById('loginBanner');
  if (!banner) return;
  if (line.text && line.text.includes('Not logged in')) {
    banner.style.display = 'flex';
  }
  if (line.text && (line.text.includes('Logged in') || line.text.includes('[OK]'))) {
    banner.style.display = 'none';
  }
};
 
