const express = require('express');
const router = express.Router();
const { makeAuditLog } = require('../db/tenantDb');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');

router.use(requireAuth);
router.use(requireRole('admin'));

// ─── GET /tenants ─────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = req.db;
  const search = req.query.search || '';
  const statusFilter = req.query.status || '';

  let query = `
    SELECT t.*,
      COUNT(DISTINCT CASE WHEN tu.is_current = 1 THEN tu.id END) AS active_units
    FROM tenants t
    LEFT JOIN tenant_units tu ON tu.tenant_id = t.id
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    query += ` AND (t.full_name LIKE ? OR t.tel LIKE ? OR t.address LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (statusFilter) {
    query += ` AND t.status = ?`;
    params.push(statusFilter);
  }

  query += ` GROUP BY t.id ORDER BY t.full_name ASC`;

  const tenants = db.prepare(query).all(...params);

  res.render('tenants/index', {
    title: 'Tenants', currentPath: '/tenants',
    tenants, search, statusFilter,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── GET /tenants/new ─────────────────────────────────────────
router.get('/new', (req, res) => {
  res.render('tenants/form', {
    title: 'New Tenant', currentPath: '/tenants',
    tenant: null, errors: []
  });
});

// ─── POST /tenants ────────────────────────────────────────────
router.post('/', (req, res) => {
  const { full_name, tel, fax, po_box, address, status } = req.body;
  const errors = [];
  if (!full_name || !full_name.trim()) errors.push('Full name is required.');

  if (errors.length) {
    return res.render('tenants/form', {
      title: 'New Tenant', currentPath: '/tenants', tenant: req.body, errors
    });
  }

  const db = req.db;
  const auditLog = makeAuditLog(db);
  const result = db.prepare(`
    INSERT INTO tenants (full_name, tel, fax, po_box, address, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(full_name.trim(), (tel || '').trim(), (fax || '').trim(), (po_box || '').trim(), (address || '').trim(), status || 'active');

  auditLog(req.session.user.id, req.session.user.name, 'tenant_created', { tenant_id: result.lastInsertRowid, full_name });

  req.session.flash = { type: 'success', msg: `Tenant "${full_name}" created.` };
  res.redirect('/tenants/' + result.lastInsertRowid);
});

// ─── GET /tenants/:id ─────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db = req.db;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(req.params.id);
  if (!tenant) return res.status(404).render('404', { title: 'Not Found' });

  const leases = db.prepare(`
    SELECT tu.*, sp.name AS unit_name, sp.unit_number, sp.monthly_rent_bhd,
      p.name AS property_name, p.id AS property_id, sp.id AS unit_id
    FROM tenant_units tu
    JOIN sub_properties sp ON sp.id = tu.sub_property_id
    JOIN properties p ON p.id = sp.property_id
    WHERE tu.tenant_id = ?
    ORDER BY tu.is_current DESC, tu.lease_start DESC
  `).all(req.params.id);

  const payments = db.prepare(`
    SELECT p.*, sp.name AS unit_name, sp.unit_number, prop.name AS property_name
    FROM payments p
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    WHERE p.tenant_id = ?
    ORDER BY p.payment_date DESC
    LIMIT 15
  `).all(req.params.id);

  const tSettings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  res.render('tenants/show', {
    title: tenant.full_name, currentPath: '/tenants',
    tenant, leases, payments,
    currencyLabel: (tSettings && tSettings.currency_label) || 'BD',
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── GET /tenants/:id/edit ────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const db = req.db;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(req.params.id);
  if (!tenant) return res.status(404).render('404', { title: 'Not Found' });

  res.render('tenants/form', {
    title: 'Edit Tenant', currentPath: '/tenants', tenant, errors: []
  });
});

// ─── POST /tenants/:id/edit ───────────────────────────────────
router.post('/:id/edit', (req, res) => {
  const { full_name, tel, fax, po_box, address, status } = req.body;
  const errors = [];
  if (!full_name || !full_name.trim()) errors.push('Full name is required.');

  const db = req.db;
  const auditLog = makeAuditLog(db);
  const tenant = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(req.params.id);
  if (!tenant) return res.status(404).render('404', { title: 'Not Found' });

  if (errors.length) {
    return res.render('tenants/form', {
      title: 'Edit Tenant', currentPath: '/tenants',
      tenant: { ...tenant, ...req.body }, errors
    });
  }

  db.prepare(`
    UPDATE tenants SET full_name = ?, tel = ?, fax = ?, po_box = ?, address = ?, status = ? WHERE id = ?
  `).run(full_name.trim(), (tel || '').trim(), (fax || '').trim(), (po_box || '').trim(), (address || '').trim(), status, req.params.id);

  auditLog(req.session.user.id, req.session.user.name, 'tenant_updated', { tenant_id: req.params.id, full_name });

  req.session.flash = { type: 'success', msg: `Tenant "${full_name}" updated.` };
  res.redirect('/tenants/' + req.params.id);
});

module.exports = router;
