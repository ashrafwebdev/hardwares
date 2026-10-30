'use strict';

// Desktop shell (Electron main process).
//
// config.json lives in the app data folder and has two modes:
//   "local"  - runs the whole ERP on this computer with its own database.
//              Works with no network at all. To sync with a hosted server, open
//              Settings > Hosted server sync and enter the server address and a
//              device token. Leave it empty to stay offline.
//   "remote" - opens a hosted server in the window. Nothing is stored locally.
//
// The local server listens on 127.0.0.1 only, on a random free port.

const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createERP } = require('../src/core');
const { createApp } = require('../src/server/app');

const WEB_ROOT = path.join(__dirname, '..', 'src', 'web');
const DEFAULT_CONFIG = { mode: 'local', remoteUrl: '', terminalCode: 'P1', syncIntervalMs: 60000 };
const SYNC_INTERVAL_FLOOR_MS = 15000;

let mainWindow = null;
let runtime = null;
let quitting = false;

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(configPath())) {
    fs.writeFileSync(configPath(), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    return { ...DEFAULT_CONFIG };
  }
  const saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  const config = { ...DEFAULT_CONFIG, ...saved };
  config.syncIntervalMs = Math.max(Number(config.syncIntervalMs) || 0, SYNC_INTERVAL_FLOOR_MS);
  return config;
}

async function startLocalServer(config) {
  const dataDir = app.getPath('userData');
  const erp = createERP({
    file: path.join(dataDir, 'erp.db'),
    terminalCode: config.terminalCode,
  });
  const server = createApp({
    erp,
    webRoot: WEB_ROOT,
    autoSyncMs: config.syncIntervalMs,
    backupDir: path.join(dataDir, 'backups'),
    log: console,
  });
  const port = await server.listen(0, '127.0.0.1');
  return { erp, server, url: `http://127.0.0.1:${port}/` };
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Hardware ERP',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow.loadURL(url);
  // Links to other sites open in the normal browser, never inside the ERP window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// A second copy would open the same database file, so only one instance may run.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const config = loadConfig();
      if (config.mode === 'remote') {
        if (!config.remoteUrl) throw new Error('config.json needs a remoteUrl for remote mode.');
        createWindow(config.remoteUrl);
      } else {
        runtime = await startLocalServer(config);
        createWindow(runtime.url);
      }
    } catch (err) {
      dialog.showErrorBox('Hardware ERP could not start', err.message);
      app.quit();
    }
  });

  app.on('activate', () => {
    if (!mainWindow && runtime) createWindow(runtime.url);
  });

  // Stop the server and close the database cleanly before the process exits.
  app.on('before-quit', (event) => {
    if (!runtime || quitting) return;
    event.preventDefault();
    quitting = true;
    const { server, erp } = runtime;
    runtime = null;
    server.close()
      .catch((err) => console.error('Shutdown error:', err))
      .finally(() => {
        erp.close();
        app.quit();
      });
  });

  app.on('window-all-closed', () => app.quit());
}
