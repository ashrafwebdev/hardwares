'use strict';

const { randomUUID, createHash } = require('node:crypto');

class ERPError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ERPError';
    this.status = status;
  }
}

function fail(message, status = 400) {
  throw new ERPError(message, status);
}

function ensure(condition, message, status = 400) {
  if (!condition) fail(message, status);
}

const newId = () => randomUUID();
const nowIso = () => new Date().toISOString();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Local calendar date as YYYY-MM-DD (shop day, not UTC day).
function localDate(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const text = (value) => (value == null ? '' : String(value).trim());

function cents(value, field = 'Amount') {
  const n = Number(value);
  ensure(Number.isFinite(n), `${field} must be a number`);
  return Math.round(n);
}

function qtyOf(value, field = 'Quantity') {
  const n = Number(value);
  ensure(Number.isFinite(n), `${field} must be a number`);
  return Math.round(n * 1000) / 1000;
}

function rate(value, field = 'Tax rate') {
  const n = Number(value);
  ensure(Number.isFinite(n) && n >= 0 && n <= 100, `${field} must be between 0 and 100`);
  return n;
}

const ref = (value) => text(value) || null;
const flag = (value) => (value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0);

// Copy only the fields that were supplied, passing each through its transform.
function pick(data, spec) {
  const out = {};
  for (const [key, transform] of Object.entries(spec)) {
    if (data[key] !== undefined) out[key] = transform(data[key]);
  }
  return out;
}

function sum(values) {
  return values.reduce((total, v) => total + v, 0);
}

module.exports = {
  ERPError, fail, ensure, newId, nowIso, sha256, localDate, text, cents, qtyOf, rate, ref, flag, pick, sum,
};
