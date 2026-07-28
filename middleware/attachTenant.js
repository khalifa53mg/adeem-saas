const { getTenantDb } = require('../db/tenantDb');
const { getMasterDb } = require('../db/masterDb');
const { getCurrencyDecimals } = require('../utils/currency');
const { getActiveMethods, getMethodMap, methodLabel } = require('../utils/paymentMethods');

function attachTenantDb(req, res, next) {
  const slug = req.session && req.session.tenantSlug;
  if (!slug) return next();
  try {
    req.db = getTenantDb(slug);
    req.tenant = getMasterDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
    res.locals.tenant = req.tenant;
    res.locals.tenantName = req.tenant ? req.tenant.company_name : '';
    res.locals.currencyDecimals = getCurrencyDecimals(req.tenant && req.tenant.currency_code);
    // Payment methods are tenant-configurable; every view that renders a method
    // badge or filter reads them from here rather than a hardcoded list.
    res.locals.paymentMethods   = getActiveMethods(req.db);
    res.locals.paymentMethodMap = getMethodMap(req.db);
    res.locals.methodLabel      = methodLabel;
  } catch (e) {
    console.error('attachTenant error:', e.message);
  }
  next();
}

module.exports = { attachTenantDb };
