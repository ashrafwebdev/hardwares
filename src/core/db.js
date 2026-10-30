'use strict';

const { DatabaseSync } = require('node:sqlite');
const { schemaStatements } = require('./schema');

const SCHEMA_VERSION = 1;

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version < SCHEMA_VERSION) {
    db.exec('BEGIN');
    try {
      for (const statement of schemaStatements()) db.exec(statement);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

// Nested-safe transaction helper. Inner calls become savepoints.
function createTx(db) {
  let depth = 0;
  return function tx(fn) {
    const savepoint = `sp${depth}`;
    db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    depth += 1;
    try {
      const result = fn();
      depth -= 1;
      db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      depth -= 1;
      db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    }
  };
}

// Insert a row into a local (non-synced) table.
function insertRow(db, table, row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => toSql(row[c])));
}

// SQLite accepts numbers, strings, bigints, Buffers and null only.
function toSql(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

module.exports = { openDatabase, createTx, insertRow, toSql, SCHEMA_VERSION };
