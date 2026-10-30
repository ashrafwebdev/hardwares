'use strict';

// Single source of truth for the database layout.
//
// SYNCED tables travel between machines. Their business columns are listed
// here; the sync engine adds SYNC_COLUMNS (updated_at, dirty, deleted) itself.
// Money is stored as integer cents, quantities as REAL, dates as YYYY-MM-DD.
const SYNCED = {
  settings: { id: 'TEXT', value: 'TEXT' },

  warehouses: {
    id: 'TEXT', code: 'TEXT', name: 'TEXT', address: 'TEXT', active: 'INTEGER', created_at: 'TEXT',
  },

  categories: {
    id: 'TEXT', name: 'TEXT', parent_id: 'TEXT', created_at: 'TEXT',
  },

  products: {
    id: 'TEXT', sku: 'TEXT', barcode: 'TEXT', name: 'TEXT', description: 'TEXT',
    category_id: 'TEXT', supplier_id: 'TEXT', unit: 'TEXT',
    cost: 'INTEGER', price: 'INTEGER', tax_rate: 'REAL', reorder_level: 'REAL',
    location: 'TEXT', active: 'INTEGER', created_at: 'TEXT',
  },

  customers: {
    id: 'TEXT', code: 'TEXT', name: 'TEXT', phone: 'TEXT', email: 'TEXT', address: 'TEXT',
    tax_no: 'TEXT', credit_limit: 'INTEGER', opening_balance: 'INTEGER', active: 'INTEGER',
    created_at: 'TEXT',
  },

  suppliers: {
    id: 'TEXT', code: 'TEXT', name: 'TEXT', phone: 'TEXT', email: 'TEXT', address: 'TEXT',
    tax_no: 'TEXT', opening_balance: 'INTEGER', active: 'INTEGER', created_at: 'TEXT',
  },

  // Append-only. Stock on hand is the sum of qty per product and warehouse.
  stock_movements: {
    id: 'TEXT', product_id: 'TEXT', warehouse_id: 'TEXT', qty: 'REAL', type: 'TEXT',
    ref_id: 'TEXT', unit_cost: 'INTEGER', date: 'TEXT', note: 'TEXT', created_at: 'TEXT',
  },

  // type: invoice | return | quote. status: posted | open | converted.
  sales_docs: {
    id: 'TEXT', number: 'TEXT', type: 'TEXT', status: 'TEXT', date: 'TEXT',
    customer_id: 'TEXT', warehouse_id: 'TEXT', ref_doc_id: 'TEXT',
    subtotal: 'INTEGER', tax_total: 'INTEGER', total: 'INTEGER',
    payment_method: 'TEXT', note: 'TEXT', created_by: 'TEXT', created_at: 'TEXT',
  },

  sales_lines: {
    id: 'TEXT', doc_id: 'TEXT', product_id: 'TEXT', description: 'TEXT', qty: 'REAL',
    unit_price: 'INTEGER', discount_pct: 'REAL', unit_cost: 'INTEGER', tax_rate: 'REAL',
    net: 'INTEGER', tax_amount: 'INTEGER', total: 'INTEGER',
  },

  // status: draft | ordered | received | cancelled.
  purchase_docs: {
    id: 'TEXT', number: 'TEXT', status: 'TEXT', date: 'TEXT', supplier_id: 'TEXT',
    warehouse_id: 'TEXT', subtotal: 'INTEGER', tax_total: 'INTEGER', total: 'INTEGER',
    received_date: 'TEXT', note: 'TEXT', created_by: 'TEXT', created_at: 'TEXT',
  },

  purchase_lines: {
    id: 'TEXT', doc_id: 'TEXT', product_id: 'TEXT', description: 'TEXT', qty: 'REAL',
    unit_cost: 'INTEGER', tax_rate: 'REAL', net: 'INTEGER', tax_amount: 'INTEGER', total: 'INTEGER',
  },

  // kind: receipt (money in from customer) | payment (money out to supplier) | refund (money out to customer).
  payments: {
    id: 'TEXT', number: 'TEXT', kind: 'TEXT', party_type: 'TEXT', party_id: 'TEXT',
    doc_id: 'TEXT', amount: 'INTEGER', method: 'TEXT', date: 'TEXT', note: 'TEXT',
    created_by: 'TEXT', created_at: 'TEXT',
  },

  expenses: {
    id: 'TEXT', date: 'TEXT', category: 'TEXT', description: 'TEXT', amount: 'INTEGER',
    method: 'TEXT', created_by: 'TEXT', created_at: 'TEXT',
  },
};

const SYNC_COLUMNS = {
  updated_at: 'TEXT',
  dirty: 'INTEGER NOT NULL DEFAULT 1',
  deleted: 'INTEGER NOT NULL DEFAULT 0',
};

// Tables that stay on each machine.
const LOCAL_TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT, role TEXT NOT NULL,
     password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS devices (
     id TEXT PRIMARY KEY, name TEXT, token_hash TEXT NOT NULL, created_at TEXT,
     revoked INTEGER NOT NULL DEFAULT 0)`,
  // Change feed for pulls: one row per record, re-numbered whenever it changes.
  `CREATE TABLE IF NOT EXISTS sync_log (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, row_id TEXT NOT NULL,
     UNIQUE (tbl, row_id))`,
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS sequences (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS ix_products_sku ON products (sku)',
  'CREATE INDEX IF NOT EXISTS ix_products_barcode ON products (barcode)',
  'CREATE INDEX IF NOT EXISTS ix_movements_product ON stock_movements (product_id, warehouse_id)',
  'CREATE INDEX IF NOT EXISTS ix_movements_ref ON stock_movements (ref_id)',
  'CREATE INDEX IF NOT EXISTS ix_sales_type_date ON sales_docs (type, date)',
  'CREATE INDEX IF NOT EXISTS ix_sales_customer ON sales_docs (customer_id)',
  'CREATE INDEX IF NOT EXISTS ix_sales_lines_doc ON sales_lines (doc_id)',
  'CREATE INDEX IF NOT EXISTS ix_purchase_lines_doc ON purchase_lines (doc_id)',
  'CREATE INDEX IF NOT EXISTS ix_purchase_docs_supplier ON purchase_docs (supplier_id)',
  'CREATE INDEX IF NOT EXISTS ix_payments_party ON payments (party_type, party_id)',
  'CREATE INDEX IF NOT EXISTS ix_payments_doc ON payments (doc_id)',
  'CREATE INDEX IF NOT EXISTS ix_expenses_date ON expenses (date)',
];

function schemaStatements() {
  const tables = Object.entries(SYNCED).map(([table, cols]) => {
    const defs = [...Object.entries(cols), ...Object.entries(SYNC_COLUMNS)]
      .map(([name, type]) => `${name} ${type}`);
    return `CREATE TABLE IF NOT EXISTS ${table} (${defs.join(', ')}, PRIMARY KEY (id))`;
  });
  return [...tables, ...LOCAL_TABLES, ...INDEXES];
}

module.exports = { SYNCED, SYNC_COLUMNS, schemaStatements };
