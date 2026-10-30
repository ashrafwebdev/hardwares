'use strict';

const { rate, text } = require('./util');

const DEFAULTS = {
  company_name: 'My Hardware Shop',
  company_address: '',
  company_phone: '',
  company_tax_no: '',
  currency: '$',
  default_tax_rate: 0,
  receipt_footer: 'Thank you for shopping with us!',
  allow_negative_stock: false,
};

const CHECKS = {
  default_tax_rate: (v) => rate(v, 'Default tax rate'),
  allow_negative_stock: (v) => v === true || v === 'true' || v === 1 || v === '1',
};

// Synced key/value settings shared by every machine on the same shop.
function createSettings({ repo }) {
  function all() {
    const out = { ...DEFAULTS };
    for (const row of repo.list('settings')) {
      if (row.id in DEFAULTS) out[row.id] = JSON.parse(row.value);
    }
    return out;
  }

  return {
    defaults: DEFAULTS,
    all,
    get: (key) => all()[key],

    save(patch = {}) {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULTS)) continue;
        const clean = CHECKS[key] ? CHECKS[key](value) : text(value);
        repo.save('settings', { id: key, value: JSON.stringify(clean) });
      }
      return all();
    },
  };
}

module.exports = { createSettings, DEFAULTS };
