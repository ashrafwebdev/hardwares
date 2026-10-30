'use strict';

const { openDatabase, createTx } = require('./db');
const { createRepo } = require('./repo');
const { createSettings } = require('./settings');
const { createAuth } = require('./auth');
const { createMaster } = require('./master');
const { createInventory } = require('./inventory');
const { createSales } = require('./sales');
const { createPurchasing } = require('./purchasing');
const { createFinance } = require('./finance');
const { createReports } = require('./reports');
const { createSync } = require('./sync');
const { nowIso, localDate } = require('./util');
const { financialYear } = require('./india');

// Fixed id so every machine seeds the same warehouse and their stock lines up.
const DEFAULT_WAREHOUSE_ID = 'wh-main';

function createKv(db) {
  return {
    get(key) {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
      return row ? row.value : null;
    },
    set(key, value) {
      db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(value));
    },
    delete(key) {
      db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    },
  };
}

// Open the shop database and wire every module together.
// file: path to the SQLite file, or ':memory:' for tests.
// terminalCode: up to 3 characters used in document numbers (e.g. P1, WEB). Unique per machine.
function createERP({ file = ':memory:', terminalCode } = {}) {
  const db = openDatabase(file);
  const tx = createTx(db);
  const repo = createRepo(db);
  const kv = createKv(db);
  if (terminalCode) kv.set('terminal_code', terminalCode);

  // Up to 3 letters or digits. Keeps numbers like C-SHP/26-27/0001 within GST's 16-character limit.
  const terminal = () => (kv.get('terminal_code') || 'SHP').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3) || 'SHP';

  // Numbers restart each financial year (April to March) and are unique per terminal:
  // SHP/26-27/00001. prefix is '' for invoices, 'C-' for credit notes, and so on.
  function nextNumber(prefix, date = localDate(), width = 4) {
    const fy = financialYear(date);
    const key = `${terminal()}|${prefix}|${fy}`;
    db.prepare('INSERT INTO sequences (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1').run(key);
    const { value } = db.prepare('SELECT value FROM sequences WHERE key = ?').get(key);
    return `${prefix}${terminal()}/${fy}/${String(value).padStart(width, '0')}`;
  }

  tx(() => {
    if (!db.prepare('SELECT 1 FROM warehouses WHERE deleted = 0 LIMIT 1').get()) {
      repo.save('warehouses', { id: DEFAULT_WAREHOUSE_ID, code: 'MAIN', name: 'Main Store', active: 1, created_at: nowIso() });
    }
  });

  const settings = createSettings({ repo });
  const ctx = { db, repo, tx, kv, nextNumber, settings };
  const auth = createAuth({ db });
  const inventory = createInventory(ctx);
  const master = createMaster({ ...ctx, inventory });
  const sales = createSales({ ...ctx, inventory });
  const purchasing = createPurchasing({ ...ctx, inventory });
  const finance = createFinance(ctx);
  const reports = createReports({ db, repo, inventory, sales });
  const sync = createSync({ db, repo, tx, kv });

  return {
    db,
    tx,
    repo,
    kv,
    auth,
    settings,
    master,
    inventory,
    sales,
    purchasing,
    finance,
    reports,
    sync,
    terminal,
    backupTo(target) {
      db.exec(`VACUUM INTO '${String(target).replace(/'/g, "''")}'`);
    },
    close() {
      db.close();
    },
  };
}

module.exports = { createERP, DEFAULT_WAREHOUSE_ID };
