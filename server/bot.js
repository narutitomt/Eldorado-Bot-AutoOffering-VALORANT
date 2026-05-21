/**
 * EldoradoBot — Playwright automation para Eldorado.gg Valorant boosting.
 *
 * Flujo correcto basado en la UI real de Eldorado:
 *  1. Abre Chrome con perfil dedicado, espera login.
 *  2. Monitorea /dashboard/notifications cada N segundos.
 *  3. Por cada notificación nueva → navega a la URL de la orden.
 *  4. En la página de la orden → click "Create offer".
 *  5. En el modal → llena Price $ + selecciona Delivery time → click "Create offer".
 *  6. Opcional: click "Chat with buyer" → escribe en "Say something..." → envía.
 */

const { chromium } = require('playwright');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { v4: uuidv4 } = require('uuid');

const NOTIFICATIONS_URL = 'https://www.eldorado.gg/es/dashboard/notifications';
const LOGIN_URL         = 'https://www.eldorado.gg/es/login';

// Rangos de Valorant — 3 divisiones por tier (I, II, III) excepto Radiant
const TIERS = ['Iron','Bronze','Silver','Gold','Platinum','Diamond','Ascendant','Immortal','Radiant'];
const RANK_ORDER = [];
TIERS.forEach(t => {
  if (t === 'Radiant') { RANK_ORDER.push('Radiant'); return; }
  ['I','II','III'].forEach(d => RANK_ORDER.push(t + ' ' + d));
});

// Opciones del dropdown "Delivery time" que usa Eldorado
// El bot elige la opción más cercana a las horas calculadas
const DELIVERY_OPTIONS = [
  { label: '1 hour',   hours: 1   },
  { label: '2 hours',  hours: 2   },
  { label: '4 hours',  hours: 4   },
  { label: '8 hours',  hours: 8   },
  { label: '12 hours', hours: 12  },
  { label: '1 day',    hours: 24  },
  { label: '2 days',   hours: 48  },
  { label: '3 days',   hours: 72  },
  { label: '5 days',   hours: 120 },
  { label: '7 days',   hours: 168 },
];

const MAX_LOGS = 500;

const STATE = {
  STOPPED:       'stopped',
  WAITING_LOGIN: 'waiting_login',
  RUNNING:       'running',
  ERROR:         'error',
};

class EldoradoBot {
  constructor(io, config) {
    this.io      = io;
    this.config  = config;
    this.status  = STATE.STOPPED;
    this.startTime = null;
    this._context  = null;
    this._page     = null;
    this._timer    = null;
    this._loginCheckTimer = null;
    this._logs     = [];
    this._seenIds  = new Set();
  }

  // ── API pública ────────────────────────────────────────────────────────────

  async start() {
    if (this.status === STATE.RUNNING || this.status === STATE.WAITING_LOGIN) {
      throw new Error('Bot ya está corriendo');
    }
    this._setStatus(STATE.WAITING_LOGIN);
    this.log('info', '[*] Iniciando bot...');
    try {
      await this._launchBrowser();
    } catch (err) {
      this._setStatus(STATE.ERROR);
      this.log('error', '[ERROR] ' + err.message);
      throw err;
    }
  }

  async stop() {
    this._clearTimers();
    if (this._context) {
      try { await this._context.close(); } catch (e) {}
      this._context = null;
      this._page    = null;
    }
    this._setStatus(STATE.STOPPED);
    this.startTime = null;
    this.log('info', '[*] Bot detenido.');
  }

  sendInput(text) { this.log('info', '> ' + text); }

  getSnapshot() {
    return {
      status: this.status,
      uptime: this.startTime ? (Date.now() - this.startTime) / 1000 : 0,
      lines:  this._logs.slice(-50),
    };
  }

  getConsoleLines(since) {
    const lines = since > 0
      ? this._logs.filter(l => l.time > since)
      : this._logs.slice(-100);
    return { lines, status: this.status, uptime: this.startTime ? (Date.now() - this.startTime) / 1000 : 0 };
  }

  // ── Lanzar browser ─────────────────────────────────────────────────────────

  async _launchBrowser() {
    // Usar el Chromium embebido de Playwright.
    // Si no está descargado, lo descarga automáticamente antes de continuar.
    const { chromium: pw } = require('playwright');

    // Auto-descargar Chromium si no existe (primera vez en PC nueva)
    await this._ensureChromium(pw);

    // Perfil persistente junto al ejecutable (o en AppData si está empaquetado)
    let profileDir;
    if (process.resourcesPath) {
      // Ejecutable empaquetado con electron-builder
      const appData = process.env.APPDATA || process.env.HOME || os.tmpdir();
      profileDir = path.join(appData, 'EldoradoBot', 'browser-profile');
    } else {
      // Desarrollo — carpeta data/ del proyecto
      profileDir = path.join(__dirname, '..', 'data', 'browser-profile');
    }

    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
      this.log('info', '[*] Primer inicio — creando perfil de browser...');
    }

    this.log('info', '[*] Perfil: ' + profileDir);

