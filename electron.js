const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');

const PORT = 8477;
let mainWindow = null;

// Capturar errores no manejados y mostrarlos en un dialog (crucial para debug en .exe)
process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Error fatal', err.stack || err.message);
  app.quit();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 860,
    minHeight: 580,
    frame: false,
    backgroundColor: '#0c0f14',
    icon: path.join(__dirname, 'ui', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

ipcMain.on('win-minimize',  () => mainWindow && mainWindow.minimize());
ipcMain.on('win-maximize',  () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close',     () => app.quit());
ipcMain.on('open-external', (_, url) => shell.openExternal(url));
ipcMain.handle('get-port',  () => PORT);

app.whenReady().then(async () => {
  try {
    const { startServer } = require('./server/index');
    await startServer(PORT);
    createWindow();
  } catch (err) {
    dialog.showErrorBox('Error al iniciar servidor', err.stack || err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  try {
    const { stopServer } = require('./server/index');
    await stopServer();
  } catch (e) {}
});
