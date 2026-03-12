const express = require('express');
const router = express.Router();
const { makeAuditLog } = require('../db/tenantDb');
const { requireAuth } = require('../middleware/auth');
const { adminOnly, requireRole } = require('../middleware/role');

// All properties routes require login
router.use(requireAuth);

// ─── GET /properties — list ───────────────────────────────────
router.get('/', (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const search = req.query.search || '';
  const statusFilter = req.query.status || '';

  let query = `
    SELECT p.*,
      (SELECT COUNT(*) FROM sub_properties sp2
        WHERE sp2.property_id = p.id AND sp2.is_archived = 0
          AND sp2.id NOT IN (SELECT virtual_sub_property_id FROM unit_groups)
      ) AS unit_count,
      (SELECT COUNT(*) FROM sub_properties sp2
        WHERE sp2.property_id = p.id AND sp2.is_archived = 0
          AND sp2.id NOT IN (SELECT virtual_sub_property_id FROM unit_groups)
          AND (sp2.status = 'rented'
               OR sp2.id IN (
                 SELECT ugm.sub_property_id FROM unit_group_members ugm
                 JOIN unit_groups ug2 ON ug2.id = ugm.group_id
                 JOIN sub_properties vsp ON vsp.id = ug2.virtual_sub_property_id
                 WHERE vsp.status = 'rented' AND vsp.property_id = p.id
               ))
      ) AS rented_count,
      (SELECT COUNT(*) FROM sub_properties sp2
        WHERE sp2.property_id = p.id AND sp2.is_archived = 0
          AND sp2.id NOT IN (SELECT virtual_sub_property_id FROM unit_groups)
          AND (sp2.status = 'new'
               OR sp2.id IN (
                 SELECT ugm.sub_property_id FROM unit_group_members ugm
                 JOIN unit_groups ug2 ON ug2.id = ugm.group_id
                 JOIN sub_properties vsp ON vsp.id = ug2.virtual_sub_property_id
                 WHERE vsp.status = 'new' AND vsp.property_id = p.id
               ))
      ) AS vacant_count,
      COUNT(DISTINCT ug.id) AS merge_group_count,
      COUNT(DISTINCT ugm_kpi.sub_property_id) AS merged_unit_count
    FROM properties p
    LEFT JOIN unit_groups ug ON ug.property_id = p.id
    LEFT JOIN unit_group_members ugm_kpi ON ugm_kpi.group_id = ug.id
    WHERE p.is_archived = 0
  `;
  const params = [];

  if (search) {
    query += ` AND (p.name LIKE ? OR p.location LIKE ? OR p.address LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (statusFilter) {
    query += ` AND p.status = ?`;
    params.push(statusFilter);
  }

  query += ` GROUP BY p.id ORDER BY p.name ASC`;

  const properties = db.prepare(query).all(...params);

  res.render('properties/index', {
    title: 'Properties',
    currentPath: '/properties',
    properties,
    search,
    statusFilter,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── GET /properties/new ──────────────────────────────────────
router.get('/new', adminOnly, (req, res) => {
  res.render('properties/form', {
    title: 'New Property',
    currentPath: '/properties',
    property: null,
    errors: []
  });
});

// ─── POST /properties ─────────────────────────────────────────
router.post('/', adminOnly, (req, res) => {
  const { name, location, address, status } = req.body;
  const errors = [];

  if (!name || !name.trim()) errors.push('Property name is required.');
  if (!['active', 'blocked'].includes(status)) errors.push('Invalid status.');

  if (errors.length) {
    return res.render('properties/form', {
      title: 'New Property',
      currentPath: '/properties',
      property: req.body,
      errors
    });
  }

  const db = req.db;
  const auditLog = makeAuditLog(db);
  const result = db.prepare(`
    INSERT INTO properties (name, location, address, status)
    VALUES (?, ?, ?, ?)
  `).run(name.trim(), (location || '').trim(), (address || '').trim(), status);

  auditLog(req.session.user.id, req.session.user.name, 'property_created', {
    property_id: result.lastInsertRowid, name
  });

  req.session.flash = { type: 'success', msg: `Property "${name}" created.` };
  res.redirect('/properties/' + result.lastInsertRowid);
});

// ─── GET /properties/:id ──────────────────────────────────────
router.get('/:id', (req, res) => {
  const db = req.db;
  const property = db.prepare(`SELECT * FROM properties WHERE id = ? AND is_archived = 0`).get(req.params.id);

  if (!property) {
    return res.status(404).render('404', { title: 'Not Found' });
  }

  const units = db.prepare(`
    SELECT sp.*,
      t.full_name AS tenant_name, t.id AS tenant_id, t.tel AS tenant_tel,
      ugm.group_id,
      vsp.id AS group_virtual_id,
      vsp.name AS group_name
    FROM sub_properties sp
    LEFT JOIN tenant_units tu ON tu.sub_property_id = sp.id AND tu.is_current = 1
    LEFT JOIN tenants t ON t.id = tu.tenant_id
    LEFT JOIN unit_group_members ugm ON ugm.sub_property_id = sp.id
    LEFT JOIN unit_groups ug ON ug.id = ugm.group_id
    LEFT JOIN sub_properties vsp ON vsp.id = ug.virtual_sub_property_id
    WHERE sp.property_id = ? AND sp.is_archived = 0
    ORDER BY sp.unit_number ASC, sp.name ASC
  `).all(req.params.id);

  // Virtual group unit IDs — used in the view to render GROUP badges
  const virtualUnitIds = db.prepare(`
    SELECT virtual_sub_property_id FROM unit_groups WHERE property_id = ?
  `).all(req.params.id).map(r => r.virtual_sub_property_id);

  // Count of active merge groups for this property (KPI)
  const mergeGroupCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM unit_groups WHERE property_id = ?
  `).get(req.params.id).cnt;

  res.render('properties/show', {
    title: property.name,
    currentPath: '/properties',
    property,
    units,
    virtualUnitIds,
    mergeGroupCount,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── GET /properties/:id/edit ─────────────────────────────────
router.get('/:id/edit', adminOnly, (req, res) => {
  const db = req.db;
  const property = db.prepare(`SELECT * FROM properties WHERE id = ? AND is_archived = 0`).get(req.params.id);

  if (!property) return res.status(404).render('404', { title: 'Not Found' });

  res.render('properties/form', {
    title: 'Edit Property',
    currentPath: '/properties',
    property,
    errors: []
  });
});

// ─── POST /properties/:id/edit ────────────────────────────────
router.post('/:id/edit', adminOnly, (req, res) => {
  const { name, location, address, status } = req.body;
  const errors = [];

  if (!name || !name.trim()) errors.push('Property name is required.');
  if (!['active', 'blocked'].includes(status)) errors.push('Invalid status.');

  const db = req.db;
  const auditLog = makeAuditLog(db);
  const property = db.prepare(`SELECT * FROM properties WHERE id = ? AND is_archived = 0`).get(req.params.id);
  if (!property) return res.status(404).render('404', { title: 'Not Found' });

  if (errors.length) {
    return res.render('properties/form', {
      title: 'Edit Property',
      currentPath: '/properties',
      property: { ...property, ...req.body },
      errors
    });
  }

  db.prepare(`
    UPDATE properties SET name = ?, location = ?, address = ?, status = ? WHERE id = ?
  `).run(name.trim(), (location || '').trim(), (address || '').trim(), status, req.params.id);

  auditLog(req.session.user.id, req.session.user.name, 'property_updated', {
    property_id: req.params.id, name
  });

  req.session.flash = { type: 'success', msg: `Property "${name}" updated.` };
  res.redirect('/properties/' + req.params.id);
});

// ─── POST /properties/:id/archive ────────────────────────────
router.post('/:id/archive', adminOnly, (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const property = db.prepare(`SELECT * FROM properties WHERE id = ? AND is_archived = 0`).get(req.params.id);
  if (!property) return res.status(404).render('404', { title: 'Not Found' });

  // Check for active tenants
  const activeTenants = db.prepare(`
    SELECT COUNT(*) AS cnt FROM tenant_units tu
    JOIN sub_properties sp ON sp.id = tu.sub_property_id
    WHERE sp.property_id = ? AND tu.is_current = 1
  `).get(req.params.id);

  if (activeTenants.cnt > 0) {
    req.session.flash = { type: 'danger', msg: 'Cannot archive: property has active tenant(s). Remove all tenants first.' };
    return res.redirect('/properties/' + req.params.id);
  }

  db.prepare(`
    UPDATE properties
    SET is_archived = 1, archived_at = CURRENT_TIMESTAMP, archived_by = ?
    WHERE id = ?
  `).run(req.session.user.id, req.params.id);

  // Also archive all units
  db.prepare(`
    UPDATE sub_properties
    SET is_archived = 1, archived_at = CURRENT_TIMESTAMP, archived_by = ?
    WHERE property_id = ? AND is_archived = 0
  `).run(req.session.user.id, req.params.id);

  auditLog(req.session.user.id, req.session.user.name, 'property_archived', {
    property_id: req.params.id, name: property.name
  });

  req.session.flash = { type: 'success', msg: `Property "${property.name}" archived.` };
  res.redirect('/properties');
});

module.exports = router;
