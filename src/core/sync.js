'use strict';

const { SYNCED } = require('./schema');
const { ensure, nowIso, text } = require('./util');

// Sync protocol
//
// Push (client -> server): dirty rows are sent. The server keeps a row only if
// it is not older than the copy it already has (last write wins by updated_at)
// and answers with accepted / rejected for each one. A rejected row carries the
// server's copy, which the client adopts if it has not changed since sending.
//
// Pull (server -> client): the server reads sync_log after a cursor. Each
// record appears once with its latest state. Rows the client has changed but not
// yet pushed are left alone; the next push settles them.
//
// Stock movements are insert-only, so they never conflict.
function createSync({ db, repo, tx, kv, fetchImpl = globalThis.fetch }) {
  // ---- server side ---------------------------------------------------------
  function applyPush(changes) {
    ensure(Array.isArray(changes), 'changes must be an array');
    return tx(() => changes.map(({ table, row }) => {
      ensure(SYNCED[table] && row && row.id, 'Invalid change');
      const current = repo.get(table, row.id);
      if (current && current.updated_at > row.updated_at) {
        return { table, id: row.id, status: 'rejected', row: current };
      }
      repo.applyRemote(table, row, { log: true });
      return { table, id: row.id, status: 'accepted', updated_at: row.updated_at };
    }));
  }

  function pullChanges(cursor = 0, limit = 200) {
    const entries = db.prepare('SELECT seq, tbl, row_id FROM sync_log WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(Number(cursor) || 0, Math.min(Number(limit) || 200, 1000));
    const changes = [];
    for (const entry of entries) {
      const row = repo.get(entry.tbl, entry.row_id);
      if (row) changes.push({ table: entry.tbl, row });
    }
    return {
      changes,
      cursor: entries.length ? entries[entries.length - 1].seq : Number(cursor) || 0,
      more: entries.length === Math.min(Number(limit) || 200, 1000),
    };
  }

  // ---- client side ---------------------------------------------------------
  function dirtyRows(limit) {
    const out = [];
    for (const table of Object.keys(SYNCED)) {
      if (out.length >= limit) break;
      const rows = db.prepare(`SELECT * FROM ${table} WHERE dirty = 1 LIMIT ?`).all(limit - out.length);
      for (const row of rows) out.push({ table, row });
    }
    return out;
  }

  function pendingCount() {
    return Object.keys(SYNCED).reduce(
      (n, table) => n + db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE dirty = 1`).get().n,
      0,
    );
  }

  function config() {
    const url = kv.get('sync_url');
    return url ? { url, token: kv.get('sync_token') || '' } : null;
  }

  function saveConfig({ url, token }) {
    const clean = text(url).replace(/\/+$/, '');
    if (!clean) {
      kv.delete('sync_url');
      kv.delete('sync_token');
      return status();
    }
    ensure(/^https?:\/\//.test(clean), 'Server address must start with http:// or https://');
    kv.set('sync_url', clean);
    if (token !== undefined) kv.set('sync_token', text(token));
    return status();
  }

  function status() {
    return {
      configured: !!kv.get('sync_url'),
      url: kv.get('sync_url'),
      last_sync: kv.get('last_sync'),
      last_error: kv.get('last_sync_error'),
      pending: pendingCount(),
    };
  }

  async function run({ batch = 200 } = {}) {
    const settings = config();
    ensure(settings, 'Sync is not configured', 400);
    const base = settings.url;
    const call = async (method, path, body) => {
      const response = await fetchImpl(base + path, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.token}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Server answered HTTP ${response.status}`);
      return data;
    };

    try {
      let pushed = 0;
      let pulled = 0;

      for (let round = 0; round < 100; round++) {
        const outgoing = dirtyRows(batch);
        if (!outgoing.length) break;
        const sent = new Map(outgoing.map(({ table, row }) => [`${table}:${row.id}`, row.updated_at]));
        const { results } = await call('POST', '/api/sync/push', { changes: outgoing });
        tx(() => {
          for (const result of results) {
            const sentAt = sent.get(`${result.table}:${result.id}`);
            if (result.status === 'accepted') {
              repo.markClean(result.table, result.id, sentAt);
              continue;
            }
            const local = repo.get(result.table, result.id);
            if (local && local.dirty && local.updated_at === sentAt) repo.applyRemote(result.table, result.row);
          }
        });
        pushed += outgoing.length;
      }

      let cursor = Number(kv.get('pull_cursor') || 0);
      for (let round = 0; round < 10000; round++) {
        const page = await call('GET', `/api/sync/pull?cursor=${cursor}&limit=${batch}`);
        tx(() => {
          for (const { table, row } of page.changes) {
            const local = repo.get(table, row.id);
            if (local && local.dirty) continue;
            repo.applyRemote(table, row);
            pulled += 1;
          }
        });
        cursor = page.cursor;
        kv.set('pull_cursor', String(cursor));
        if (!page.more) break;
      }

      kv.set('last_sync', nowIso());
      kv.delete('last_sync_error');
      return { pushed, pulled, at: kv.get('last_sync') };
    } catch (err) {
      kv.set('last_sync_error', `${nowIso()}: ${err.message}`);
      throw err;
    }
  }

  return { applyPush, pullChanges, run, config, saveConfig, status, pendingCount };
}

module.exports = { createSync };
