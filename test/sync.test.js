'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createERP } = require('../src/core');
const { createApp } = require('../src/server/app');

const WEB_ROOT = path.join(__dirname, '..', 'src', 'web');
const hub = createERP({ terminalCode: 'HUB' });
const hubApp = createApp({ erp: hub, webRoot: WEB_ROOT, backupDir: path.join(require('node:os').tmpdir(), 'erp-test-backups') });
let base;
let token;

const serverReady = hubApp.listen(0, '127.0.0.1').then((port) => {
  base = `http://127.0.0.1:${port}`;
  token = hub.auth.createDevice('Test desktop').token;
});

after(async () => {
  await hubApp.close();
  hub.close();
});

async function desktop(terminalCode) {
  await serverReady;
  const erp = createERP({ terminalCode });
  erp.kv.set('sync_url', base);
  erp.kv.set('sync_token', token);
  return erp;
}

test('a desktop sends its data to the hub and the hub hands it to a second desktop', async () => {
  const a = await desktop('POS1');
  const b = await desktop('POS2');
  try {
    const wh = a.master.listWarehouses()[0];
    const p = a.master.saveProduct({ sku: 'SYNC-1', name: 'Saw', price: 4000, cost: 2500, tax_rate: 0 });
    a.inventory.adjustStock({ productId: p.id, warehouseId: wh.id, countedQty: 7 });
    const sale = a.sales.createSale({ lines: [{ productId: p.id, qty: 2 }], payments: [{ amount: 8000 }] });
    a.settings.save({ company_name: 'Synced Shop' });

    const sent = await a.sync.run();
    assert.ok(sent.pushed > 0);
    assert.equal(a.sync.pendingCount(), 0);
    assert.equal(hub.master.getProduct(p.id).stock, 5);

    await b.sync.run();
    assert.equal(b.master.getProduct(p.id).name, 'Saw');
    assert.equal(b.inventory.totalStock(p.id), 5);
    assert.equal(b.settings.get('company_name'), 'Synced Shop');
    assert.equal(b.sales.getSale(sale.id).number, sale.number);
  } finally {
    a.close();
    b.close();
  }
});

test('when two machines edit the same record, the later edit wins', async () => {
  const a = await desktop('POS3');
  const b = await desktop('POS4');
  try {
    const p = a.master.saveProduct({ sku: 'LWW-1', name: 'Hammer', price: 1000, cost: 500, tax_rate: 0 });
    await a.sync.run();
    await b.sync.run();

    a.master.saveProduct({ id: p.id, sku: 'LWW-1', name: 'Hammer', price: 1100 });
    await new Promise((r) => setTimeout(r, 5));
    b.master.saveProduct({ id: p.id, sku: 'LWW-1', name: 'Hammer', price: 1200 });

    await a.sync.run();
    await b.sync.run();
    await a.sync.run();

    assert.equal(hub.master.getProduct(p.id).price, 1200);
    assert.equal(a.master.getProduct(p.id).price, 1200, 'the first machine adopts the winning edit');
    assert.equal(b.master.getProduct(p.id).price, 1200);
  } finally {
    a.close();
    b.close();
  }
});

test('an edit made on the hub reaches a desktop on its next sync', async () => {
  const a = await desktop('POS5');
  try {
    const p = hub.master.saveProduct({ sku: 'HUB-1', name: 'Nail box', price: 300, cost: 200, tax_rate: 0 });
    await a.sync.run();
    assert.equal(a.master.getProduct(p.id).name, 'Nail box');
    hub.master.saveProduct({ id: p.id, sku: 'HUB-1', name: 'Nail box', price: 350 });
    await a.sync.run();
    assert.equal(a.master.getProduct(p.id).price, 350);
  } finally {
    a.close();
  }
});

test('a desktop with no connection keeps working and queues its changes', async () => {
  const offline = createERP({ terminalCode: 'OFF1' });
  try {
    offline.kv.set('sync_url', 'http://127.0.0.1:9');
    offline.kv.set('sync_token', 'dev_nope');
    const p = offline.master.saveProduct({ sku: 'OFF-1', name: 'Offline item', price: 100, cost: 50, tax_rate: 0 });
    assert.equal(p.name, 'Offline item');
    await assert.rejects(offline.sync.run());
    const status = offline.sync.status();
    assert.ok(status.last_error, 'the error is recorded for the settings screen');
    assert.ok(status.pending > 0, 'changes wait until the server is reachable');
  } finally {
    offline.close();
  }
});

test('an invalid device token is refused by the sync endpoints', async () => {
  await serverReady;
  const response = await fetch(`${base}/api/sync/pull?cursor=0`, { headers: { authorization: 'Bearer dev_wrong' } });
  assert.equal(response.status, 401);
});

test('a revoked device can no longer sync', async () => {
  await serverReady;
  const device = hub.auth.createDevice('Old counter');
  hub.auth.revokeDevice(device.id);
  const response = await fetch(`${base}/api/sync/pull?cursor=0`, { headers: { authorization: `Bearer ${device.token}` } });
  assert.equal(response.status, 401);
});
