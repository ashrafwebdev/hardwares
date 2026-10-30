'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createERP } = require('../src/core');
const { createApp } = require('../src/server/app');

const WEB_ROOT = path.join(__dirname, '..', 'src', 'web');
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-backups-'));
const erp = createERP({ terminalCode: 'WEB' });
const app = createApp({ erp, webRoot: WEB_ROOT, backupDir });
let base;

before(async () => {
  base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
});

after(async () => {
  await app.close();
  erp.close();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

async function call(method, route, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('json') ? await response.json() : null;
  return { status: response.status, data, response };
}

test('the first run asks for setup, and setup can only happen once', async () => {
  const status = await call('GET', '/api/status');
  assert.equal(status.data.needsSetup, true);

  const created = await call('POST', '/api/setup', {
    body: { username: 'owner', name: 'Owner', password: 'secret123' },
  });
  assert.equal(created.status, 200);
  assert.ok(created.data.token);

  const again = await call('POST', '/api/setup', { body: { username: 'other', password: 'secret123' } });
  assert.equal(again.status, 409);
});

test('login rejects a wrong password and accepts the right one', async () => {
  const wrong = await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'nope' } });
  assert.equal(wrong.status, 401);
  const right = await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'secret123' } });
  assert.equal(right.status, 200);
  assert.equal(right.data.user.role, 'admin');
});

test('API routes require a signed-in user', async () => {
  const response = await call('GET', '/api/products');
  assert.equal(response.status, 401);
});

test('cashiers can sell but cannot change products or see reports', async () => {
  const owner = (await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'secret123' } })).data.token;
  const made = await call('POST', '/api/users', {
    token: owner, body: { username: 'till1', name: 'Till', role: 'cashier', password: 'secret123' },
  });
  assert.equal(made.status, 200);
  const cashier = (await call('POST', '/api/auth/login', { body: { username: 'till1', password: 'secret123' } })).data.token;

  const newProduct = await call('POST', '/api/products', {
    token: cashier, body: { sku: 'NO-1', name: 'Blocked', price: 1, cost: 1 },
  });
  assert.equal(newProduct.status, 403);

  const profit = await call('GET', '/api/reports/profit', { token: cashier });
  assert.equal(profit.status, 403);

  const users = await call('GET', '/api/users', { token: cashier });
  assert.equal(users.status, 403);
});

test('a sale made over the API updates stock and returns the receipt', async () => {
  const owner = (await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'secret123' } })).data.token;
  const product = await call('POST', '/api/products', {
    token: owner, body: { sku: 'API-1', barcode: '999', name: 'Brush', price: 250, cost: 100, tax_rate: 0 },
  });
  assert.equal(product.status, 200);
  const wh = (await call('GET', '/api/warehouses', { token: owner })).data[0];
  await call('POST', '/api/inventory/adjust', {
    token: owner, body: { productId: product.data.id, warehouseId: wh.id, countedQty: 10 },
  });

  const byCode = await call('GET', '/api/products/code/999', { token: owner });
  assert.equal(byCode.data.name, 'Brush');

  const sale = await call('POST', '/api/sales', {
    token: owner, body: { lines: [{ productId: product.data.id, qty: 3 }], payments: [{ method: 'cash', amount: 750 }] },
  });
  assert.equal(sale.status, 200);
  assert.equal(sale.data.total, 750);
  assert.equal(sale.data.due, 0);
  assert.equal(sale.data.created_by, 'owner', 'the signed-in user is recorded on the document');

  const levels = await call('GET', '/api/products/' + product.data.id, { token: owner });
  assert.equal(levels.data.stock, 7);
});

test('a bad request gets a clear message, not a server error', async () => {
  const owner = (await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'secret123' } })).data.token;
  const response = await call('POST', '/api/sales', { token: owner, body: { lines: [] } });
  assert.equal(response.status, 400);
  assert.equal(response.data.error, 'Add at least one item');

  const unknown = await call('GET', '/api/products/does-not-exist', { token: owner });
  assert.equal(unknown.status, 404);

  const badJson = await fetch(`${base}/api/sales`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` },
    body: '{not json',
  });
  assert.equal(badJson.status, 400);
});

test('the web app is served and paths outside it are refused', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Hardware ERP/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);

  const escape = await fetch(`${base}/..%2Fpackage.json`);
  assert.notEqual(escape.status, 200);
});

test('the owner can download a backup that opens as a database', async () => {
  const owner = (await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'secret123' } })).data.token;
  const response = await fetch(`${base}/api/admin/backup`, { headers: { authorization: `Bearer ${owner}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /erp-backup-.*\.db/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
});
