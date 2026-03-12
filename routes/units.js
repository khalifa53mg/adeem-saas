const express = require('express');
const router = express.Router();
const { makeAuditLog } = require('../db/tenantDb');
const { requireAuth } = require('../middleware/auth');
const { adminOnly, adminOrCashier } = require('../middleware/role');

router.use(requireAuth);

// ─── GET /units/new ───────────────────────────────────────────
router.get('/new', adminOnly, (req, res) => {
  const db = req.db;
  const properties = db.prepare(`SELECT id, name FROM properties WHERE is_archived = 0 AND status = 'active' ORDER BY name`).all();
  const selectedPropertyId = req.query.property_id || '';

  res.render('units/form', {
    title: 'New Unit',
    currentPath: '/properties',
    unit: null,
    properties,
    selectedPropertyId,
    errors: []
  });
});

// ─── POST /units ──────────────────────────────────────────────
router.post('/', adminOnly, (req, res) => {
  const { property_id, unit_number, address, monthly_rent_bhd, status } = req.body;
  const errors = [];
  const db = req.db;
  const auditLog = makeAuditLog(db);

  if (!property_id) errors.push('Property is required.');
  if (!unit_number || !unit_number.trim()) errors.push('Unit number is required.');
  const rent = parseFloat(monthly_rent_bhd);
  if (isNaN(rent) || rent < 0) errors.push('Monthly rent must be a valid number.');
  if (!['new', 'rented', 'blocked'].includes(status)) errors.push('Invalid status.');

  if (errors.length) {
    const properties = db.prepare(`SELECT id, name FROM properties WHERE is_archived = 0 AND status = 'active' ORDER BY name`).all();
    return res.render('units/form', {
      title: 'New Unit', currentPath: '/properties',
      unit: req.body, properties, selectedPropertyId: property_id, errors
    });
  }

  const unitNum = unit_number.trim();
  const result = db.prepare(`
    INSERT INTO sub_properties (property_id, name, unit_number, address, monthly_rent_bhd, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(property_id, unitNum, unitNum, (address || '').trim(), rent, status);

  auditLog(req.session.user.id, req.session.user.name, 'unit_created', {
    unit_id: result.lastInsertRowid, property_id, unit_number: unitNum
  });

  req.session.flash = { type: 'success', msg: `Unit "${unitNum}" created.` };
  res.redirect('/units/' + result.lastInsertRowid);
});

// ─── GET /units/merge — merge confirmation page ───────────────
router.get('/merge', adminOnly, (req, res) => {
  const db = req.db;
  const idsParam = req.query.ids || '';
  const ids = idsParam.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

  if (ids.length < 2) {
    req.session.flash = { type: 'danger', msg: 'Select at least 2 units to merge.' };
    return res.redirect('/properties');
  }

  const placeholders = ids.map(() => '?').join(',');
  const units = db.prepare(`
    SELECT sp.*, p.id AS property_id, p.name AS property_name
    FROM sub_properties sp
    JOIN properties p ON p.id = sp.property_id
    WHERE sp.id IN (${placeholders}) AND sp.is_archived = 0
  `).all(...ids);

  if (units.length !== ids.length) {
    req.session.flash = { type: 'danger', msg: 'One or more units not found.' };
    return res.redirect('/properties');
  }

  const propertyIds = [...new Set(units.map(u => u.property_id))];
  if (propertyIds.length > 1) {
    req.session.flash = { type: 'danger', msg: 'All units must belong to the same property.' };
    return res.redirect('/properties/' + propertyIds[0]);
  }

  const inGroup = db.prepare(`SELECT COUNT(*) AS cnt FROM unit_group_members WHERE sub_property_id IN (${placeholders})`).get(...ids);
  if (inGroup.cnt > 0) {
    req.session.flash = { type: 'danger', msg: 'One or more units are already part of a merge group.' };
    return res.redirect('/properties/' + propertyIds[0]);
  }

  const blocked = units.find(u => u.status === 'blocked');
  if (blocked) {
    req.session.flash = { type: 'danger', msg: `Unit "${blocked.unit_number || blocked.name}" is blocked and cannot be merged.` };
    return res.redirect('/properties/' + propertyIds[0]);
  }

  const defaultName = units.map(u => (u.unit_number ? u.unit_number + ' ' + u.name : u.name)).join(' + ');
  const defaultRent = units.reduce((sum, u) => sum + u.monthly_rent_bhd, 0);

  res.render('units/merge', {
    title: 'Merge Units',
    currentPath: '/properties',
    units,
    property: { id: propertyIds[0], name: units[0].property_name },
    defaultName,
    defaultRent: defaultRent.toFixed(3),
    idsParam,
    errors: []
  });
});

// ─── POST /units/merge ────────────────────────────────────────
router.post('/merge', adminOnly, (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const idsParam = req.body.ids || '';
  const ids = idsParam.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  const name = (req.body.name || '').trim();
  const rent = parseFloat(req.body.monthly_rent_bhd);
  const errors = [];

  if (ids.length < 2) errors.push('Select at least 2 units to merge.');
  if (!name) errors.push('Group name is required.');
  if (isNaN(rent) || rent <= 0) errors.push('Combined rent must be greater than 0.');

  let units = [];
  let propertyId = null;

  if (!errors.length) {
    const placeholders = ids.map(() => '?').join(',');
    units = db.prepare(`
      SELECT sp.*, p.id AS property_id, p.name AS property_name
      FROM sub_properties sp
      JOIN properties p ON p.id = sp.property_id
      WHERE sp.id IN (${placeholders}) AND sp.is_archived = 0
    `).all(...ids);

    if (units.length !== ids.length) errors.push('One or more units not found.');
    else {
      const propertyIds = [...new Set(units.map(u => u.property_id))];
      if (propertyIds.length > 1) errors.push('All units must belong to the same property.');

      const inGroup = db.prepare(`SELECT COUNT(*) AS cnt FROM unit_group_members WHERE sub_property_id IN (${placeholders})`).get(...ids);
      if (inGroup.cnt > 0) errors.push('One or more units are already part of a merge group.');

      const blocked = units.find(u => u.status === 'blocked');
      if (blocked) errors.push(`Unit "${blocked.unit_number || blocked.name}" is blocked and cannot be merged.`);

      propertyId = propertyIds[0];
    }
  }

  if (!errors.length) {
    const placeholders = ids.map(() => '?').join(',');
    const doMerge = db.transaction(() => {
      const virtualUnit = db.prepare(`
        INSERT INTO sub_properties (property_id, name, unit_number, monthly_rent_bhd, status)
        VALUES (?, ?, '', ?, 'new')
      `).run(propertyId, name, rent);
      const virtualId = virtualUnit.lastInsertRowid;

      const group = db.prepare(`
        INSERT INTO unit_groups (virtual_sub_property_id, property_id) VALUES (?, ?)
      `).run(virtualId, propertyId);
      const groupId = group.lastInsertRowid;

      const insertMember = db.prepare(`INSERT INTO unit_group_members (group_id, sub_property_id) VALUES (?, ?)`);
      for (const id of ids) insertMember.run(groupId, id);

      db.prepare(`UPDATE sub_properties SET status = 'blocked' WHERE id IN (${placeholders})`).run(...ids);
      return virtualId;
    });

    const virtualId = doMerge();
    auditLog(req.session.user.id, req.session.user.name, 'units_merged', {
      group_name: name, member_ids: ids, virtual_id: virtualId
    });

    req.session.flash = { type: 'success', msg: `Units merged into "${name}".` };
    return res.redirect('/units/' + virtualId);
  }

  // Re-render with errors
  if (ids.length > 0 && units.length === 0) {
    const placeholders = ids.map(() => '?').join(',');
    units = db.prepare(`
      SELECT sp.*, p.id AS property_id, p.name AS property_name
      FROM sub_properties sp JOIN properties p ON p.id = sp.property_id
      WHERE sp.id IN (${placeholders}) AND sp.is_archived = 0
    `).all(...ids);
  }
  const defaultRent = units.reduce((sum, u) => sum + u.monthly_rent_bhd, 0);
  res.render('units/merge', {
    title: 'Merge Units',
    currentPath: '/properties',
    units,
    property: units.length > 0 ? { id: units[0].property_id, name: units[0].property_name } : null,
    defaultName: name,
    defaultRent: defaultRent.toFixed(3),
    idsParam,
    errors
  });
});

// ─── POST /units/groups/:id/dissolve ─────────────────────────
router.post('/groups/:id/dissolve', adminOnly, (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const group = db.prepare(`SELECT * FROM unit_groups WHERE id = ?`).get(req.params.id);
  if (!group) {
    req.session.flash = { type: 'danger', msg: 'Group not found.' };
    return res.redirect('/properties');
  }

  const paymentCount = db.prepare(`SELECT COUNT(*) AS cnt FROM payments WHERE sub_property_id = ?`)
    .get(group.virtual_sub_property_id);
  if (paymentCount.cnt > 0) {
    req.session.flash = { type: 'danger', msg: 'Cannot dissolve: group unit has payment records.' };
    return res.redirect('/units/' + group.virtual_sub_property_id);
  }

  const activeLease = db.prepare(`SELECT id FROM tenant_units WHERE sub_property_id = ? AND is_current = 1`)
    .get(group.virtual_sub_property_id);
  if (activeLease) {
    req.session.flash = { type: 'danger', msg: 'Cannot dissolve: group unit has an active tenant. Vacate first.' };
    return res.redirect('/units/' + group.virtual_sub_property_id);
  }

  const members = db.prepare(`SELECT sub_property_id FROM unit_group_members WHERE group_id = ?`).all(group.id);
  const memberIds = members.map(m => m.sub_property_id);
  const placeholders = memberIds.map(() => '?').join(',');

  db.transaction(() => {
    db.prepare(`UPDATE sub_properties SET status = 'new' WHERE id IN (${placeholders})`).run(...memberIds);
    db.prepare(`DELETE FROM unit_group_members WHERE group_id = ?`).run(group.id);
    db.prepare(`DELETE FROM unit_groups WHERE id = ?`).run(group.id);
    db.prepare(`DELETE FROM sub_properties WHERE id = ?`).run(group.virtual_sub_property_id);
  })();

  auditLog(req.session.user.id, req.session.user.name, 'units_dissolved', {
    group_id: group.id, member_ids: memberIds
  });

  req.session.flash = { type: 'success', msg: 'Merge group dissolved. Units restored.' };
  res.redirect('/properties/' + group.property_id);
});

// ─── GET /units/:id ───────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db = req.db;
  const unit = db.prepare(`
    SELECT sp.*, p.name AS property_name, p.id AS property_id
    FROM sub_properties sp
    JOIN properties p ON p.id = sp.property_id
    WHERE sp.id = ? AND sp.is_archived = 0
  `).get(req.params.id);

  if (!unit) return res.status(404).render('404', { title: 'Not Found' });

  // Current tenant
  const currentTenant = db.prepare(`
    SELECT t.*, tu.lease_start, tu.lease_end, tu.id AS lease_id
    FROM tenant_units tu
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE tu.sub_property_id = ? AND tu.is_current = 1
    LIMIT 1
  `).get(req.params.id);

  // Tenant history
  const tenantHistory = db.prepare(`
    SELECT t.full_name, tu.lease_start, tu.lease_end, tu.is_current, tu.id AS lease_id
    FROM tenant_units tu
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE tu.sub_property_id = ?
    ORDER BY tu.lease_start DESC
  `).all(req.params.id);

  // Payment history (last 12)
  const payments = db.prepare(`
    SELECT p.*, t.full_name AS tenant_name
    FROM payments p
    JOIN tenants t ON t.id = p.tenant_id
    WHERE p.sub_property_id = ?
    ORDER BY p.payment_date DESC
    LIMIT 12
  `).all(req.params.id);

  // All tenants for assign modal
  const availableTenants = db.prepare(`SELECT id, full_name, tel FROM tenants WHERE status = 'active' ORDER BY full_name`).all();

  // Check if this is a virtual group unit
  const groupInfo = db.prepare(`SELECT * FROM unit_groups WHERE virtual_sub_property_id = ?`).get(req.params.id);
  let groupMembers = [];
  if (groupInfo) {
    groupMembers = db.prepare(`
      SELECT sp.id, sp.name, sp.unit_number, sp.monthly_rent_bhd, sp.status
      FROM unit_group_members ugm
      JOIN sub_properties sp ON sp.id = ugm.sub_property_id
      WHERE ugm.group_id = ?
      ORDER BY sp.unit_number ASC, sp.name ASC
    `).all(groupInfo.id);
  }

  // Check if this unit is a constituent of a merge group
  const memberOfGroup = db.prepare(`
    SELECT ug.id AS group_id, vsp.id AS virtual_id, vsp.name AS group_name
    FROM unit_group_members ugm
    JOIN unit_groups ug ON ug.id = ugm.group_id
    JOIN sub_properties vsp ON vsp.id = ug.virtual_sub_property_id
    WHERE ugm.sub_property_id = ?
  `).get(req.params.id);

  res.render('units/show', {
    title: `Unit: ${unit.name}`,
    currentPath: '/properties',
    unit, currentTenant, tenantHistory, payments, availableTenants,
    groupInfo, groupMembers, memberOfGroup,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── GET /units/:id/edit ──────────────────────────────────────
router.get('/:id/edit', adminOnly, (req, res) => {
  const db = req.db;
  const unit = db.prepare(`SELECT sp.*, p.name AS property_name FROM sub_properties sp JOIN properties p ON p.id = sp.property_id WHERE sp.id = ? AND sp.is_archived = 0`).get(req.params.id);
  if (!unit) return res.status(404).render('404', { title: 'Not Found' });

  const properties = db.prepare(`SELECT id, name FROM properties WHERE is_archived = 0 AND status = 'active' ORDER BY name`).all();

  res.render('units/form', {
    title: 'Edit Unit', currentPath: '/properties',
    unit, properties, selectedPropertyId: unit.property_id, errors: []
  });
});

// ─── POST /units/:id/edit ─────────────────────────────────────
router.post('/:id/edit', adminOnly, (req, res) => {
  const { property_id, unit_number, address, monthly_rent_bhd, status } = req.body;
  const errors = [];
  const db = req.db;
  const auditLog = makeAuditLog(db);

  const rent = parseFloat(monthly_rent_bhd);
  if (isNaN(rent) || rent < 0) errors.push('Monthly rent must be a valid number.');
  if (!['new', 'rented', 'blocked'].includes(status)) errors.push('Invalid status.');

  const unit = db.prepare(`SELECT sp.*, p.name AS property_name FROM sub_properties sp JOIN properties p ON p.id = sp.property_id WHERE sp.id = ? AND sp.is_archived = 0`).get(req.params.id);
  if (!unit) return res.status(404).render('404', { title: 'Not Found' });

  if (errors.length) {
    const properties = db.prepare(`SELECT id, name FROM properties WHERE is_archived = 0 ORDER BY name`).all();
    return res.render('units/form', {
      title: 'Edit Unit', currentPath: '/properties',
      unit: { ...unit, ...req.body }, properties, selectedPropertyId: property_id, errors
    });
  }

  const unitNum = (unit_number || '').trim();
  db.prepare(`
    UPDATE sub_properties SET name = ?, unit_number = ?, address = ?, monthly_rent_bhd = ?, status = ?
    WHERE id = ?
  `).run(unitNum, unitNum, (address || '').trim(), rent, status, req.params.id);

  auditLog(req.session.user.id, req.session.user.name, 'unit_updated', { unit_id: req.params.id, unit_number: unitNum });

  req.session.flash = { type: 'success', msg: `Unit "${unitNum}" updated.` };
  res.redirect('/units/' + req.params.id);
});

// ─── POST /units/:id/assign — assign tenant ──────────────────
router.post('/:id/assign', adminOnly, (req, res) => {
  const { tenant_id, lease_start, lease_end } = req.body;
  const db = req.db;
  const auditLog = makeAuditLog(db);

  const unit = db.prepare(`SELECT * FROM sub_properties WHERE id = ? AND is_archived = 0`).get(req.params.id);
  if (!unit) return res.status(404).render('404', { title: 'Not Found' });

  // End any existing current lease for this unit
  db.prepare(`UPDATE tenant_units SET is_current = 0, lease_end = ? WHERE sub_property_id = ? AND is_current = 1`)
    .run(lease_start, req.params.id);

  // Create new lease
  db.prepare(`
    INSERT INTO tenant_units (tenant_id, sub_property_id, lease_start, lease_end, is_current)
    VALUES (?, ?, ?, ?, 1)
  `).run(tenant_id, req.params.id, lease_start, lease_end || null);

  // Update unit status
  db.prepare(`UPDATE sub_properties SET status = 'rented' WHERE id = ?`).run(req.params.id);

  auditLog(req.session.user.id, req.session.user.name, 'tenant_assigned', {
    unit_id: req.params.id, tenant_id, lease_start
  });

  req.session.flash = { type: 'success', msg: 'Tenant assigned successfully.' };
  res.redirect('/units/' + req.params.id);
});

// ─── POST /units/:id/vacate — end lease ──────────────────────
router.post('/:id/vacate', adminOnly, (req, res) => {
  const { lease_end } = req.body;
  const db = req.db;
  const auditLog = makeAuditLog(db);

  const unit = db.prepare(`SELECT * FROM sub_properties WHERE id = ? AND is_archived = 0`).get(req.params.id);
  if (!unit) return res.status(404).render('404', { title: 'Not Found' });

  db.prepare(`UPDATE tenant_units SET is_current = 0, lease_end = ? WHERE sub_property_id = ? AND is_current = 1`)
    .run(lease_end || new Date().toISOString().slice(0, 10), req.params.id);

  db.prepare(`UPDATE sub_properties SET status = 'new' WHERE id = ?`).run(req.params.id);

  auditLog(req.session.user.id, req.session.user.name, 'unit_vacated', { unit_id: req.params.id });

  req.session.flash = { type: 'success', msg: 'Unit marked as vacant.' };
  res.redirect('/units/' + req.params.id);
});

// ─── POST /units/:id/archive ──────────────────────────────────
router.post('/:id/archive', adminOnly, (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const unit = db.prepare(`SELECT * FROM sub_properties WHERE id = ? AND is_archived = 0`).get(req.params.id);
  if (!unit) return res.status(404).render('404', { title: 'Not Found' });

  const activeLease = db.prepare(`SELECT id FROM tenant_units WHERE sub_property_id = ? AND is_current = 1`).get(req.params.id);
  if (activeLease) {
    req.session.flash = { type: 'danger', msg: 'Cannot archive: unit has an active tenant. Vacate first.' };
    return res.redirect('/units/' + req.params.id);
  }

  db.prepare(`UPDATE sub_properties SET is_archived = 1, archived_at = CURRENT_TIMESTAMP, archived_by = ? WHERE id = ?`)
    .run(req.session.user.id, req.params.id);

  auditLog(req.session.user.id, req.session.user.name, 'unit_archived', { unit_id: req.params.id, name: unit.name });

  req.session.flash = { type: 'success', msg: `Unit "${unit.name}" archived.` };
  res.redirect('/properties/' + unit.property_id);
});

module.exports = router;
