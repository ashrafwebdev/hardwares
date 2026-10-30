'use strict';

const { ensure, localDate, nowIso, text, cents, qtyOf, rate, sum } = require('./util');
const { splitTax, stateOfGstin } = require('./india');

// Purchase orders: draft -> ordered -> received. Receiving posts stock in and
// moves the product's average cost. Cancelling is allowed until receipt.
function createPurchasing({ db, repo, tx, nextNumber, inventory, settings }) {
  function requireSupplier(id) {
    const supplier = repo.find('suppliers', id);
    ensure(supplier, 'Supplier not found', 404);
    return supplier;
  }

  function requireOpenOrder(id, statuses, message) {
    const order = repo.find('purchase_docs', id);
    ensure(order && statuses.includes(order.status), message || 'Purchase order is not in a valid state', 409);
    return order;
  }

  // Purchases are priced before GST; the GST paid is recorded as input tax credit.
  function priceLines(inputs, interstate) {
    ensure(Array.isArray(inputs) && inputs.length, 'Add at least one item');
    return inputs.map((input) => {
      const product = repo.find('products', input.productId);
      ensure(product, 'Product not found', 404);
      const qty = qtyOf(input.qty);
      ensure(qty > 0, `Quantity for ${product.name} must be greater than zero`);
      const unitCost = cents(input.unitCost ?? product.cost, 'Unit cost');
      ensure(unitCost >= 0, 'Unit cost cannot be negative');
      const taxRate = rate(input.taxRate ?? product.tax_rate);
      const net = Math.round(qty * unitCost);
      const taxAmount = Math.round((net * taxRate) / 100);
      const split = splitTax(taxAmount, interstate);
      return {
        product_id: product.id, description: product.name, hsn_code: product.hsn_code || null,
        qty, unit_cost: unitCost, tax_rate: taxRate, net, tax_amount: taxAmount,
        cgst: split.cgst, sgst: split.sgst, igst: split.igst, total: net + taxAmount,
      };
    });
  }

  function totalsOf(lines) {
    return {
      subtotal: sum(lines.map((l) => l.net)),
      tax_total: sum(lines.map((l) => l.tax_amount)),
      cgst_total: sum(lines.map((l) => l.cgst)),
      sgst_total: sum(lines.map((l) => l.sgst)),
      igst_total: sum(lines.map((l) => l.igst)),
      total: sum(lines.map((l) => l.total)),
    };
  }

  // Goods from a supplier in another state carry IGST; otherwise CGST and SGST.
  function isInterstateSupplier(supplier) {
    const from = stateOfGstin(supplier.gstin) || supplier.state_code;
    const ours = settings.get('company_state_code');
    return !!(from && ours && from !== ours);
  }

  function listLines(docId) {
    return db.prepare('SELECT * FROM purchase_lines WHERE doc_id = ? AND deleted = 0 ORDER BY rowid').all(docId);
  }

  function replaceLines(docId, lines) {
    for (const old of listLines(docId)) repo.remove('purchase_lines', old.id);
    for (const line of lines) repo.save('purchase_lines', { ...line, doc_id: docId });
  }

  function savePurchase(input = {}) {
    return tx(() => {
      const existing = input.id ? repo.find('purchase_docs', input.id) : null;
      ensure(!input.id || existing, 'Purchase order not found', 404);
      if (existing) ensure(existing.status === 'draft', 'Only draft orders can be edited', 409);
      const supplierId = input.supplierId ?? existing?.supplier_id;
      const supplier = requireSupplier(supplierId);
      const warehouse = repo.find('warehouses', input.warehouseId ?? existing?.warehouse_id)
        || db.prepare('SELECT * FROM warehouses WHERE deleted = 0 ORDER BY rowid LIMIT 1').get();
      ensure(warehouse, 'Warehouse not found', 404);
      const interstate = isInterstateSupplier(supplier);
      const lines = priceLines(input.lines, interstate);
      const totals = totalsOf(lines);
      const doc = repo.save('purchase_docs', {
        id: existing?.id,
        number: existing ? existing.number : nextNumber('PO-', input.date || localDate(), 4),
        status: 'draft',
        date: input.date || existing?.date || localDate(),
        supplier_id: supplier.id,
        warehouse_id: warehouse.id,
        is_interstate: interstate ? 1 : 0,
        subtotal: totals.subtotal,
        tax_total: totals.tax_total,
        cgst_total: totals.cgst_total,
        sgst_total: totals.sgst_total,
        igst_total: totals.igst_total,
        total: totals.total,
        note: text(input.note),
        created_by: existing?.created_by || input.by || 'system',
        created_at: existing?.created_at || nowIso(),
      });
      replaceLines(doc.id, lines);
      return getPurchase(doc.id);
    });
  }

  function markOrdered(id) {
    requireOpenOrder(id, ['draft'], 'Only draft orders can be placed');
    return tx(() => {
      repo.save('purchase_docs', { id, status: 'ordered' });
      return getPurchase(id);
    });
  }

  function cancelPurchase(id) {
    requireOpenOrder(id, ['draft', 'ordered'], 'Received orders cannot be cancelled');
    repo.save('purchase_docs', { id, status: 'cancelled' });
    return getPurchase(id);
  }

  // Stock is posted in and the product cost is re-averaged over the stock on
  // hand (all warehouses) plus the received quantity.
  function receivePurchase(id, { date, by } = {}) {
    return tx(() => {
      const order = requireOpenOrder(id, ['ordered'], 'Only ordered purchases can be received');
      const day = date || localDate();
      for (const line of listLines(order.id)) {
        const product = repo.get('products', line.product_id);
        const onHand = Math.max(inventory.totalStock(line.product_id), 0);
        const newQty = onHand + line.qty;
        const averageCost = onHand > 0
          ? Math.round((onHand * product.cost + line.qty * line.unit_cost) / newQty)
          : line.unit_cost;
        inventory.postMovement({
          productId: line.product_id,
          warehouseId: order.warehouse_id,
          qty: line.qty,
          type: 'purchase',
          refId: order.id,
          unitCost: line.unit_cost,
          date: day,
          note: order.number,
        });
        repo.save('products', { id: line.product_id, cost: averageCost });
      }
      repo.save('purchase_docs', { id, status: 'received', received_date: day, created_by: order.created_by || by || 'system' });
      return getPurchase(id);
    });
  }

  function listPurchases({ status, supplierId, q = '', limit = 300 } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('d.status = ?'); params.push(status); }
    if (supplierId) { where.push('d.supplier_id = ?'); params.push(supplierId); }
    if (q) { where.push('(d.number LIKE ? OR s.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    return db.prepare(
      `SELECT d.*, s.name AS supplier_name FROM purchase_docs d LEFT JOIN suppliers s ON s.id = d.supplier_id
        WHERE d.deleted = 0 ${where.map((w) => `AND ${w}`).join(' ')}
        ORDER BY d.date DESC, d.created_at DESC LIMIT ${Number(limit)}`,
    ).all(...params);
  }

  function getPurchase(id) {
    const order = repo.find('purchase_docs', id);
    ensure(order, 'Purchase order not found', 404);
    return {
      ...order,
      supplier: repo.find('suppliers', order.supplier_id),
      warehouse: repo.find('warehouses', order.warehouse_id),
      lines: listLines(id),
    };
  }

  return { savePurchase, markOrdered, cancelPurchase, receivePurchase, listPurchases, getPurchase };
}

module.exports = { createPurchasing };
