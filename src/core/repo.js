'use strict';

const { SYNCED, SYNC_COLUMNS } = require('./schema');
const { newId, nowIso, ensure } = require('./util');
const { toSql } = require('./db');

// Generic access to synced tables. Every local write marks the row dirty
// and records it in sync_log so it can be pulled by other machines.
function createRepo(db) {
  const columnsOf = (table) => {
    ensure(SYNCED[table], `Unknown table ${table}`, 500);
    return [...Object.keys(SYNCED[table]), ...Object.keys(SYNC_COLUMNS)];
  };

  const upsertStatements = new Map();
  function upsert(table, row) {
    let statement = upsertStatements.get(table);
    if (!statement) {
      const cols = columnsOf(table);
      const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
      statement = db.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) `
        + `ON CONFLICT(id) DO UPDATE SET ${updates}`,
      );
      upsertStatements.set(table, statement);
    }
    statement.run(...columnsOf(table).map((c) => toSql(row[c])));
  }

  function logChange(table, id) {
    db.prepare('DELETE FROM sync_log WHERE tbl = ? AND row_id = ?').run(table, id);
    db.prepare('INSERT INTO sync_log (tbl, row_id) VALUES (?, ?)').run(table, id);
  }

  function get(table, id) {
    columnsOf(table);
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null;
  }

  // Returns the row only if it has not been soft-deleted.
  function find(table, id) {
    const row = id ? get(table, id) : null;
    return row && !row.deleted ? row : null;
  }

  function save(table, data) {
    const businessCols = Object.keys(SYNCED[table]);
    const existing = data.id ? get(table, data.id) : null;
    const row = { ...(existing || {}) };
    for (const col of businessCols) {
      if (data[col] !== undefined) row[col] = data[col];
    }
    row.id = row.id || newId();
    if (!existing && businessCols.includes('created_at') && row.created_at == null) {
      row.created_at = nowIso();
    }
    row.updated_at = nowIso();
    row.dirty = 1;
    row.deleted = data.deleted !== undefined ? (data.deleted ? 1 : 0) : (row.deleted ? 1 : 0);
    upsert(table, row);
    logChange(table, row.id);
    return row;
  }

  function remove(table, id) {
    return find(table, id) ? save(table, { id, deleted: 1 }) : null;
  }

  // Apply a row received from another machine without marking it dirty.
  // The hosted server passes log: true so its own pulls see the change.
  function applyRemote(table, row, { log = false } = {}) {
    upsert(table, { ...row, dirty: 0 });
    if (log) logChange(table, row.id);
  }

  function markClean(table, id, updatedAt) {
    db.prepare(`UPDATE ${table} SET dirty = 0 WHERE id = ? AND updated_at = ?`).run(id, updatedAt);
  }

  function list(table, { where = '1 = 1', params = [], orderBy = 'rowid', limit = 1000 } = {}) {
    columnsOf(table);
    return db.prepare(
      `SELECT * FROM ${table} WHERE deleted = 0 AND (${where}) ORDER BY ${orderBy} LIMIT ${Number(limit)}`,
    ).all(...params);
  }

  return { get, find, save, remove, list, applyRemote, markClean, logChange, columnsOf };
}

module.exports = { createRepo };
