const express = require('express');
const router = express.Router();
const { makeAuditLog } = require('../db/tenantDb');
const { requireAuth } = require('../middleware/auth');
const { adminOnly } = require('../middleware/role');

router.use(requireAuth);
router.use(adminOnly);

// ─── GET /archive ─────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = req.db;
  const tab = req.query.tab || 'properties';

  const archivedProperties = db.prepare(`
    SELECT p.*, u.name AS archived_by_name
    FROM properties p
    LEFT JOIN users u ON u.id = p.archived_by
    WHERE p.is_archived = 1
    ORDER BY p.archived_at DESC
  `).all();

  const archivedUnits = db.prepare(`
    SELECT sp.*, p.name AS property_name, u.name AS archived_by_name
    FROM sub_properties sp
    JOIN properties p ON p.id = sp.property_id
    LEFT JOIN users u ON u.id = sp.archived_by
    WHERE sp.is_archived = 1
    ORDER BY sp.archived_at DESC
  `).all();

  res.render('archive/index', {
    title: 'Archive', currentPath: '/archive',
    archivedProperties, archivedUnits, tab,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── POST /archive/properties/:id/restore ────────────────────
router.post('/properties/:id/restore', (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const prop = db.prepare(`SELECT * FROM properties WHERE id = ? AND is_archived = 1`).get(req.params.id);
  if (!prop) return res.status(404).render('404', { title: 'Not Found' });

  db.prepare(`UPDATE properties SET is_archived = 0, archived_at = NULL, archived_by = NULL WHERE id = ?`).run(req.params.id);

  auditLog(req.session.user.id, req.session.user.name, 'property_restored', { property_id: req.params.id, name: prop.name });

  req.session.flash = { type: 'success', msg: `Property "${prop.name}" restored.` };
  res.redirect('/archive?tab=properties');
});

// ─── POST /archive/units/:id/restore ─────────────────────────
router.post('/units/:id/restore', (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const unit = db.prepare(`SELECT * FROM sub_properties WHERE id = ? AND is_archived = 1`).get(req.params.id);
  if (!unit) return res.status(404).render('404', { title: 'Not Found' });

  db.prepare(`UPDATE sub_properties SET is_archived = 0, archived_at = NULL, archived_by = NULL WHERE id = ?`).run(req.params.id);

  auditLog(req.session.user.id, req.session.user.name, 'unit_restored', { unit_id: req.params.id, name: unit.name });

  req.session.flash = { type: 'success', msg: `Unit "${unit.name}" restored.` };
  res.redirect('/archive?tab=units');
});

module.exports = router;
