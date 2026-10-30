'use strict';

const { newId, nowIso, ensure, localDate, qtyOf, text } = require('./util');

// Stock on hand is the sum of an append-only movement ledger. Corrections are
// new movements, never edits, which keeps history intact and merges cleanly
// when machines sync.
function createInventory({ db, repo, tx, settings }) {
  const sumQty = (productId, warehouseId) => db.prepare(
    'SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movements WHERE product_id = ? AND warehouse_id = ? AND deleted = 0',
  ).get(productId, warehouseId).n;

  const totalStock = (productId) => db.prepare(
    'SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movements WHERE product_id = ? AND deleted = 0',
  ).get(productId).n;

  function requireProductAndWarehouse(productId, warehouseId) {
    const product = repo.find('products', productId);
    ensure(product, 'Product not found', 404);
    const warehouse = repo.find('warehouses', warehouseId);
    ensure(warehouse, 'Warehouse not found', 404);
    return { product, warehouse };
  }

  function postMovement({ productId, warehouseId, qty, type, refId = null, unitCost = 0, date = localDate(), note = '' }) {
    ensure(qty !== 0, 'Quantity cannot be zero');
    const { product } = requireProductAndWarehouse(productId, warehouseId);
    if (qty < 0 && !settings.get('allow_negative_stock')) {
      const onHand = sumQty(productId, warehouseId);
      ensure(
        onHand + qty >= -1e-9,
        `Not enough stock of ${product.name}: ${onHand} ${product.unit} on hand`,
      );
    }
    return repo.save('stock_movements', {
      product_id: productId,
      warehouse_id: warehouseId,
      qty,
      type,
      ref_id: refId,
      unit_cost: unitCost,
      date,
      note: text(note),
      created_at: nowIso(),
    });
  }

  // Stock levels per product and warehouse, optionally filtered.
  function stockLevels({ warehouseId, q = '', lowOnly = false } = {}) {
    const params = [];
    let filter = '';
    if (warehouseId) { filter += ' AND w.id = ?'; params.push(warehouseId); }
    if (q) { filter += ' AND (p.name LIKE ? OR p.sku LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    const rows = db.prepare(
      `SELECT p.id AS product_id, p.sku, p.name, p.unit, p.reorder_level, p.cost,
              w.id AS warehouse_id, w.name AS warehouse_name,
              COALESCE((SELECT SUM(m.qty) FROM stock_movements m
                         WHERE m.product_id = p.id AND m.warehouse_id = w.id AND m.deleted = 0), 0) AS qty
         FROM products p CROSS JOIN warehouses w
        WHERE p.deleted = 0 AND p.active = 1 AND w.deleted = 0${filter}
        ORDER BY p.name, w.name`,
    ).all(...params);
    return rows
      .map((r) => ({ ...r, low: r.reorder_level > 0 && r.qty <= r.reorder_level }))
      .filter((r) => !lowOnly || r.low);
  }

  function lowStockItems() {
    const totals = db.prepare(
      `SELECT p.id, p.sku, p.name, p.unit, p.reorder_level,
              COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.product_id = p.id AND m.deleted = 0), 0) AS qty
         FROM products p WHERE p.deleted = 0 AND p.active = 1 AND p.reorder_level > 0`,
    ).all();
    return totals.filter((p) => p.qty <= p.reorder_level).sort((a, b) => a.qty - b.qty);
  }

  // Set the counted quantity for a product in a warehouse; posts the difference.
  function adjustStock({ productId, warehouseId, countedQty, note = '', date, by }) {
    return tx(() => {
      const counted = qtyOf(countedQty, 'Counted quantity');
      ensure(counted >= 0, 'Counted quantity cannot be negative');
      const diff = Math.round((counted - sumQty(productId, warehouseId)) * 1000) / 1000;
      if (diff === 0) return null;
      return postMovement({
        productId, warehouseId, qty: diff, type: 'adjustment', date,
        note: note || `Stock count${by ? ` by ${by}` : ''}`,
      });
    });
  }

  function transferStock({ productId, fromWarehouseId, toWarehouseId, qty, note = '', date }) {
    return tx(() => {
      ensure(fromWarehouseId !== toWarehouseId, 'Choose two different warehouses');
      const amount = qtyOf(qty);
      ensure(amount > 0, 'Quantity must be greater than zero');
      const refId = newId();
      const day = date || localDate();
      postMovement({ productId, warehouseId: fromWarehouseId, qty: -amount, type: 'transfer_out', refId, date: day, note });
      postMovement({ productId, warehouseId: toWarehouseId, qty: amount, type: 'transfer_in', refId, date: day, note });
      return { refId, qty: amount };
    });
  }

  function listMovements({ productId, warehouseId, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (productId) { where.push('m.product_id = ?'); params.push(productId); }
    if (warehouseId) { where.push('m.warehouse_id = ?'); params.push(warehouseId); }
    return db.prepare(
      `SELECT m.*, p.name AS product_name, p.sku, p.unit, w.name AS warehouse_name
         FROM stock_movements m
         LEFT JOIN products p ON p.id = m.product_id
         LEFT JOIN warehouses w ON w.id = m.warehouse_id
        WHERE m.deleted = 0 ${where.map((w) => `AND ${w}`).join(' ')}
        ORDER BY m.created_at DESC LIMIT ${Number(limit)}`,
    ).all(...params);
  }

  return { sumQty, totalStock, postMovement, stockLevels, lowStockItems, adjustStock, transferStock, listMovements };
}

module.exports = { createInventory };
