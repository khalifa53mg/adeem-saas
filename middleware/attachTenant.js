const { getTenantDb } = require('../db/tenantDb');
const { getMasterDb } = require('../db/masterDb');

function attachTenantDb(req, res, next) {
  const slug = req.session && req.session.tenantSlug;
  if (!slug) return next();
  try {
    req.db = getTenantDb(slug);
    req.tenant = getMasterDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
    res.locals.tenant = req.tenant;
    res.locals.tenantName = req.tenant ? req.tenant.company_name : '';
  } catch (e) {
    console.error('attachTenant error:', e.message);
  }
  next();
}

module.exports = { attachTenantDb };
