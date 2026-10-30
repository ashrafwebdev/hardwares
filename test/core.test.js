'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createERP } = require('../src/core');

let erp;
let warehouseId;

beforeEach(() => {
  erp = createERP({ terminalCode: 'T1' });
  warehouseId = erp.master.listWarehouses()[0].id;
});
afterEach(() => erp.close());

function product(overrides = {}) {
  return erp.master.saveProduct({
    sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test item',
    price: 1000,
    cost: 600,
    tax_rate: 0,
    ...overrides,
  });
}

function stock(p, qty) {
  erp.inventory.adjustStock({ productId: p.id, warehouseId, countedQty: qty });
}

test('a new database has one default warehouse with a fixed id', () => {
  assert.equal(erp.master.listWarehouses().length, 1);
  assert.equal(erp.master.listWarehouses()[0].id, 'wh-main');
});

test('money is computed in integer cents with tax and discount', () => {
  const p = product({ price: 1500, tax_rate: 10 });
  stock(p, 10);
  const sale = erp.sales.createSale({
    lines: [{ productId: p.id, qty: 2, discountPct: 10 }],
    payments: [{ method: 'cash', amount: 2970 }],
  });
  // 2 x 1500 with 10% off = 2700 net, 270 tax, 2970 total.
  assert.equal(sale.subtotal, 2700);
  assert.equal(sale.tax_total, 270);
  assert.equal(sale.total, 2970);
  assert.equal(sale.due, 0);
  assert.equal(sale.number, 'T1-INV-000001');
});

test('cannot sell more than is on hand, unless negative stock is allowed', () => {
  const p = product();
  stock(p, 2);
  assert.throws(
    () => erp.sales.createSale({ lines: [{ productId: p.id, qty: 3 }], payments: [{ amount: 3000 }] }),
    /Not enough stock/,
  );
  assert.equal(erp.inventory.totalStock(p.id), 2, 'failed sale must not move stock');

  erp.settings.save({ allow_negative_stock: true });
  erp.sales.createSale({ lines: [{ productId: p.id, qty: 3 }], payments: [{ amount: 3000 }] });
  assert.equal(erp.inventory.totalStock(p.id), -1);
});

test('credit sales need a customer with a credit limit and respect it', () => {
  const p = product({ price: 1000 });
  stock(p, 10);
  assert.throws(
    () => erp.sales.createSale({ lines: [{ productId: p.id, qty: 1 }], payments: [] }),
    /Select a customer/,
  );
  const plain = erp.master.saveCustomer({ name: 'No credit' });
  assert.throws(
    () => erp.sales.createSale({ customerId: plain.id, lines: [{ productId: p.id, qty: 1 }], payments: [] }),
    /not approved for credit/,
  );
  const ali = erp.master.saveCustomer({ name: 'Ali', credit_limit: 2500 });
  erp.sales.createSale({ customerId: ali.id, lines: [{ productId: p.id, qty: 2 }], payments: [] });
  assert.equal(erp.master.getCustomer(ali.id).balance, 2000);
  assert.throws(
    () => erp.sales.createSale({ customerId: ali.id, lines: [{ productId: p.id, qty: 1 }], payments: [] }),
    /Credit limit exceeded/,
  );
});

test('receipts reduce the customer balance and cannot overpay', () => {
  const p = product({ price: 1000 });
  stock(p, 5);
  const ali = erp.master.saveCustomer({ name: 'Ali', credit_limit: 10000 });
  erp.sales.createSale({ customerId: ali.id, lines: [{ productId: p.id, qty: 3 }], payments: [] });
  erp.finance.receiveFromCustomer({ customerId: ali.id, amount: 1000, method: 'cash' });
  assert.equal(erp.master.getCustomer(ali.id).balance, 2000);
  assert.throws(() => erp.finance.receiveFromCustomer({ customerId: ali.id, amount: 5000 }), /more than the balance/);
});

