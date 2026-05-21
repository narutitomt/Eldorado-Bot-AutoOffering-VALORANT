const express = require('express');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');

function createRouter(bot, config, io) {
  const r = express.Router();

  // ── Config ─────────────────────────────────────────────────────────────────
  r.get('/config', (_, res) => res.json(config.get()));
  r.post('/config', (req, res) => {
    try {
      const updated = config.update(req.body);
      io.emit('config:updated', updated);
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, msg: e.message });
    }
  });

  // ── Bot control ─────────────────────────────────────────────────────────────
  r.post('/bot/start', async (req, res) => {
    try {
      await bot.start();
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, msg: e.message });
    }
  });

  r.post('/bot/stop', async (req, res) => {
    try {
      await bot.stop();
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, msg: e.message });
    }
  });

  r.post('/bot/input', (req, res) => {
    bot.sendInput(req.body.text || '');
    res.json({ ok: true });
  });

  // ── Console stream ──────────────────────────────────────────────────────────
  r.get('/console', (req, res) => {
    const since = parseFloat(req.query.since) || 0;
    res.json(bot.getConsoleLines(since));
  });

  // ── Stats ───────────────────────────────────────────────────────────────────
  r.get('/stats', (_, res) => res.json(config.getStats()));

  // ── Activity ────────────────────────────────────────────────────────────────
  r.get('/activity', (_, res) => res.json(config.getActivity()));

  // ── Chat images ─────────────────────────────────────────────────────────────
  r.get('/chat-images', (_, res) => {
    const cfg = config.get();
    const images = (cfg.chat_messages?.images || []).map(p => {
      const fullPath = p.startsWith('chat_images/')
        ? path.join(DATA_DIR, p)
        : p;
      return {
        path: p,
        name: path.basename(p),
        exists: fs.existsSync(fullPath),
      };
    });
    res.json({ images });
  });

  r.post('/chat-images/upload', async (req, res) => {
    try {
      const { filename, data } = req.body;
      if (!filename || !data) return res.json({ ok: false, msg: 'Missing filename or data' });
      const imgDir = path.join(DATA_DIR, 'chat_images');
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const dest = path.join(imgDir, safeName);
      fs.writeFileSync(dest, Buffer.from(data, 'base64'));
      const relPath = 'chat_images/' + safeName;
      const cfg = config.get();
      cfg.chat_messages = cfg.chat_messages || {};
      cfg.chat_messages.images = [relPath];
      config.update(cfg);
      res.json({ ok: true, path: relPath });
    } catch (e) {
      res.json({ ok: false, msg: e.message });
    }
  });

  r.post('/chat-images/remove', (req, res) => {
    try {
      const { path: imgPath } = req.body;
      const cfg = config.get();
      cfg.chat_messages.images = (cfg.chat_messages.images || []).filter(p => p !== imgPath);
      config.update(cfg);
      // Try to delete file
      if (imgPath.startsWith('chat_images/')) {
        const fullPath = path.join(DATA_DIR, imgPath);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      }
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, msg: e.message });
    }
  });

  // ── Discord ──────────────────────────────────────────────────────────────────
  r.post('/discord-test', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ ok: false, msg: 'No URL' });
    try {
      const fetch = require('node-fetch');
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Eldorado Bot',
          content: '✅ **Test notification** — your Discord webhook is working correctly!',
        }),
      });
      if (resp.ok || resp.status === 204) {
        res.json({ ok: true });
      } else {
        res.json({ ok: false, msg: 'HTTP ' + resp.status });
      }
    } catch (e) {
      res.json({ ok: false, msg: e.message });
    }
  });

  // ── License (stub — no license system needed) ──────────────────────────────
  r.get('/license', (_, res) => {
    res.json({ expires: '—', user: 'local', plan: 'full' });
  });

  return r;
}

module.exports = { createRouter };
