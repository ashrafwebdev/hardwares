#!/usr/bin/env node
'use strict';

// Hosted server: serves the web app and the API, and is the hub that desktops sync with.
//
//   PORT=8080 HOST=0.0.0.0 ERP_DATA_DIR=./data ERP_TERMINAL=WEB node bin/erp-server.js

const fs = require('node:fs');
const path = require('node:path');
const { createERP } = require('../src/core');
const { createApp } = require('../src/server/app');

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const dataDir = path.resolve(process.env.ERP_DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(dataDir, { recursive: true });

const erp = createERP({
  file: path.join(dataDir, 'erp.db'),
  terminalCode: process.env.ERP_TERMINAL || 'WEB',
});
const app = createApp({
  erp,
  webRoot: path.join(__dirname, '..', 'src', 'web'),
  backupDir: path.join(dataDir, 'backups'),
});

app.listen(port, host).then((actualPort) => {
  console.log(`Hardware ERP server listening on http://${host}:${actualPort}`);
  console.log(`Data file: ${path.join(dataDir, 'erp.db')}`);
});

async function shutdown() {
  await app.close();
  erp.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
