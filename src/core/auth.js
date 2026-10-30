'use strict';

const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { ensure, newId, nowIso, sha256, text } = require('./util');
const { insertRow } = require('./db');

const ROLES = ['admin', 'manager', 'cashier'];
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

const publicUser = (u) => (u ? { id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active } : null);

function createAuth({ db }) {
  const activeAdminCount = () =>
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;

  function validatePassword(password) {
    ensure(password && String(password).length >= 6, 'Password must be at least 6 characters');
  }

  return {
    hasUsers() {
      return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
    },

    listUsers() {
      return db.prepare('SELECT * FROM users ORDER BY username').all().map(publicUser);
    },

    createUser({ username, name, role = 'cashier', password }) {
      const login = text(username).toLowerCase();
      ensure(/^[a-z0-9._-]{3,32}$/.test(login), 'Username must be 3-32 characters: letters, digits, dot, dash or underscore');
      ensure(ROLES.includes(role), 'Invalid role');
      validatePassword(password);
      ensure(!db.prepare('SELECT 1 FROM users WHERE username = ?').get(login), 'Username already exists', 409);
      const user = {
        id: newId(), username: login, name: text(name) || login, role,
        password_hash: hashPassword(password), active: 1, created_at: nowIso(),
      };
      insertRow(db, 'users', user);
      return publicUser(user);
    },

    updateUser(id, { name, role, active, password }) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      ensure(user, 'User not found', 404);
      const nextRole = role ?? user.role;
      const nextActive = active !== undefined ? (active ? 1 : 0) : user.active;
      ensure(ROLES.includes(nextRole), 'Invalid role');
      if (user.role === 'admin' && user.active && (nextRole !== 'admin' || !nextActive)) {
        ensure(activeAdminCount() > 1, 'At least one active admin is required');
      }
      if (password) validatePassword(password);
      const hash = password ? hashPassword(password) : user.password_hash;
      db.prepare('UPDATE users SET name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?')
        .run(text(name) || user.name, nextRole, nextActive, hash, id);
      if (!nextActive) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    },

    login(username, password) {
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(text(username).toLowerCase());
      ensure(user && user.active && verifyPassword(String(password || ''), user.password_hash), 'Invalid username or password', 401);
      const token = randomBytes(32).toString('hex');
      insertRow(db, 'sessions', {
        id: sha256(token),
        user_id: user.id,
        created_at: nowIso(),
        expires_at: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
      });
      return { token, user: publicUser(user) };
    },

    userFromToken(token) {
      if (!token) return null;
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(token));
      if (!session || session.expires_at < nowIso()) return null;
      return publicUser(db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(session.user_id));
    },

    logout(token) {
      if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
    },

    // Device tokens let other machines (desktops, branches) sync with this server.
    createDevice(name) {
      const token = `dev_${randomBytes(24).toString('hex')}`;
      const device = { id: newId(), name: text(name) || 'Device', token_hash: sha256(token), created_at: nowIso(), revoked: 0 };
      insertRow(db, 'devices', device);
      return { id: device.id, name: device.name, token };
    },

    listDevices() {
      return db.prepare('SELECT id, name, created_at, revoked FROM devices ORDER BY created_at').all();
    },

    revokeDevice(id) {
      db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(id);
    },

    deviceFromToken(token) {
      if (!token) return null;
      const device = db.prepare('SELECT id, name FROM devices WHERE token_hash = ? AND revoked = 0').get(sha256(token));
      return device || null;
    },
  };
}

module.exports = { createAuth, ROLES, hashPassword, verifyPassword };
