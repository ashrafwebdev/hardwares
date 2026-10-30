'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ERPError, ensure } = require('../core/util');
const { STATES, GST_RATE_OPTIONS } = require('../core/india');

const ALL = ['admin', 'manager', 'cashier'];
const MANAGE = ['admin', 'manager'];
const ADMIN = ['admin'];
const DEVICE = 'device';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 25 * 1024 * 1024;

function compile(pattern) {
  const names = [];
  const source = pattern.replace(/:([A-Za-z]+)/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${source}$`), names };
}

function buildRoutes(erp) {
  const routes = [];
  const add = (method, pattern, roles, handler) => {
    routes.push({ method, roles, handler, ...compile(pattern), pattern });
  };
  const by = (ctx) => ctx.user.username;
  const q = (ctx, key) => ctx.query.get(key) || undefined;

  // ---- setup, auth, general -------------------------------------------------
  // Lists the web app needs for dropdowns: Indian states and GST rate slabs.
  add('GET', '/api/meta', null, () => ({ states: STATES, gstRates: GST_RATE_OPTIONS }));
  add('GET', '/api/status', null, () => ({
    needsSetup: !erp.auth.hasUsers(),
    terminal: erp.terminal(),
    company: erp.settings.get('company_name'),
  }));
  add('POST', '/api/setup', null, ({ body }) => {
    ensure(!erp.auth.hasUsers(), 'Setup has already been completed', 409);
    erp.auth.createUser({ ...body, role: 'admin' });
    return erp.auth.login(body.username, body.password);
  });
  add('POST', '/api/auth/login', null, ({ body }) => erp.auth.login(body.username, body.password));
  add('POST', '/api/auth/logout', ALL, ({ token }) => { erp.auth.logout(token); return { ok: true }; });
  add('GET', '/api/me', ALL, ({ user }) => user);
  add('GET', '/api/dashboard', ALL, () => erp.reports.dashboard());
  add('GET', '/api/settings', ALL, () => erp.settings.all());
  add('PUT', '/api/settings', ADMIN, ({ body }) => erp.settings.save(body));

  // ---- master data ----------------------------------------------------------
  add('GET', '/api/warehouses', ALL, () => erp.master.listWarehouses());
  add('POST', '/api/warehouses', MANAGE, ({ body }) => erp.master.saveWarehouse(body));
  add('PUT', '/api/warehouses/:id', MANAGE, ({ params, body }) => erp.master.saveWarehouse({ ...body, id: params.id }));

  add('GET', '/api/categories', ALL, () => erp.master.listCategories());
  add('POST', '/api/categories', MANAGE, ({ body }) => erp.master.saveCategory(body));
  add('PUT', '/api/categories/:id', MANAGE, ({ params, body }) => erp.master.saveCategory({ ...body, id: params.id }));
  add('DELETE', '/api/categories/:id', MANAGE, ({ params }) => erp.master.removeCategory(params.id));

  add('GET', '/api/products', ALL, (ctx) => erp.master.listProducts({
    q: ctx.query.get('q') || '',
    categoryId: q(ctx, 'categoryId'),
    supplierId: q(ctx, 'supplierId'),
    includeInactive: ctx.query.get('all') === '1',
    lowStock: ctx.query.get('lowStock') === '1',
  }));
  add('GET', '/api/products/code/:code', ALL, ({ params }) => {
    const product = erp.master.findProductByCode(params.code);
    ensure(product, 'Product not found', 404);
    return product;
  });
  add('GET', '/api/products/:id', ALL, ({ params }) => erp.master.getProduct(params.id));
  add('POST', '/api/products', MANAGE, ({ body }) => erp.master.saveProduct(body));
  add('PUT', '/api/products/:id', MANAGE, ({ params, body }) => erp.master.saveProduct({ ...body, id: params.id }));

  add('GET', '/api/customers', ALL, (ctx) => erp.master.listCustomers({
    q: ctx.query.get('q') || '', includeInactive: ctx.query.get('all') === '1',
  }));
  add('GET', '/api/customers/:id', ALL, ({ params }) => erp.reports.customerStatement(params.id));
  add('POST', '/api/customers', ALL, ({ body }) => erp.master.saveCustomer(body));
  add('PUT', '/api/customers/:id', MANAGE, ({ params, body }) => erp.master.saveCustomer({ ...body, id: params.id }));

  add('GET', '/api/suppliers', MANAGE, (ctx) => erp.master.listSuppliers({
    q: ctx.query.get('q') || '', includeInactive: ctx.query.get('all') === '1',
  }));
  add('GET', '/api/suppliers/:id', MANAGE, ({ params }) => erp.reports.supplierStatement(params.id));
  add('POST', '/api/suppliers', MANAGE, ({ body }) => erp.master.saveSupplier(body));
  add('PUT', '/api/suppliers/:id', MANAGE, ({ params, body }) => erp.master.saveSupplier({ ...body, id: params.id }));

  // ---- inventory ------------------------------------------------------------
  add('GET', '/api/inventory/levels', ALL, (ctx) => erp.inventory.stockLevels({
    warehouseId: q(ctx, 'warehouseId'), q: ctx.query.get('q') || '', lowOnly: ctx.query.get('lowOnly') === '1',
  }));
  add('GET', '/api/inventory/low-stock', ALL, () => erp.inventory.lowStockItems());
  add('GET', '/api/inventory/movements', MANAGE, (ctx) => erp.inventory.listMovements({
    productId: q(ctx, 'productId'), warehouseId: q(ctx, 'warehouseId'),
  }));
  add('POST', '/api/inventory/adjust', MANAGE, (ctx) => erp.inventory.adjustStock({ ...ctx.body, by: by(ctx) }));
  add('POST', '/api/inventory/transfer', MANAGE, ({ body }) => erp.inventory.transferStock(body));

  // ---- sales ----------------------------------------------------------------
  const listParams = (ctx) => ({
    customerId: q(ctx, 'customerId'),
    from: q(ctx, 'from'),
    to: q(ctx, 'to'),
    q: ctx.query.get('q') || '',
  });
  add('GET', '/api/sales', ALL, (ctx) => erp.sales.listSales({ type: 'invoice', ...listParams(ctx) }));
  add('POST', '/api/sales', ALL, (ctx) => erp.sales.createSale({ ...ctx.body, by: by(ctx) }));
  add('GET', '/api/sales/:id', ALL, ({ params }) => erp.sales.getSale(params.id));
  add('POST', '/api/sales/:id/return', ALL, (ctx) => erp.sales.createReturn({ ...ctx.body, invoiceId: ctx.params.id, by: by(ctx) }));
  add('GET', '/api/returns', ALL, (ctx) => erp.sales.listSales({ type: 'return', ...listParams(ctx) }));
  add('GET', '/api/quotes', ALL, (ctx) => erp.sales.listSales({ type: 'quote', ...listParams(ctx) }));
  add('POST', '/api/quotes', ALL, (ctx) => erp.sales.createQuote({ ...ctx.body, by: by(ctx) }));
  add('POST', '/api/quotes/:id/convert', ALL, (ctx) => erp.sales.convertQuote(ctx.params.id, { ...ctx.body, by: by(ctx) }));
  add('POST', '/api/quotes/:id/cancel', ALL, ({ params }) => erp.sales.cancelQuote(params.id));

  // ---- purchasing -----------------------------------------------------------
  add('GET', '/api/purchases', MANAGE, (ctx) => erp.purchasing.listPurchases({
    status: q(ctx, 'status'), supplierId: q(ctx, 'supplierId'), q: ctx.query.get('q') || '',
  }));
  add('POST', '/api/purchases', MANAGE, (ctx) => erp.purchasing.savePurchase({ ...ctx.body, by: by(ctx) }));
  add('GET', '/api/purchases/:id', MANAGE, ({ params }) => erp.purchasing.getPurchase(params.id));
  add('PUT', '/api/purchases/:id', MANAGE, (ctx) => erp.purchasing.savePurchase({ ...ctx.body, id: ctx.params.id }));
  add('POST', '/api/purchases/:id/order', MANAGE, ({ params }) => erp.purchasing.markOrdered(params.id));
  add('POST', '/api/purchases/:id/receive', MANAGE, (ctx) => erp.purchasing.receivePurchase(ctx.params.id, { ...ctx.body, by: by(ctx) }));
  add('POST', '/api/purchases/:id/cancel', MANAGE, ({ params }) => erp.purchasing.cancelPurchase(params.id));

  // ---- money ----------------------------------------------------------------
  add('GET', '/api/payments', MANAGE, (ctx) => erp.finance.listPayments({
    partyType: q(ctx, 'partyType'), partyId: q(ctx, 'partyId'), from: q(ctx, 'from'), to: q(ctx, 'to'),
  }));
  add('POST', '/api/payments/receive', ALL, (ctx) => erp.finance.receiveFromCustomer({ ...ctx.body, by: by(ctx) }));
  add('POST', '/api/payments/refund', MANAGE, (ctx) => erp.finance.refundCustomer({ ...ctx.body, by: by(ctx) }));
  add('POST', '/api/payments/pay-supplier', MANAGE, (ctx) => erp.finance.paySupplier({ ...ctx.body, by: by(ctx) }));
  add('GET', '/api/expenses', MANAGE, (ctx) => erp.finance.listExpenses({ from: q(ctx, 'from'), to: q(ctx, 'to') }));
  add('POST', '/api/expenses', MANAGE, (ctx) => erp.finance.addExpense({ ...ctx.body, by: by(ctx) }));
  add('DELETE', '/api/expenses/:id', MANAGE, ({ params }) => erp.finance.removeExpense(params.id));

  // ---- reports --------------------------------------------------------------
  add('GET', '/api/reports/sales', MANAGE, (ctx) => erp.reports.salesSummary({
    from: q(ctx, 'from'), to: q(ctx, 'to'), groupBy: q(ctx, 'groupBy'),
  }));
  add('GET', '/api/reports/top-products', MANAGE, (ctx) => erp.reports.topProducts({ from: q(ctx, 'from'), to: q(ctx, 'to') }));
  add('GET', '/api/reports/profit', MANAGE, (ctx) => erp.reports.profitAndLoss({ from: q(ctx, 'from'), to: q(ctx, 'to') }));
  add('GET', '/api/reports/gst', MANAGE, (ctx) => erp.reports.gstReturn({ from: q(ctx, 'from'), to: q(ctx, 'to') }));
  add('GET', '/api/reports/valuation', MANAGE, () => erp.reports.stockValuation());
  add('GET', '/api/reports/receivables', MANAGE, () => erp.reports.receivables());
  add('GET', '/api/reports/payables', MANAGE, () => erp.reports.payables());

  // ---- administration -------------------------------------------------------
  add('GET', '/api/users', ADMIN, () => erp.auth.listUsers());
  add('POST', '/api/users', ADMIN, ({ body }) => erp.auth.createUser(body));
  add('PUT', '/api/users/:id', ADMIN, ({ params, body }) => erp.auth.updateUser(params.id, body));
  add('GET', '/api/admin/backup', ADMIN, ({ backupDir }) => {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(backupDir, `erp-backup-${stamp}.db`);
    erp.backupTo(file);
    return { __download: file, filename: path.basename(file) };
  });

  // ---- sync -----------------------------------------------------------------
  add('GET', '/api/sync/status', ADMIN, () => erp.sync.status());
  add('PUT', '/api/sync/config', ADMIN, ({ body }) => erp.sync.saveConfig(body));
  add('POST', '/api/sync/now', ADMIN, async () => {
    try {
      return await erp.sync.run();
    } catch (err) {
      throw new ERPError(`Sync failed: ${err.message}`, 502);
    }
  });
  add('GET', '/api/sync/devices', ADMIN, () => erp.auth.listDevices());
  add('POST', '/api/sync/devices', ADMIN, ({ body }) => erp.auth.createDevice(body.name));
  add('DELETE', '/api/sync/devices/:id', ADMIN, ({ params }) => { erp.auth.revokeDevice(params.id); return { ok: true }; });
  // Used by other machines, authenticated with a device token.
  add('POST', '/api/sync/push', DEVICE, ({ body }) => ({ results: erp.sync.applyPush(body.changes) }));
  add('GET', '/api/sync/pull', DEVICE, (ctx) => erp.sync.pullChanges(
    Number(ctx.query.get('cursor') || 0),
    Number(ctx.query.get('limit') || 200),
  ));

  return routes;
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ERPError('Request body is too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ERPError('Request body is not valid JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendError(res, err, log) {
  if (err instanceof ERPError) return sendJson(res, err.status, { error: err.message });
  log.error(err);
  return sendJson(res, 500, { error: 'Internal server error' });
}

function createApp({ erp, webRoot, autoSyncMs = 0, backupDir = path.join(os.tmpdir(), 'hardware-erp-backups'), log = console }) {
  const routes = buildRoutes(erp);
  const root = path.resolve(webRoot);

  async function handleApi(req, res, url) {
    const path_ = url.pathname;
    const candidates = routes.filter((r) => r.regex.test(path_));
    if (!candidates.length) return sendJson(res, 404, { error: 'Not found' });
    const route = candidates.find((r) => r.method === req.method);
    if (!route) return sendJson(res, 405, { error: 'Method not allowed' });

    const token = bearerToken(req);
    let user = null;
    if (route.roles === DEVICE) {
      if (!erp.auth.deviceFromToken(token)) return sendJson(res, 401, { error: 'Invalid device token' });
    } else if (route.roles) {
      user = erp.auth.userFromToken(token);
      if (!user) return sendJson(res, 401, { error: 'Please sign in' });
      if (!route.roles.includes(user.role)) return sendJson(res, 403, { error: 'Your role cannot do this' });
    }

    const match = route.regex.exec(path_);
    const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
    const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    const result = await route.handler({ params, query: url.searchParams, body, user, token, backupDir });

    if (result && result.__download) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${result.filename}"`,
      });
      fs.createReadStream(result.__download).pipe(res);
      return undefined;
    }
    return sendJson(res, 200, result === undefined ? { ok: true } : result);
  }

  function serveStatic(res, url) {
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return sendJson(res, 404, { error: 'Not found' });
      const headers = {
        'content-type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      };
      if (file.endsWith('.html')) headers['content-security-policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const work = url.pathname.startsWith('/api/')
      ? handleApi(req, res, url)
      : Promise.resolve(serveStatic(res, url));
    work.catch((err) => sendError(res, err, log));
  });

  let timer = null;
  let running = false;
  if (autoSyncMs > 0) {
    timer = setInterval(() => {
      if (running || !erp.sync.config()) return;
      running = true;
      erp.sync.run().catch((err) => log.warn(`Background sync failed: ${err.message}`)).finally(() => { running = false; });
    }, autoSyncMs);
    timer.unref();
  }

  return {
    server,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      if (timer) clearInterval(timer);
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createApp, buildRoutes };
