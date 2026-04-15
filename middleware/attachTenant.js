const { getTenantDb } = require('../db/tenantDb');
const { getMasterDb } = require('../db/masterDb');
const { getCurrencyDecimals } = require('../utils/currency');

function attachTenantDb(req, res, next) {
  const slug = req.session && req.session.tenantSlug;
  if (!slug) return next();
  try {
    req.db = getTenantDb(slug);
    req.tenant = getMasterDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
    res.locals.tenant = req.tenant;
    res.locals.tenantName = req.tenant ? req.tenant.company_name : '';
    res.locals.currencyDecimals = getCurrencyDecimals(req.tenant && req.tenant.currency_code);
  } catch (e) {
    console.error('attachTenant error:', e.message);
  }
  next();
}

module.exports = { attachTenantDb };
