const express = require('express');
const http = require('http');
const { Server: IO } = require('socket.io');
const cors = require('cors');
const path = require('path');

const config = require('./config');
const { createRouter } = require('./api');
const EldoradoBot = require('./bot');

let httpServer = null;
let io = null;
let bot = null;

async function startServer(port) {
  await config.init();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'ui')));

  // Serve chat images
  app.use('/chat-images', express.static(path.join(__dirname, '..', 'data', 'chat_images')));

  httpServer = http.createServer(app);
  io = new IO(httpServer, { cors: { origin: '*' } });

  bot = new EldoradoBot(io, config);

  app.use('/api', createRouter(bot, config, io));

  io.on('connection', socket => {
    socket.emit('snapshot', bot.getSnapshot());
    socket.on('disconnect', () => {});
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', () => {
      console.log('[Server] http://127.0.0.1:' + port);
      resolve();
    });
    httpServer.on('error', reject);
  });
}

async function stopServer() {
  if (bot) await bot.stop().catch(() => {});
  if (httpServer) await new Promise(r => httpServer.close(r));
}

module.exports = { startServer, stopServer };
