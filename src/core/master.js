'use strict';

const { ensure, text, ref, flag, cents, qtyOf, rate, pick } = require('./util');
const { customerBalance, supplierBalance } = require('./ledger');
const { STATE_NAMES, isValidGstin, isValidPan, stateOfGstin } = require('./india');

// HSN codes are 4, 6 or 8 digits. Required on GST invoices for goods.
const hsnField = (v) => {
  const code = text(v).replace(/\s/g, '');
  ensure(!code || /^\d{4}(\d{2}(\d{2})?)?$/.test(code), 'HSN code must be 4, 6 or 8 digits');
  return code || null;
};

const gstinField = (v) => {
  const gstin = text(v).toUpperCase();
  ensure(!gstin || isValidGstin(gstin), 'GSTIN is not valid. Check the 15 characters.');
  return gstin || null;
};

const stateField = (v) => {
  const code = text(v);
  ensure(!code || STATE_NAMES[code], 'Choose a valid state');
  return code || null;
};

const panField = (v) => {
  const pan = text(v).toUpperCase();
  ensure(!pan || isValidPan(pan), 'PAN must be 10 characters, like ABCDE1234F');
  return pan || null;
};

// Categories, warehouses, products, customers and suppliers.
function createMaster({ db, repo, tx, settings, inventory }) {
  const duplicate = (table, column, value, exceptId) => value
    && db.prepare(`SELECT id FROM ${table} WHERE ${column} = ? AND deleted = 0 AND id <> ?`).get(value, exceptId || '');

  // ---- categories ---------------------------------------------------------
  const listCategories = () => repo.list('categories', { orderBy: 'name' });

  function saveCategory(data) {
    const patch = pick(data, { name: text, parent_id: ref });
    if (!data.id || patch.name !== undefined) ensure(patch.name, 'Category name is required');
    return repo.save('categories', { ...patch, id: data.id });
  }

  function removeCategory(id) {
    const used = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ? AND deleted = 0').get(id).n;
    ensure(!used, 'Category is used by products');
    return repo.remove('categories', id);
  }

  // ---- warehouses ---------------------------------------------------------
  const listWarehouses = () => repo.list('warehouses', { orderBy: 'name' });

  function saveWarehouse(data) {
    const existing = data.id ? repo.find('warehouses', data.id) : null;
    ensure(!data.id || existing, 'Warehouse not found', 404);
    const patch = pick(data, { code: text, name: text, address: text, active: flag });
    const code = patch.code ?? existing?.code;
    ensure(code, 'Warehouse code is required');
    ensure(text(patch.name ?? existing?.name), 'Warehouse name is required');
    ensure(!duplicate('warehouses', 'code', code, data.id), 'Warehouse code already exists', 409);
    return repo.save('warehouses', { active: existing ? existing.active : 1, ...patch, id: data.id });
  }

  // ---- products -----------------------------------------------------------
  function listProducts({ q = '', categoryId, supplierId, includeInactive = false, lowStock = false, limit = 500 } = {}) {
    const where = [];
    const params = [];
    if (!includeInactive) where.push('p.active = 1');
    if (categoryId) { where.push('p.category_id = ?'); params.push(categoryId); }
    if (supplierId) { where.push('p.supplier_id = ?'); params.push(supplierId); }
    if (q) {
      where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode = ? OR p.location LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, q, `%${q}%`);
    }
    const rows = db.prepare(
      `SELECT p.*, c.name AS category_name,
              (SELECT COALESCE(SUM(m.qty), 0) FROM stock_movements m WHERE m.product_id = p.id AND m.deleted = 0) AS stock
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.deleted = 0 ${where.length ? `AND ${where.join(' AND ')}` : ''}
        ORDER BY p.name LIMIT ${Number(limit)}`,
    ).all(...params);
    return lowStock ? rows.filter((p) => p.reorder_level > 0 && p.stock <= p.reorder_level) : rows;
  }

  // Exact match on SKU or barcode, used by the point of sale scanner box.
  function findProductByCode(code) {
    const value = text(code);
    if (!value) return null;
    return db.prepare(
      `SELECT p.*, (SELECT COALESCE(SUM(m.qty), 0) FROM stock_movements m WHERE m.product_id = p.id AND m.deleted = 0) AS stock
         FROM products p WHERE p.deleted = 0 AND p.active = 1 AND (p.barcode = ? OR p.sku = ?) LIMIT 1`,
    ).get(value, value) || null;
  }

  function getProduct(id) {
    const product = repo.find('products', id);
    ensure(product, 'Product not found', 404);
    const stockByWarehouse = db.prepare(
      `SELECT w.id, w.name, w.code,
              COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.warehouse_id = w.id AND m.product_id = ? AND m.deleted = 0), 0) AS qty
         FROM warehouses w WHERE w.deleted = 0 ORDER BY w.name`,
    ).all(id);
    return { ...product, stock: stockByWarehouse.reduce((s, w) => s + w.qty, 0), stockByWarehouse };
  }

  function saveProduct(data) {
    return tx(() => {
      const existing = data.id ? repo.find('products', data.id) : null;
      ensure(!data.id || existing, 'Product not found', 404);
      const patch = pick(data, {
        sku: text,
        barcode: ref,
        name: text,
        description: text,
        category_id: ref,
        supplier_id: ref,
        unit: (v) => text(v) || 'pcs',
        hsn_code: hsnField,
        cost: (v) => cents(v, 'Cost'),
        price: (v) => cents(v, 'Price'),
        tax_rate: (v) => rate(v),
        reorder_level: (v) => qtyOf(v, 'Reorder level'),
        location: text,
        active: flag,
      });
      const row = {
        cost: 0, price: 0, unit: 'pcs', tax_rate: settings.get('default_tax_rate'), reorder_level: 0, active: 1,
        ...(existing || {}), ...patch,
      };
      ensure(text(row.name), 'Product name is required');
      ensure(text(row.sku), 'SKU is required');
      ensure(row.price >= 0 && row.cost >= 0, 'Prices cannot be negative');
      ensure(!duplicate('products', 'sku', row.sku, data.id), 'SKU already exists', 409);
      ensure(!duplicate('products', 'barcode', row.barcode, data.id), 'Barcode already exists', 409);
      return repo.save('products', { ...row, id: data.id, created_at: existing?.created_at });
    });
  }

  // ---- customers and suppliers ---------------------------------------------
  function saveParty(table, data, extra) {
    return tx(() => {
      const existing = data.id ? repo.find(table, data.id) : null;
      ensure(!data.id || existing, 'Record not found', 404);
      const patch = pick(data, {
        code: ref,
        name: text,
        phone: text,
        email: text,
        address: text,
        gstin: gstinField,
        state_code: stateField,
        pan: panField,
        opening_balance: (v) => cents(v, 'Opening balance'),
        active: flag,
        ...extra,
      });
      const row = { active: 1, opening_balance: 0, credit_limit: 0, ...(existing || {}), ...patch };
      ensure(text(row.name), 'Name is required');
      // The state always follows the GSTIN, because the first two digits of a GSTIN are its state code.
      if (row.gstin) row.state_code = stateOfGstin(row.gstin);
      if (row.code) ensure(!duplicate(table, 'code', row.code, data.id), 'Code already exists', 409);
      return repo.save(table, { ...row, id: data.id, created_at: existing?.created_at });
    });
  }

  const saveCustomer = (data) => saveParty('customers', data, {
    credit_limit: (v) => cents(v, 'Credit limit'),
  });

  const saveSupplier = (data) => saveParty('suppliers', data, {});

  function listCustomers({ q = '', includeInactive = false } = {}) {
    const rows = repo.list('customers', {
      where: `(name LIKE ? OR code LIKE ? OR phone LIKE ?) ${includeInactive ? '' : 'AND active = 1'}`,
      params: [`%${q}%`, `%${q}%`, `%${q}%`],
      orderBy: 'name',
      limit: 500,
    });
    return rows.map((c) => ({ ...c, balance: customerBalance(db, c.id) }));
  }

  function listSuppliers({ q = '', includeInactive = false } = {}) {
    const rows = repo.list('suppliers', {
      where: `(name LIKE ? OR code LIKE ? OR phone LIKE ?) ${includeInactive ? '' : 'AND active = 1'}`,
      params: [`%${q}%`, `%${q}%`, `%${q}%`],
      orderBy: 'name',
      limit: 500,
    });
    return rows.map((s) => ({ ...s, balance: supplierBalance(db, s.id) }));
  }

  function getCustomer(id) {
    const customer = repo.find('customers', id);
    ensure(customer, 'Customer not found', 404);
    return { ...customer, balance: customerBalance(db, id) };
  }

  function getSupplier(id) {
    const supplier = repo.find('suppliers', id);
    ensure(supplier, 'Supplier not found', 404);
    return { ...supplier, balance: supplierBalance(db, id) };
  }

  return {
    listCategories, saveCategory, removeCategory,
    listWarehouses, saveWarehouse,
    listProducts, findProductByCode, getProduct, saveProduct,
    listCustomers, getCustomer, saveCustomer,
    listSuppliers, getSupplier, saveSupplier,
  };
}

module.exports = { createMaster };
