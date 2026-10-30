'use strict';

const { ensure, rate, text } = require('./util');
const { STATE_NAMES, isValidGstin, isValidPan, stateOfGstin } = require('./india');

const DEFAULTS = {
  company_name: 'My Hardware Shop',
  company_address: '',
  company_phone: '',
  company_gstin: '',
  company_state_code: '',
  company_pan: '',
  currency: '₹',
  default_tax_rate: 0,
  gst_registered: true,
  gst_billing: true,
  prices_include_gst: true,
  round_invoice_totals: true,
  receipt_footer: 'Thank you for shopping with us!',
  allow_negative_stock: false,
};

const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

const CHECKS = {
  default_tax_rate: (v) => rate(v, 'Default GST rate'),
  gst_registered: bool,
  gst_billing: bool,
  prices_include_gst: bool,
  round_invoice_totals: bool,
  allow_negative_stock: bool,
  company_gstin: (v) => {
    const gstin = text(v).toUpperCase();
    ensure(!gstin || isValidGstin(gstin), 'Shop GSTIN is not valid. Check the 15 characters.');
    return gstin;
  },
  company_state_code: (v) => {
    const code = text(v);
    ensure(!code || STATE_NAMES[code], 'Choose a valid state');
    return code;
  },
  company_pan: (v) => {
    const pan = text(v).toUpperCase();
    ensure(!pan || isValidPan(pan), 'PAN must be 10 characters, like ABCDE1234F');
    return pan;
  },
};

// Synced key/value settings shared by every machine in the same shop.
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
      const next = { ...all() };
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULTS)) continue;
        next[key] = CHECKS[key] ? CHECKS[key](value) : text(value);
      }
      const gstState = stateOfGstin(next.company_gstin);
      ensure(
        !next.company_gstin || !next.company_state_code || gstState === next.company_state_code,
        'The state must match the first two digits of the GSTIN',
      );
      for (const key of Object.keys(patch)) {
        if (!(key in DEFAULTS)) continue;
        repo.save('settings', { id: key, value: JSON.stringify(next[key]) });
      }
      return all();
    },
  };
}

module.exports = { createSettings, DEFAULTS };