test('returns restock the item, reduce what the customer owes and respect quantities already returned', () => {
  const p = product({ price: 1000, tax_rate: 10 });
  stock(p, 5);
  const ali = erp.master.saveCustomer({ name: 'Ali', credit_limit: 10000 });
  const sale = erp.sales.createSale({ customerId: ali.id, lines: [{ productId: p.id, qty: 3 }], payments: [] });
  assert.equal(erp.inventory.totalStock(p.id), 2);

  const ret = erp.sales.createReturn({ invoiceId: sale.id, lines: [{ productId: p.id, qty: 1 }], refunds: [] });
  assert.equal(ret.total, 1100);
  assert.equal(erp.inventory.totalStock(p.id), 3, 'returned item goes back to stock');
  assert.equal(erp.master.getCustomer(ali.id).balance, 3300 - 1100, 'balance drops by the return total');

  assert.throws(
    () => erp.sales.createReturn({ invoiceId: sale.id, lines: [{ productId: p.id, qty: 3 }] }),
    /Only 2 can still be returned/,
  );
});

test('walk-in returns must be refunded in full', () => {
  const p = product({ price: 500 });
  stock(p, 2);
  const sale = erp.sales.createSale({ lines: [{ productId: p.id, qty: 1 }], payments: [{ amount: 500 }] });
  assert.throws(
    () => erp.sales.createReturn({ invoiceId: sale.id, lines: [{ productId: p.id, qty: 1 }], refunds: [{ amount: 100 }] }),
    /refunded in full/,
  );
  const ret = erp.sales.createReturn({ invoiceId: sale.id, lines: [{ productId: p.id, qty: 1 }], refunds: [{ amount: 500 }] });
  assert.equal(ret.settled, -500);
});

test('purchase receipt adds stock, sets the weighted average cost and creates a payable', () => {
  const p = product({ cost: 1000, tax_rate: 0 });
  stock(p, 10);
  const supplier = erp.master.saveSupplier({ name: 'Wholesale' });
  const po = erp.purchasing.savePurchase({ supplierId: supplier.id, lines: [{ productId: p.id, qty: 10, unitCost: 2000 }] });
  assert.equal(po.status, 'draft');
  erp.purchasing.markOrdered(po.id);
  const received = erp.purchasing.receivePurchase(po.id);
  assert.equal(received.status, 'received');
  assert.equal(erp.inventory.totalStock(p.id), 20);
  assert.equal(erp.master.getProduct(p.id).cost, 1500, '(10 x 1000 + 10 x 2000) / 20');
  assert.equal(erp.master.getSupplier(supplier.id).balance, 20000);

  erp.finance.paySupplier({ supplierId: supplier.id, amount: 5000 });
  assert.equal(erp.master.getSupplier(supplier.id).balance, 15000);
  assert.throws(() => erp.finance.paySupplier({ supplierId: supplier.id, amount: 99999 }), /more than the amount owed/);
});

test('received purchase orders cannot be edited or cancelled', () => {
  const p = product();
  const supplier = erp.master.saveSupplier({ name: 'Wholesale' });
  const po = erp.purchasing.savePurchase({ supplierId: supplier.id, lines: [{ productId: p.id, qty: 1 }] });
  erp.purchasing.markOrdered(po.id);
  erp.purchasing.receivePurchase(po.id);
  assert.throws(() => erp.purchasing.cancelPurchase(po.id), /cannot be cancelled/);
  assert.throws(() => erp.purchasing.savePurchase({ id: po.id, supplierId: supplier.id, lines: [{ productId: p.id, qty: 2 }] }), /Only draft/);
});