    try {
      // Determinar ruta del ejecutable de Chromium
      // Orden de búsqueda:
      // 1. resources/ms-playwright/ (dentro del .exe empaquetado)
      // 2. pw.executablePath() (%LOCALAPPDATA%/ms-playwright/ en desarrollo)
      let executablePath;

      // 1. Buscar en resources/ del exe empaquetado
      if (process.resourcesPath) {
        const chromiumDir = path.join(process.resourcesPath, 'ms-playwright');
        if (fs.existsSync(chromiumDir)) {
          const dirs = fs.readdirSync(chromiumDir).filter(d => d.startsWith('chromium'));
          for (const dir of dirs) {
            const candidates = [
              path.join(chromiumDir, dir, 'chrome-win64', 'chrome.exe'),
              path.join(chromiumDir, dir, 'chrome-linux', 'chrome'),
              path.join(chromiumDir, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
            ];
            for (const cand of candidates) {
              if (fs.existsSync(cand)) { executablePath = cand; break; }
            }
            if (executablePath) break;
          }
          if (executablePath) this.log('info', '[*] Chromium empaquetado encontrado');
        }
      }

      // 2. Usar el de Playwright directamente
      if (!executablePath) {
        try {
          const pwExec = pw.executablePath();
          if (fs.existsSync(pwExec)) {
            executablePath = pwExec;
            this.log('info', '[*] Chromium: ' + pwExec);
          }
        } catch (e) {}
      }

      // 3. Buscar en node_modules local (cuando playwright install --path fue usado)
      if (!executablePath) {
        const localBrowsers = path.join(__dirname, '..', 'node_modules', 'playwright', '.local-browsers');
        if (fs.existsSync(localBrowsers)) {
          const dirs = fs.readdirSync(localBrowsers).filter(d => d.startsWith('chromium'));
          for (const dir of dirs) {
            const cand = path.join(localBrowsers, dir, 'chrome-win64', 'chrome.exe');
            if (fs.existsSync(cand)) { executablePath = cand; break; }
          }
        }
      }

      if (!executablePath) {
        this.log('warn', '[!] No se encontró Chromium. Intentando sin ruta específica...');
      }

      this._context = await pw.launchPersistentContext(profileDir, {
        headless: false,
        executablePath: executablePath || undefined,
        viewport: { width: 1280, height: 800 },
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--disable-extensions',
          '--no-first-run',
          '--no-default-browser-check',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        timeout: 60000,
      });
    } catch (err) {
      if (err.message.includes('already in use') || err.message.includes('SingletonLock')) {
        this.log('warn', '[!] Perfil bloqueado — usando perfil temporal...');
        const tmpDir = path.join(os.tmpdir(), 'eldorado-bot-' + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        this._context = await pw.launchPersistentContext(tmpDir, {
          headless: false,
          viewport: { width: 1280, height: 800 },
          args: ['--no-sandbox','--disable-blink-features=AutomationControlled','--disable-infobars','--no-first-run'],
          ignoreDefaultArgs: ['--enable-automation'],
          timeout: 60000,
        });
      } else {
        throw new Error('Error iniciando browser: ' + err.message);
      }
    }

    const pages = this._context.pages();
    this._page  = pages.length > 0 ? pages[0] : await this._context.newPage();

    this.log('info', '[*] Abriendo Eldorado.gg...');
    try {
      await this._page.goto(NOTIFICATIONS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      this.log('warn', '[!] Error navegando: ' + e.message);
    }

    this._context.on('close', () => {
      if (this.status !== STATE.STOPPED) {
        this.log('error', '[ERROR] Chrome cerrado inesperadamente.');
        this._setStatus(STATE.ERROR);
        this._clearTimers();
      }
    });

    await this._sleep(3000);
    const loggedIn = await this._checkLogin();

    if (loggedIn) {
      this._onLoginSuccess();
    } else {
      this.log('warn', '[!] Inicia sesión en la ventana que se abrió. El bot esperará...');
      this._startLoginWatcher();
    }
  }
  // Asegurar que Chromium esté disponible — descarga si no existe
  async _ensureChromium(pw) {
    try {
      const execPath = pw.executablePath();
      if (fs.existsSync(execPath)) return; // ya está
    } catch (e) {}

    this.log('info', '[*] Chromium no encontrado. Descargando (~150MB, solo una vez)...');
    this.log('info', '[*] Por favor espera, no cierres el bot...');

    try {
      const { execSync } = require('child_process');
      // Intentar con el CLI de playwright
      const pwDir = path.dirname(require.resolve('playwright/package.json'));
      const cli   = path.join(pwDir, 'cli.js');
      execSync(`node "${cli}" install chromium`, { stdio: 'pipe', timeout: 600000 });
      this.log('ok', '[OK] Chromium descargado. Iniciando browser...');
    } catch (e) {
      // Fallback: usar npx
      try {
        const { execSync } = require('child_process');
        execSync('npx playwright install chromium', { stdio: 'pipe', timeout: 600000 });
        this.log('ok', '[OK] Chromium listo.');
      } catch (e2) {
        this.log('warn', '[!] No se pudo descargar Chromium automáticamente: ' + e2.message);
        this.log('warn', '[!] Corre manualmente: npx playwright install chromium');
      }
    }
  }

  _startLoginWatcher() {
    this.log('info', '[*] Esperando login... (no navegará hasta que inicies sesión)');
    let attempts = 0;
    const check = async () => {
      if (this.status !== STATE.WAITING_LOGIN) return;
      attempts++;
      const loggedIn = await this._checkLogin();
      if (loggedIn) { this._onLoginSuccess(); return; }
      if (attempts % 10 === 0) this.log('info', `[*] Esperando login... (${Math.round(attempts * 3)}s)`);
      this._loginCheckTimer = setTimeout(check, 3000);
    };
    this._loginCheckTimer = setTimeout(check, 3000);
  }

  _onLoginSuccess() {
    if (this._loginCheckTimer) { clearTimeout(this._loginCheckTimer); this._loginCheckTimer = null; }
    this.startTime = Date.now();
    this._setStatus(STATE.RUNNING);
    this.log('ok', '[OK] ¡Login detectado! Monitoreando notificaciones...');
    this._page.goto(NOTIFICATIONS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 })
      .catch(e => this.log('warn', '[!] ' + e.message))
      .then(() => this._scheduleCheck());
  }

  async _checkLogin() {
    try {
      return await this._page.evaluate(() => {
        if (window.location.href.includes('/dashboard')) return true;
        const body = document.body.innerText || '';
        if (body.includes('Log out') || body.includes('Sign out') || body.includes('Cerrar sesión')) return true;
        const sels = ['img[class*="avatar" i]','[class*="Avatar"]','[class*="UserMenu"]','[class*="userMenu"]','a[href*="/profile"]'];
        return sels.some(s => !!document.querySelector(s));
      });
    } catch (e) { return false; }
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  _scheduleCheck() {
    if (this.status !== STATE.RUNNING) return;
    const ms = (this.config.get().refresh_interval_seconds || 5) * 1000;
    this._timer = setTimeout(() => this._runCheck(), ms);
  }

  _clearTimers() {
    if (this._timer)           { clearTimeout(this._timer);           this._timer = null; }
    if (this._loginCheckTimer) { clearTimeout(this._loginCheckTimer); this._loginCheckTimer = null; }
  }

  async _runCheck() {
    if (this.status !== STATE.RUNNING) return;
    try { await this._checkNotifications(); }
    catch (err) { this.log('error', '[ERROR] ' + err.message); }
    this._scheduleCheck();
  }

  // ── Leer notificaciones ────────────────────────────────────────────────────

  async _checkNotifications() {
    if (!this._page || this._page.isClosed()) {
      const pages = this._context.pages();
      this._page = pages.length > 0 ? pages[0] : await this._context.newPage();
    }

    // Volver a notificaciones solo si nos fuimos a otra sección
    const url = this._page.url();
    if (!url.includes('/dashboard/notifications')) {
      await this._page.goto(NOTIFICATIONS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this._sleep(2000);
    }

    // Verificar sesión activa
    const loggedIn = await this._checkLogin();
    if (!loggedIn) {
      this.log('warn', '[!] Sesión expirada. Vuelve a loguearte.');
      this._setStatus(STATE.WAITING_LOGIN);
      this._startLoginWatcher();
      return;
    }

    // Scrapear notificaciones visibles en la página
    const notifications = await this._scrapeNotifications();
    if (notifications.length === 0) return;

    const cfg = this.config.get();

    for (const notif of notifications) {
      if (this._seenIds.has(notif.id)) continue;
      this._seenIds.add(notif.id);

      this.log('info', `[*] Notificación: ${notif.type} | ${notif.rankFrom} → ${notif.rankTo} | región:"${notif.region}"`);

      // Filtros
      // Si la región está vacía (el scraper no la encontró), NO ignorar — dejar pasar
      // para que el bot intente hacer la oferta igualmente.
      if (notif.region && !cfg.regions.includes(notif.region)) {
        this.log('info', `    → Ignorado: región "${notif.region}" no está en tu lista (configúrala en General)`);
        continue;
      }
      if (!notif.region) {
        this.log('warn', `    → Región no detectada — procesando de todos modos`);
      }
      if (cfg.reject_console && notif.isConsole) {
        this.log('info', '    → Ignorado: jugador de consola');
        continue;
      }
      if (notif.type === 'custom') {
        this.log('info', '    → Ignorado: Custom Request (requiere precio manual)');
        continue;
      }

      const priceResult = this._calculatePrice(notif, cfg);
      if (!priceResult.ok) {
        this.log('info', `    → Ignorado: ${priceResult.reason}`);
        continue;
      }

      this.log('offer', `[*] Mandando oferta: $${priceResult.price.toFixed(2)} | entrega: ${priceResult.deliveryLabel}`);

      const ok = await this._placeOffer(notif, priceResult.price, priceResult.deliveryLabel, cfg);

      if (ok) {
        this.log('ok', `[OK] ✓ Oferta enviada — $${priceResult.price.toFixed(2)}`);
        const stats = this.config.recordOffer(priceResult.price);
        this.io.emit('stats:updated', stats);
        this.config.addActivity({
          id: uuidv4(),
          time: new Date().toLocaleTimeString('en-US', { hour12: false }),
          type: notif.type,
          status: 'offer_sent',
          region: notif.region,
          rank_from: notif.rankFrom,
          rank_to:   notif.rankTo,
          price: priceResult.price,
          url:   notif.url,
        });
        this.io.emit('activity:new', {});

        if (cfg.discord_webhook?.enabled && cfg.discord_webhook?.notify_new_order) {
          this._discordNotify(cfg.discord_webhook.url,
            `🎯 **Oferta enviada!** ${notif.type} | ${notif.region} | ${notif.rankFrom} → ${notif.rankTo} | $${priceResult.price.toFixed(2)}`);
        }
      } else {
        this.log('warn', '[!] No se pudo enviar la oferta.');
      }

      await this._sleep(1000);
    }
  }

  // ── Scraping de notificaciones ─────────────────────────────────────────────

  async _scrapeNotifications() {
    try {
      // Primeras 3 veces: loguear HTML de diagnóstico para ver la estructura real
      if (!this._diagDone) {
        const html = await this._page.evaluate(() => {
          // Capturar el HTML del contenedor principal de notificaciones
          const main = document.querySelector('main') || document.body;
          // Buscar el primer link a boosting-request y mostrar su contexto
          const link = main.querySelector('a[href*="boosting-request"]');
          if (link) {
            // Subir al padre para ver el bloque completo
            const block = link.closest('li, article, [class*="item"], [class*="card"]') || link;
            return '=BLOCK_HTML=\n' + block.outerHTML.slice(0, 1500);
          }
          // Si no hay links, mostrar estructura del main
          return '=MAIN_HTML=\n' + main.innerHTML.slice(0, 2000);
        });
        this.log('info', '[DIAG] ' + html.replace(/\n/g, ' ').slice(0, 400));
        this._diagCount = (this._diagCount || 0) + 1;
        if (this._diagCount >= 2) this._diagDone = true;
      }

      return await this._page.evaluate(() => {
        const results = [];
        const rankNames = ['Iron','Bronze','Silver','Gold','Platinum','Diamond','Ascendant','Immortal','Radiant'];
        const rankRx    = new RegExp('\\b(' + rankNames.join('|') + ')\\b', 'i');
        const regionRx  = /\b(NA|EU|LATAM|BR|KR|AP|SEA|OCE)\b/;

        // ── Encontrar contenedores de notificación ──────────────────────────
        // Eldorado: cada notificación es un <a href="/es/boosting-request/UUID">
        // que contiene varios elementos hijos con el texto separado por nodos.
        let containers = Array.from(
          document.querySelectorAll('a[href*="boosting-request"], a[href*="boost-request"]')
        );

        // Fallback: buscar por texto que contenga "Valorant"
        if (containers.length === 0) {
          containers = Array.from(document.querySelectorAll('a[href]')).filter(a =>
            /valorant/i.test(a.innerText || '') && (a.innerText || '').length < 500
          );
        }

        // Fallback 2: lis o divs con rango en el texto
        if (containers.length === 0) {
          const all = Array.from(document.querySelectorAll('li, article, [class*="notification"]'));
          containers = all.filter(el => rankRx.test(el.innerText || '') && (el.innerText || '').length < 400);
        }

        for (const el of containers.slice(0, 40)) {
          try {
            // ── URL e ID ────────────────────────────────────────────────────
            const href = el.href || el.querySelector('a[href*="boosting"]')?.href || '';
            const uuidMatch = href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!uuidMatch) continue; // sin UUID válido no podemos navegar a la orden
            const id = uuidMatch[0];

            // ── Extraer todos los textos de nodos hijos directos ─────────────
            // Eldorado pone cada dato (tipo, rankFrom, rankTo, región) en
            // elementos separados (<p>, <span>, <div>) dentro del <a>
            const childTexts = [];
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const t = node.textContent.trim();
              if (t && t.length > 0 && t.length < 60) childTexts.push(t);
            }
            const fullText = childTexts.join(' | ');

            // ── Tipo ────────────────────────────────────────────────────────
            let type = 'rank_boost';
            if (/Net.?Win/i.test(fullText))        type = 'net_wins';
            else if (/Placement/i.test(fullText))  type = 'placement';
            else if (/Coach/i.test(fullText))      type = 'coaching';
            else if (/Custom/i.test(fullText))     type = 'custom';

            // ── Región ──────────────────────────────────────────────────────
            // Buscar en los textos individuales de los hijos para evitar falsos positivos
            let region = '';
            for (const t of childTexts) {
              const m = t.match(regionRx);
              if (m) { region = m[1]; break; }
            }
            // Fallback: buscar en el texto completo
            if (!region) {
              const m = fullText.match(regionRx);
              if (m) region = m[1];
            }

            // ── Rangos ──────────────────────────────────────────────────────
            // Cada rango está en su propio nodo de texto en Eldorado.
            // Ejemplo de childTexts: ["Valorant (Rank Boost)", "Gold II", "Ascendant I", "EU", "Just now"]
            const rankTexts = childTexts.filter(t => rankRx.test(t));

            const parseRank = (raw) => {
              // Acepta: "Gold II", "Gold 2", "Gold III", "Radiant", "Iron I"
              const m = raw.match(/(Iron|Bronze|Silver|Gold|Platinum|Diamond|Ascendant|Immortal|Radiant)\s*([IVX]{1,3}|\d)?/i);
              if (!m) return '';
              const tier = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
              let div = (m[2] || '').toString().trim();
              // Normalizar números a romano
              if (div === '1') div = 'I';
              else if (div === '2') div = 'II';
              else if (div === '3') div = 'III';
              if (tier === 'Radiant') return 'Radiant';
              return div ? tier + ' ' + div : tier + ' I'; // default division I
            };

            const rankFrom = rankTexts[0] ? parseRank(rankTexts[0]) : '';
            const rankTo   = rankTexts[1] ? parseRank(rankTexts[1]) : '';

            // ── Modificadores ────────────────────────────────────────────────
            const isDuo = /\bDuo\b/i.test(fullText);
            const isConsole = /ps[45]|xbox|console/i.test(fullText);
            const modifiers = [];
            if (/offline/i.test(fullText))        modifiers.push('Offline mode');
            if (/solo.?queue/i.test(fullText))   modifiers.push('Solo queue');
            if (/no.?5.?stack/i.test(fullText))  modifiers.push('No 5 stack');
            if (/\bstream\b/i.test(fullText))   modifiers.push('Stream');

            const numGameMatch = fullText.match(/(\d+)\s*(game|win|match|partida|victoria)/i);
            const quantity = numGameMatch ? parseInt(numGameMatch[1]) : 1;

            results.push({ id, type, region, rankFrom, rankTo, isConsole, isDuo, modifiers, quantity, url: href });
          } catch (e) {}
        }

        return results;
      });
    } catch (e) {
      this.log('warn', '[!] Error scraping: ' + e.message);
      return [];
    }
  }

  // ── Cálculo de precio ──────────────────────────────────────────────────────

  _calculatePrice(order, cfg) {
    try {
      if (order.type === 'rank_boost') {
        const rb = cfg.rank_boost;
        if (!rb.enabled) return { ok: false, reason: 'Rank boost desactivado' };

        const method    = order.isDuo ? 'Duo' : 'Solo';
        const methodCfg = rb.completion_method[method] || {};
        if (methodCfg.skip) return { ok: false, reason: `Skipping método ${method}` };

        for (const mod of order.modifiers) {
          if (rb.modifiers[mod]?.skip) return { ok: false, reason: `Skipping: ${mod}` };
        }

        // Normalizar rangos al formato del RANK_ORDER
        const normalize = (r) => {
          if (!r) return '';
          // "Iron 1" → "Iron I", "Iron I" → "Iron I", "Radiant" → "Radiant"
          return r.replace(/\s+(\d)$/, (_, n) => ' ' + ['','I','II','III'][+n] || '');
        };

        const fromRank = normalize(order.rankFrom);
        const toRank   = normalize(order.rankTo);

        let fromIdx = RANK_ORDER.indexOf(fromRank);
        let toIdx   = RANK_ORDER.indexOf(toRank);

        // Fallback: buscar por tier si no coincide exacto
        if (fromIdx < 0) fromIdx = RANK_ORDER.findIndex(r => r.startsWith(order.rankFrom?.split(' ')[0] || ''));
        if (toIdx   < 0) toIdx   = RANK_ORDER.findIndex(r => r.startsWith(order.rankTo?.split(' ')[0] || ''));

        if (fromIdx < 0 || toIdx < 0) {
          return { ok: false, reason: `Rango no reconocido: "${order.rankFrom}" → "${order.rankTo}"` };
        }
        if (toIdx <= fromIdx) {
          return { ok: false, reason: `Rango destino igual o menor al origen` };
        }

        let price = 0, totalHours = 0;
        for (let i = fromIdx; i < toIdx; i++) {
          const rankStr  = RANK_ORDER[i];
          const tierName = TIERS.find(t => rankStr.startsWith(t)) || 'Iron';
          const tierCfg  = rb.tiers[tierName] || {};
          if (tierCfg.skip) return { ok: false, reason: `Skipping tier: ${tierName}` };
          price      += tierCfg.price_per_division || 0;
          totalHours += tierCfg.hours_per_division || 1;
        }

        price *= (methodCfg.multiplier || 1);
        for (const mod of order.modifiers) price *= (rb.modifiers[mod]?.extra_multiplier || 1);
        price = Math.round(price * 100) / 100;

        if (price <= 0) return { ok: false, reason: 'Precio $0 — configura precios en Rank Boost' };

        const deliveryLabel = this._closestDeliveryOption(totalHours);
        return { ok: true, price, totalHours, deliveryLabel };
      }

      if (order.type === 'net_wins') {
        const nw = cfg.net_wins;
        if (!nw.enabled) return { ok: false, reason: 'Net wins desactivado' };
        const tierName = TIERS.find(t => (order.rankFrom||'').startsWith(t)) || 'Iron';
        const tierCfg  = nw.tiers[tierName] || {};
        if (tierCfg.skip) return { ok: false, reason: `Skipping tier: ${tierName}` };
        const price      = Math.round(tierCfg.price_per_win * (order.quantity||1) * 100) / 100;
        const totalHours = tierCfg.hours_per_win * (order.quantity||1);
        if (price <= 0) return { ok: false, reason: 'Precio $0' };
        return { ok: true, price, totalHours, deliveryLabel: this._closestDeliveryOption(totalHours) };
      }

      if (order.type === 'placement') {
        const pl = cfg.placement;
        if (!pl.enabled) return { ok: false, reason: 'Placements desactivado' };
        const price      = Math.round(pl.price_per_game * (order.quantity||pl.total_games) * 100) / 100;
        const totalHours = pl.delivery_days * 24;
        return { ok: true, price, totalHours, deliveryLabel: this._closestDeliveryOption(totalHours) };
      }

      if (order.type === 'coaching') {
        const co = cfg.coaching;
        if (!co.enabled) return { ok: false, reason: 'Coaching desactivado' };
        const tierName = TIERS.find(t => (order.rankFrom||'').startsWith(t)) || 'Iron';
        const tierCfg  = co.tiers[tierName] || {};
        if (tierCfg.skip) return { ok: false, reason: `Skipping tier: ${tierName}` };
        const price      = Math.round(tierCfg.price_per_game * (order.quantity||1) * 100) / 100;
        const totalHours = tierCfg.hours_per_game * (order.quantity||1);
        if (price <= 0) return { ok: false, reason: 'Precio $0' };
        return { ok: true, price, totalHours, deliveryLabel: this._closestDeliveryOption(totalHours) };
      }

      return { ok: false, reason: 'Tipo desconocido: ' + order.type };
    } catch (e) {
      return { ok: false, reason: 'Error: ' + e.message };
    }
  }

  // Elige la opción del dropdown más cercana a las horas calculadas
  _closestDeliveryOption(hours) {
    let best = DELIVERY_OPTIONS[0];
    let minDiff = Math.abs(hours - best.hours);
    for (const opt of DELIVERY_OPTIONS) {
      const diff = Math.abs(hours - opt.hours);
      if (diff < minDiff) { minDiff = diff; best = opt; }
    }
    return best.label;
  }

  // ── Mandar oferta ──────────────────────────────────────────────────────────
  // Flujo real de Eldorado (según imágenes):
  //   1. Navegar a URL de la orden (p.ej. /boosting-request/UUID)
  //   2. Click botón "Create offer" (botón amarillo en la página de detalles)
  //   3. Modal aparece: llenar "Price $:" + seleccionar "Delivery time:" dropdown
  //   4. Click "Create offer" dentro del modal

  async _placeOffer(order, price, deliveryLabel, cfg) {
    try {
      if (!order.url) { this.log('warn', '[!] Sin URL de orden'); return false; }

      // ── 1. Navegar a la orden ─────────────────────────────────────────────
      this.log('info', `    → Navegando: ${order.url}`);
      await this._page.goto(order.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this._sleep(1000);

      // ── 2. Leer datos reales de la página (más fiable que el scraper) ─────
      const pageData = await this._page.evaluate(() => {
        const t = document.body.innerText || '';
        // Buscar "Completion Method\nDuo" o "Método de completado\nDuo"
        // En Eldorado el label y el valor están en líneas separadas
        const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
        let completionMethod = '';
        for (let i = 0; i < lines.length; i++) {
          if (/Completion Method|M[eé]todo de completado/i.test(lines[i])) {
            completionMethod = (lines[i+1] || '').trim();
            break;
          }
        }
        // Región
        let region = '';
        for (let i = 0; i < lines.length; i++) {
          if (/^Server$|^Servidor$|^Region$|^Región$/i.test(lines[i])) {
            region = (lines[i+1] || '').trim();
            break;
          }
        }
        // Rangos
        const rankNames = ['Iron','Bronze','Silver','Gold','Platinum','Diamond','Ascendant','Immortal','Radiant'];
        const rankRx = new RegExp('(' + rankNames.join('|') + ')\\s*(I{1,3}|\\d)?', 'i');
        let currentRank = '', desiredRank = '';
        for (let i = 0; i < lines.length; i++) {
          if (/Current Rank|Rango actual/i.test(lines[i]))   currentRank = (lines[i+1]||'').trim();
          if (/Desired Rank|Rango deseado/i.test(lines[i]))  desiredRank = (lines[i+1]||'').trim();
        }
        return { completionMethod, region, currentRank, desiredRank,
                 isDuo: /^duo$/i.test(completionMethod),
                 rawText: lines.slice(0,20).join(' | ') };
      });

      this.log('info', `    → Página: method="${pageData.completionMethod}" region="${pageData.region}" ${pageData.currentRank}→${pageData.desiredRank}`);

      // ── 3. Filtro Duo ─────────────────────────────────────────────────────
      if (pageData.isDuo && cfg.rank_boost?.completion_method?.Duo?.skip) {
        this.log('info', '    → SKIP: Duo no aceptado');
        return false;
      }

      // Actualizar order con datos reales de la página
      if (pageData.region)      order.region   = pageData.region;
      if (pageData.currentRank) order.rankFrom  = pageData.currentRank;
      if (pageData.desiredRank) order.rankTo    = pageData.desiredRank;
      if (pageData.isDuo)       order.isDuo     = true;

      // Recalcular precio con datos reales
      const recalc = this._calculatePrice(order, cfg);
      if (!recalc.ok) {
        this.log('info', `    → SKIP tras recalc: ${recalc.reason}`);
        return false;
      }
      const finalPrice = recalc.price;
      const finalDelivery = recalc.deliveryLabel;
      this.log('info', `    → Precio final: $${finalPrice} | entrega: ${finalDelivery}`);

      // ── 4. Click "Create offer" ───────────────────────────────────────────
      this.log('info', '    → Click "Create offer"...');
      try {
        await this._page.getByRole('button', { name: /create offer/i }).first().click({ timeout: 3500 });
      } catch (e) {
        // fallback text
        try { await this._page.locator('button').filter({ hasText: /create offer/i }).first().click({ timeout: 2000 }); }
        catch (e2) { this.log('warn', '    → No encontré botón Create offer'); return false; }
      }
      await this._sleep(600);

      // ── 5. Llenar precio ──────────────────────────────────────────────────
      // eld-numeric-input es un web component Angular. El <input> real está dentro.
      // Necesitamos hacer triple-click para seleccionar y luego type() carácter a carácter.
      this.log('info', `    → Precio: $${finalPrice}`);
      const priceStr = finalPrice.toFixed(2);
      let priceFilled = false;

      // Estrategia A: locator por placeholder o por posición en el modal
      const priceLocators = [
        this._page.locator('eld-numeric-input input').first(),
        this._page.locator('dialog input').first(),
        this._page.locator('[class*="place-boosting"] input').first(),
        this._page.locator('input[type="number"]').first(),
        this._page.locator('input[type="text"]').first(),
      ];

      for (const loc of priceLocators) {
        try {
          await loc.waitFor({ state: 'visible', timeout: 2000 });
          await loc.click({ clickCount: 3 }); // triple click para seleccionar todo
          await loc.type(priceStr, { delay: 50 }); // type() dispara keydown/keyup que Angular necesita
          await this._sleep(300);
          const val = await loc.inputValue();
          if (val && val !== '') { priceFilled = true; break; }
        } catch (e) {}
      }

      if (!priceFilled) {
        this.log('warn', '    → No pude llenar el precio');
        return false;
      }

      // ── 6. Seleccionar Delivery time ──────────────────────────────────────
      await this._sleep(300);
      await this._setDeliveryTime(finalDelivery);

      // ── 7. Confirmar oferta ───────────────────────────────────────────────
      await this._sleep(400);
      this.log('info', '    → Confirmando...');
      let confirmed = false;
      try {
        // El botón de submit en el modal — mismo texto "Create offer" pero dentro del dialog
        const submitBtn = this._page.locator('dialog button, [role="dialog"] button').filter({ hasText: /create offer/i });
        await submitBtn.first().click({ timeout: 4000 });
        confirmed = true;
      } catch (e) {
        try {
          await this._page.locator('button[type="submit"]').last().click({ timeout: 3000 });
          confirmed = true;
        } catch (e2) {}
      }

      if (!confirmed) { this.log('warn', '    → No encontré botón de confirmar'); return false; }

      await this._sleep(800);
      this.log('ok', `[OK] Oferta enviada $${finalPrice}`);

      // ── 8. Auto-chat ──────────────────────────────────────────────────────
      const chatCfg = cfg.chat_messages;
      if (chatCfg?.enabled && (chatCfg.messages?.length > 0 || chatCfg.images?.length > 0)) {
        await this._sleep(2500); // esperar que la página cargue tras enviar la oferta
        await this._sendChatMessage(order, cfg);
      }

      return true;

    } catch (err) {
      this.log('error', '[ERROR] placeOffer: ' + err.message);
      return false;
    } finally {
      await this._sleep(200);
      await this._page.goto(NOTIFICATIONS_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await this._sleep(400);
    }
  }

  // Seleccionar delivery time en el dropdown de Angular (eld-select / CDK overlay)
  async _setDeliveryTime(label) {
    // Mapa de labels internos → opciones reales que muestra Eldorado
    const optionMap = {
      '1 hour':   ['1 h', '1h', '1 hora', '60 min'],
      '2 hours':  ['2 h', '2h', '2 horas'],
      '4 hours':  ['3 h', '3h', '4 h', '4h', '5 h', '5h'],
      '8 hours':  ['8 h', '8h', '8 horas'],
      '12 hours': ['12 h', '12h', '12 horas'],
      '1 day':    ['1 día', '1 dia', '1 day', '24 h'],
      '2 days':   ['2 días', '2 dias', '2 days'],
      '3 days':   ['3 días', '3 dias', '3 days'],
      '5 days':   ['5 días', '5 dias', '5 days'],
      '7 days':   ['7 días', '7 dias', '7 days'],
    };
    const candidates = optionMap[label] || [label];

    try {
      // 1. Abrir el dropdown — click en el eld-select o en "Select an option"
      this.log('info', `    → Abriendo dropdown delivery (${label})`);
      let opened = false;

      // Intentar con el componente Angular directamente
      const triggerSelectors = [
        'eld-select',
        '[class*="select-trigger"]',
        '[class*="selectTrigger"]',
        'text=Select an option',
      ];
      for (const sel of triggerSelectors) {
        try {
          await this._page.locator(sel).first().click({ timeout: 2000 });
          await this._sleep(300);
          opened = true;
          break;
        } catch (e) {}
      }

      if (!opened) {
        // Tab desde el precio para moverse al select
        await this._page.keyboard.press('Tab');
        await this._sleep(200);
        await this._page.keyboard.press('Space');
        await this._sleep(250);
      }

      // 2. Esperar que aparezcan las opciones en el CDK overlay
      await this._sleep(400);

      // 3. Intentar click en cada candidato usando Playwright locators
      for (const candidate of candidates) {
        try {
          // Las opciones del CDK overlay aparecen como eld-option o [class*="option"]
          const optLoc = this._page.locator('eld-option, [class*="eld-option"], [role="option"]')
            .filter({ hasText: candidate });
          if (await optLoc.count() > 0) {
            await optLoc.first().click({ timeout: 2000 });
            this.log('info', `    → Entrega seleccionada: "${candidate}"`);
            return true;
          }
        } catch (e) {}
      }

      // 4. Fallback: ArrowDown suficientes veces y Enter
      this.log('warn', '    → Usando teclado para seleccionar entrega');
      // Calcular cuántos ArrowDown según el índice en la lista
      const deliveryOrder = ['20 min','1 h','2 h','3 h','5 h','8 h','12 h','1 día','2 días','3 días','7 días','14 días','28 días','45 días','60 días'];
      const bestMatch = candidates[0] || label;
      const idx = deliveryOrder.findIndex(o => candidates.some(c => o.toLowerCase().includes(c.toLowerCase())));
      const presses = Math.max(1, idx >= 0 ? idx + 1 : 1);
      for (let i = 0; i < presses; i++) {
        await this._page.keyboard.press('ArrowDown');
        await this._sleep(50);
      }
      await this._page.keyboard.press('Enter');
      return true;

    } catch (e) {
      this.log('warn', `    → Delivery error: ${e.message}`);
      return false;
    }
  }

  // Auto-chat: click "Chat with buyer" → esperar panel → escribir → enviar
  async _sendChatMessage(order, cfg) {
    try {
      const messages = cfg.chat_messages?.messages || [];
      const images   = cfg.chat_messages?.images   || [];
      if (!messages.length && !images.length) return;
      const text = messages.join('\n');

      // 1. Abrir chat
      this.log('info', '    → Abriendo chat con comprador...');
      let chatOpened = false;
      try {
        await this._page.getByRole('button', { name: /chat with buyer/i }).first().click({ timeout: 4000 });
        chatOpened = true;
      } catch (e) {
        try {
          await this._page.locator('button').filter({ hasText: /chat/i }).first().click({ timeout: 3000 });
          chatOpened = true;
        } catch (e2) {}
      }

      if (!chatOpened) { this.log('warn', '    → No encontré botón de chat'); return; }

      // El input ya queda enfocado al abrir el panel — NO hacer click otra vez
      await this._sleep(2500);

      // Pegar via clipboard (evita que la página interrumpa el tipo carácter a carácter)
      this.log('info', `    → Pegando mensaje via clipboard...`);
      await this._page.evaluate((msg) => {
        // Escribir al clipboard y luego pegar
        return navigator.clipboard.writeText(msg).catch(() => {
          // Fallback si clipboard API no disponible
          const el = document.activeElement;
          if (el) el.value = msg;
        });
      }, text);
      await this._sleep(300);
      await this._page.keyboard.press('Control+v');
      await this._sleep(800);

      // Enviar con Enter
      await this._page.keyboard.press('Enter');
      await this._sleep(500);


      await this._sleep(500);
      this.log('ok', '[OK] Mensaje de chat enviado ✓');

    } catch (e) {
      this.log('warn', `[!] Chat error: ${e.message}`);
    }
  }

  // ── Helpers de Playwright ──────────────────────────────────────────────────

  async _clickButton(selectors, timeout = 3000) {
    for (const sel of selectors) {
      try {
        await this._page.waitForSelector(sel, { timeout, state: 'visible' });
        await this._page.click(sel, { timeout });
        return true;
      } catch (e) {}
    }
    return false;
  }

  async _findElement(selectors, timeout = 3000) {
    for (const sel of selectors) {
      try {
        await this._page.waitForSelector(sel, { timeout, state: 'visible' });
        const el = await this._page.$(sel);
        if (el) return el;
      } catch (e) {}
    }
    return null;
  }

  // ── Discord ────────────────────────────────────────────────────────────────

  async _discordNotify(url, content) {
    if (!url) return;
    try {
      const fetch = require('node-fetch');
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Eldorado Bot', content }),
      });
    } catch (e) {}
  }

  // ── Chrome paths ───────────────────────────────────────────────────────────

  _chromeUserDataDir() {
    const p = process.platform;
    if (p === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    if (p === 'win32')  return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    return path.join(os.homedir(), '.config', 'google-chrome');
  }

  _copyLoginFromDefault(userDataDir, destDir) {
    const defaultDir = path.join(userDataDir, 'Default');
    if (!fs.existsSync(defaultDir)) return;
    for (const item of ['Cookies','Local Storage','Session Storage','Login Data','Preferences']) {
      const src = path.join(defaultDir, item);
      const dst = path.join(destDir, item);
      try {
        if (!fs.existsSync(src)) continue;
        if (fs.statSync(src).isDirectory()) {
          fs.mkdirSync(dst, { recursive: true });
          for (const f of fs.readdirSync(src)) {
            try { fs.copyFileSync(path.join(src, f), path.join(dst, f)); } catch (e) {}
          }
        } else {
          fs.copyFileSync(src, dst);
        }
      } catch (e) {}
    }
  }

  // ── Utils ──────────────────────────────────────────────────────────────────

  log(level, text) {
    const entry = { time: Date.now() / 1000, text, level };
    this._logs.push(entry);
    if (this._logs.length > MAX_LOGS) this._logs = this._logs.slice(-MAX_LOGS);
    this.io.emit('console:line', entry);
    console.log('[Bot] ' + text);
  }

  _setStatus(status) {
    this.status = status;
    this.io.emit('bot:status', {
      status,
      uptime: this.startTime ? (Date.now() - this.startTime) / 1000 : 0,
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = EldoradoBot;