test('quotes do not touch stock and convert into a sale using the quote lines', () => {
  const p = product({ price: 700 });
  stock(p, 4);
  const quote = erp.sales.createQuote({ lines: [{ productId: p.id, qty: 2 }] });
  assert.equal(quote.status, 'open');
  assert.equal(erp.inventory.totalStock(p.id), 4);
  const sale = erp.sales.convertQuote(quote.id, { payments: [{ method: 'card', amount: 1400 }] });
  assert.equal(sale.total, 1400);
  assert.equal(erp.inventory.totalStock(p.id), 2);
  assert.equal(erp.sales.getSale(quote.id).status, 'converted');
  assert.throws(() => erp.sales.convertQuote(quote.id, {}), /not open/);
});

test('stock transfers keep the total unchanged and reject same-warehouse moves', () => {
  const p = product();
  stock(p, 6);
  const second = erp.master.saveWarehouse({ code: 'YARD', name: 'Yard' });
  erp.inventory.transferStock({ productId: p.id, fromWarehouseId: warehouseId, toWarehouseId: second.id, qty: 4 });
  assert.equal(erp.inventory.sumQty(p.id, warehouseId), 2);
  assert.equal(erp.inventory.sumQty(p.id, second.id), 4);
  assert.equal(erp.inventory.totalStock(p.id), 6);
  assert.throws(
    () => erp.inventory.transferStock({ productId: p.id, fromWarehouseId: warehouseId, toWarehouseId: warehouseId, qty: 1 }),
    /different warehouses/,
  );
});

test('low stock items are reported against reorder levels', () => {
  const p = product({ reorder_level: 5 });
  stock(p, 4);
  assert.deepEqual(erp.inventory.lowStockItems().map((i) => i.id), [p.id]);
  erp.inventory.adjustStock({ productId: p.id, warehouseId, countedQty: 9 });
  assert.equal(erp.inventory.lowStockItems().length, 0);
});

test('profit and loss uses cost of goods sold and subtracts returns and expenses', () => {
  const p = product({ price: 1000, cost: 600, tax_rate: 0 });
  stock(p, 10);
  const sale = erp.sales.createSale({ lines: [{ productId: p.id, qty: 4 }], payments: [{ amount: 4000 }] });
  erp.sales.createReturn({ invoiceId: sale.id, lines: [{ productId: p.id, qty: 1 }], refunds: [{ amount: 1000 }] });
  erp.finance.addExpense({ category: 'Rent', amount: 500 });
  const pl = erp.reports.profitAndLoss();
  assert.equal(pl.revenue, 3000);
  assert.equal(pl.cogs, 1800);
  assert.equal(pl.gross_profit, 1200);
  assert.equal(pl.net_profit, 700);
});

test('receivables aging allocates credits to the oldest invoices first', () => {
  const p = product({ price: 1000 });
  stock(p, 10);
  const ali = erp.master.saveCustomer({ name: 'Ali', credit_limit: 100000 });
  erp.sales.createSale({ customerId: ali.id, date: '2026-01-05', lines: [{ productId: p.id, qty: 2 }], payments: [] });
  erp.sales.createSale({ customerId: ali.id, date: '2026-10-20', lines: [{ productId: p.id, qty: 1 }], payments: [] });
  erp.finance.receiveFromCustomer({ customerId: ali.id, amount: 2000 });
  const aging = erp.reports.receivables()[0].aging;
  assert.equal(aging.over90, 0, 'the old invoice was paid first');
  assert.equal(aging.current, 1000, 'the recent invoice is still open');
});

test('settings validate their values and survive a round trip', () => {
  assert.throws(() => erp.settings.save({ default_tax_rate: 150 }), /between 0 and 100/);
  erp.settings.save({ company_name: 'Acme', default_tax_rate: 16 });
  assert.equal(erp.settings.get('company_name'), 'Acme');
  assert.equal(erp.settings.get('default_tax_rate'), 16);
});

test('duplicate SKU and barcode are rejected', () => {
  product({ sku: 'DUP', barcode: '111' });
  assert.throws(() => product({ sku: 'DUP' }), /SKU already exists/);
  assert.throws(() => product({ sku: 'OTHER', barcode: '111' }), /Barcode already exists/);
});
