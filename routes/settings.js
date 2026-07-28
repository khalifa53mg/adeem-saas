const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { makeAuditLog } = require('../db/tenantDb');
const { getMasterDb } = require('../db/masterDb');
const { requireAuth } = require('../middleware/auth');
const { adminOnly } = require('../middleware/role');
const { BADGE_COLORS, getAllMethods } = require('../utils/paymentMethods');

// Logo upload storage — per-tenant directory
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const slug = req.session.tenantSlug || 'default';
    const dir = path.join(__dirname, '../public/uploads', slug);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `logo${ext}`);
  }
});
const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|gif|webp|svg\+xml)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed (JPEG, PNG, GIF, WebP, SVG)'));
  }
});

router.use(requireAuth);
router.use(adminOnly);

// ─── GET /settings ────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = req.db;
  const settings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  res.render('settings/index', {
    title: 'Settings', currentPath: '/settings',
    settings, errors: [],
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── POST /settings ───────────────────────────────────────────
router.post('/', (req, res) => {
  const { owner_name, tel, fax, po_box, address, currency_label, receipt_footer_note, next_receipt_number } = req.body;
  const errors = [];
  if (!owner_name || !owner_name.trim()) errors.push('Owner name is required.');
  const nextNum = parseInt(next_receipt_number);
  if (isNaN(nextNum) || nextNum < 1) errors.push('Next receipt number must be a positive integer.');

  const db = req.db;
  const auditLog = makeAuditLog(db);
  const settings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();

  if (errors.length) {
    return res.render('settings/index', {
      title: 'Settings', currentPath: '/settings',
      settings: { ...settings, ...req.body }, errors, flash: null
    });
  }

  db.prepare(`
    UPDATE settings SET owner_name = ?, tel = ?, fax = ?, po_box = ?, address = ?,
      currency_label = ?, receipt_footer_note = ?, next_receipt_number = ?,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    owner_name.trim(), (tel || '').trim(), (fax || '').trim(), (po_box || '').trim(),
    (address || '').trim(), (currency_label || 'Bahrain Dinars').trim(),
    (receipt_footer_note || '').trim(), nextNum
  );

  // Sync company name back to master DB so super admin dashboard stays in sync
  if (req.session.tenantSlug) {
    getMasterDb().prepare(
      'UPDATE tenants SET company_name = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?'
    ).run(owner_name.trim(), req.session.tenantSlug);
  }

  auditLog(req.session.user.id, req.session.user.name, 'settings_updated', {});

  req.session.flash = { type: 'success', msg: 'Settings saved.' };
  res.redirect('/settings');
});

// ─── POST /settings/logo ─────────────────────────────────────
router.post('/logo', (req, res, next) => {
  uploadLogo.single('logo')(req, res, (err) => {
    if (err) {
      req.session.flash = { type: 'danger', msg: err.message };
      return res.redirect('/settings');
    }
    if (!req.file) {
      req.session.flash = { type: 'danger', msg: 'No file uploaded.' };
      return res.redirect('/settings');
    }
    const db = req.db;
    const auditLog = makeAuditLog(db);
    const slug = req.session.tenantSlug || 'default';
    const logoPath = `/uploads/${slug}/${req.file.filename}`;
    db.prepare(`UPDATE settings SET logo_path = ?, updated_at = CURRENT_TIMESTAMP`).run(logoPath);
    auditLog(req.session.user.id, req.session.user.name, 'logo_uploaded', { logo_path: logoPath });
    req.session.flash = { type: 'success', msg: 'Logo updated.' };
    res.redirect('/settings');
  });
});

// ─── POST /settings/logo/remove ──────────────────────────────
router.post('/logo/remove', (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const settings = db.prepare(`SELECT logo_path FROM settings LIMIT 1`).get();
  if (settings.logo_path) {
    const filePath = path.join(__dirname, '../public', settings.logo_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.prepare(`UPDATE settings SET logo_path = '', updated_at = CURRENT_TIMESTAMP`).run();
  auditLog(req.session.user.id, req.session.user.name, 'logo_removed', {});
  req.session.flash = { type: 'success', msg: 'Logo removed.' };
  res.redirect('/settings');
});

// ─── GET /settings/audit-log ─────────────────────────────────
router.get('/audit-log', (req, res) => {
  const db = req.db;
  const page    = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 30;
  const offset  = (page - 1) * perPage;
  const userFilter   = req.query.user_id  || '';
  const actionFilter = req.query.action   || '';

  let where = `WHERE 1=1`;
  const params = [];
  if (userFilter)   { where += ` AND al.user_id = ?`;    params.push(userFilter); }
  if (actionFilter) { where += ` AND al.action LIKE ?`;  params.push(`%${actionFilter}%`); }

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM audit_log al ${where}`).get(...params).cnt;
  const logs  = db.prepare(`
    SELECT al.*, u.name AS user_full_name
    FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
    ${where}
    ORDER BY al.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  const users   = db.prepare(`SELECT DISTINCT user_id, user_name FROM audit_log ORDER BY user_name`).all();
  const actions = db.prepare(`SELECT DISTINCT action FROM audit_log ORDER BY action`).all();

  res.render('settings/audit_log', {
    title: 'Audit Log', currentPath: '/settings',
    logs, total, page, perPage, users, actions, userFilter, actionFilter
  });
});

// ─── GET /settings/users ──────────────────────────────────────
router.get('/users', (req, res) => {
  const db = req.db;
  const users = db.prepare(`SELECT id, name, username, role, status, last_login, created_at FROM users ORDER BY name ASC`).all();
  res.render('settings/users', {
    title: 'User Management', currentPath: '/settings',
    users, flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── GET /settings/users/new ──────────────────────────────────
router.get('/users/new', (req, res) => {
  res.render('settings/user_form', {
    title: 'New User', currentPath: '/settings',
    editUser: null, errors: []
  });
});

// ─── POST /settings/users ─────────────────────────────────────
router.post('/users', async (req, res) => {
  const { name, username, password, role, status } = req.body;
  const errors = [];
  if (!name || !name.trim()) errors.push('Name is required.');
  if (!username || !username.trim()) errors.push('Username is required.');
  if (!password || password.length < 6) errors.push('Password must be at least 6 characters.');
  if (!['admin', 'cashier', 'reporter'].includes(role)) errors.push('Invalid role.');

  const db = req.db;
  const auditLog = makeAuditLog(db);

  if (errors.length) {
    return res.render('settings/user_form', {
      title: 'New User', currentPath: '/settings', editUser: req.body, errors
    });
  }

  const existing = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username.trim());
  if (existing) {
    return res.render('settings/user_form', {
      title: 'New User', currentPath: '/settings', editUser: req.body,
      errors: ['Username already exists.']
    });
  }

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(`
    INSERT INTO users (name, username, password_hash, role, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), username.trim().toLowerCase(), hash, role, status || 'active');

  auditLog(req.session.user.id, req.session.user.name, 'user_created', { new_user_id: result.lastInsertRowid, username });

  req.session.flash = { type: 'success', msg: `User "${name}" created.` };
  res.redirect('/settings/users');
});

// ─── GET /settings/users/:id/edit ────────────────────────────
router.get('/users/:id/edit', (req, res) => {
  const db = req.db;
  const editUser = db.prepare(`SELECT id, name, username, role, status FROM users WHERE id = ?`).get(req.params.id);
  if (!editUser) return res.status(404).render('404', { title: 'Not Found' });

  res.render('settings/user_form', {
    title: 'Edit User', currentPath: '/settings', editUser, errors: []
  });
});

// ─── POST /settings/users/:id/edit ───────────────────────────
router.post('/users/:id/edit', async (req, res) => {
  const { name, username, password, role, status } = req.body;
  const errors = [];
  if (!name || !name.trim()) errors.push('Name is required.');
  if (!username || !username.trim()) errors.push('Username is required.');
  if (password && password.length > 0 && password.length < 6) errors.push('Password must be at least 6 characters.');
  if (!['admin', 'cashier', 'reporter'].includes(role)) errors.push('Invalid role.');

  const db = req.db;
  const auditLog = makeAuditLog(db);
  const editUser = db.prepare(`SELECT id, name, username, role, status FROM users WHERE id = ?`).get(req.params.id);
  if (!editUser) return res.status(404).render('404', { title: 'Not Found' });

  // Prevent locking out current admin
  if (String(req.params.id) === String(req.session.user.id) && status === 'inactive') {
    errors.push('You cannot deactivate your own account.');
  }

  if (errors.length) {
    return res.render('settings/user_form', {
      title: 'Edit User', currentPath: '/settings',
      editUser: { ...editUser, ...req.body }, errors
    });
  }

  if (password && password.length >= 6) {
    const hash = await bcrypt.hash(password, 12);
    db.prepare(`UPDATE users SET name = ?, username = ?, password_hash = ?, role = ?, status = ? WHERE id = ?`)
      .run(name.trim(), username.trim().toLowerCase(), hash, role, status, req.params.id);
  } else {
    db.prepare(`UPDATE users SET name = ?, username = ?, role = ?, status = ? WHERE id = ?`)
      .run(name.trim(), username.trim().toLowerCase(), role, status, req.params.id);
  }

  auditLog(req.session.user.id, req.session.user.name, 'user_updated', { user_id: req.params.id, username });

  req.session.flash = { type: 'success', msg: `User "${name}" updated.` };
  res.redirect('/settings/users');
});

// ─── PAYMENT METHODS ──────────────────────────────────────────

// Count of payments already recorded against a method code
function methodUsage(db, code) {
  return db.prepare(`SELECT COUNT(*) AS cnt FROM payments WHERE payment_method = ?`).get(code).cnt;
}

// Shared create/update validation. `existing` is the row being edited, if any.
function validateMethod(db, body, existing) {
  const errors = [];
  const labelEn = (body.label_en || '').trim();
  const labelAr = (body.label_ar || '').trim();
  const code    = (body.code || '').trim().toLowerCase();
  const color   = (body.badge_color || 'gray').trim();
  const sortRaw = parseInt(body.sort_order);

  if (!labelEn) errors.push('English label is required.');
  if (!code) {
    errors.push('Code is required.');
  } else if (!/^[a-z0-9_]+$/.test(code)) {
    errors.push('Code may only contain lowercase letters, numbers and underscores.');
  } else {
    const clash = db.prepare(`SELECT id FROM payment_methods WHERE code = ?`).get(code);
    if (clash && (!existing || clash.id !== existing.id)) errors.push(`Code "${code}" is already in use.`);
  }
  if (!BADGE_COLORS.includes(color)) errors.push('Invalid badge colour.');

  // The code is written into every payment row, so it is frozen once in use
  if (existing && code !== existing.code) {
    if (existing.is_builtin) {
      errors.push('The code of a built-in method cannot be changed.');
    } else if (methodUsage(db, existing.code) > 0) {
      errors.push('This method is already used by recorded payments — its code cannot be changed.');
    }
  }

  return {
    errors,
    values: {
      code, label_en: labelEn, label_ar: labelAr, badge_color: color,
      requires_bank_details: body.requires_bank_details ? 1 : 0,
      is_active: body.is_active ? 1 : 0,
      sort_order: isNaN(sortRaw) ? 0 : sortRaw
    }
  };
}

// ─── GET /settings/payment-methods ────────────────────────────
router.get('/payment-methods', (req, res) => {
  const db = req.db;
  const methods = getAllMethods(db);
  methods.forEach(m => { m.usage_count = methodUsage(db, m.code); });

  res.render('settings/payment_methods', {
    title: 'Payment Methods', currentPath: '/settings',
    methods, flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── GET /settings/payment-methods/new ────────────────────────
router.get('/payment-methods/new', (req, res) => {
  const maxSort = req.db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS mx FROM payment_methods`).get().mx;
  res.render('settings/payment_method_form', {
    title: 'New Payment Method', currentPath: '/settings',
    method: { is_active: 1, badge_color: 'gray', sort_order: maxSort + 1 },
    badgeColors: BADGE_COLORS, isNew: true, usageCount: 0, errors: []
  });
});

// ─── POST /settings/payment-methods ───────────────────────────
router.post('/payment-methods', (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const { errors, values } = validateMethod(db, req.body, null);

  if (errors.length) {
    return res.render('settings/payment_method_form', {
      title: 'New Payment Method', currentPath: '/settings',
      method: { ...values }, badgeColors: BADGE_COLORS, isNew: true, usageCount: 0, errors
    });
  }

  const result = db.prepare(`
    INSERT INTO payment_methods
      (code, label_en, label_ar, requires_bank_details, badge_color, is_active, sort_order, is_builtin)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(values.code, values.label_en, values.label_ar, values.requires_bank_details,
         values.badge_color, values.is_active, values.sort_order);

  auditLog(req.session.user.id, req.session.user.name, 'payment_method_created',
    { id: result.lastInsertRowid, code: values.code });

  req.session.flash = { type: 'success', msg: `Payment method "${values.label_en}" created.` };
  res.redirect('/settings/payment-methods');
});

// ─── GET /settings/payment-methods/:id/edit ───────────────────
router.get('/payment-methods/:id/edit', (req, res) => {
  const db = req.db;
  const method = db.prepare(`SELECT * FROM payment_methods WHERE id = ?`).get(req.params.id);
  if (!method) return res.status(404).render('404', { title: 'Not Found' });

  res.render('settings/payment_method_form', {
    title: 'Edit Payment Method', currentPath: '/settings',
    method, badgeColors: BADGE_COLORS, isNew: false,
    usageCount: methodUsage(db, method.code), errors: []
  });
});

// ─── POST /settings/payment-methods/:id/edit ──────────────────
router.post('/payment-methods/:id/edit', (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const method = db.prepare(`SELECT * FROM payment_methods WHERE id = ?`).get(req.params.id);
  if (!method) return res.status(404).render('404', { title: 'Not Found' });

  const { errors, values } = validateMethod(db, req.body, method);

  // Never leave the payment form with nothing to pick
  if (!values.is_active) {
    const otherActive = db.prepare(
      `SELECT COUNT(*) AS cnt FROM payment_methods WHERE is_active = 1 AND id != ?`
    ).get(method.id).cnt;
    if (otherActive === 0) errors.push('At least one payment method must stay active.');
  }

  if (errors.length) {
    return res.render('settings/payment_method_form', {
      title: 'Edit Payment Method', currentPath: '/settings',
      method: { ...method, ...values }, badgeColors: BADGE_COLORS, isNew: false,
      usageCount: methodUsage(db, method.code), errors
    });
  }

  db.prepare(`
    UPDATE payment_methods
    SET code = ?, label_en = ?, label_ar = ?, requires_bank_details = ?,
        badge_color = ?, is_active = ?, sort_order = ?
    WHERE id = ?
  `).run(values.code, values.label_en, values.label_ar, values.requires_bank_details,
         values.badge_color, values.is_active, values.sort_order, method.id);

  // Keep historical payments pointing at the row when a non-builtin code is renamed
  if (values.code !== method.code) {
    db.prepare(`UPDATE payments SET payment_method = ? WHERE payment_method = ?`)
      .run(values.code, method.code);
  }

  auditLog(req.session.user.id, req.session.user.name, 'payment_method_updated',
    { id: method.id, code: values.code });

  req.session.flash = { type: 'success', msg: `Payment method "${values.label_en}" updated.` };
  res.redirect('/settings/payment-methods');
});

// ─── POST /settings/payment-methods/:id/toggle ────────────────
router.post('/payment-methods/:id/toggle', (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const method = db.prepare(`SELECT * FROM payment_methods WHERE id = ?`).get(req.params.id);
  if (!method) return res.status(404).render('404', { title: 'Not Found' });

  if (method.is_active) {
    const otherActive = db.prepare(
      `SELECT COUNT(*) AS cnt FROM payment_methods WHERE is_active = 1 AND id != ?`
    ).get(method.id).cnt;
    if (otherActive === 0) {
      req.session.flash = { type: 'danger', msg: 'At least one payment method must stay active.' };
      return res.redirect('/settings/payment-methods');
    }
  }

  const next = method.is_active ? 0 : 1;
  db.prepare(`UPDATE payment_methods SET is_active = ? WHERE id = ?`).run(next, method.id);
  auditLog(req.session.user.id, req.session.user.name, 'payment_method_updated',
    { id: method.id, code: method.code, is_active: next });

  req.session.flash = {
    type: 'success',
    msg: `"${method.label_en}" ${next ? 'activated' : 'deactivated'}.`
  };
  res.redirect('/settings/payment-methods');
});

// ─── POST /settings/payment-methods/:id/delete ────────────────
router.post('/payment-methods/:id/delete', (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const method = db.prepare(`SELECT * FROM payment_methods WHERE id = ?`).get(req.params.id);
  if (!method) return res.status(404).render('404', { title: 'Not Found' });

  // Historical receipts must keep resolving their method — deactivate instead
  const used = methodUsage(db, method.code);
  if (used > 0) {
    req.session.flash = {
      type: 'danger',
      msg: `"${method.label_en}" is used by ${used} payment${used === 1 ? '' : 's'} and cannot be deleted. Deactivate it instead.`
    };
    return res.redirect('/settings/payment-methods');
  }

  const activeCount = db.prepare(`SELECT COUNT(*) AS cnt FROM payment_methods WHERE is_active = 1`).get().cnt;
  if (method.is_active && activeCount <= 1) {
    req.session.flash = { type: 'danger', msg: 'At least one payment method must stay active.' };
    return res.redirect('/settings/payment-methods');
  }

  db.prepare(`DELETE FROM payment_methods WHERE id = ?`).run(method.id);
  auditLog(req.session.user.id, req.session.user.name, 'payment_method_deleted',
    { id: method.id, code: method.code });

  req.session.flash = { type: 'success', msg: `Payment method "${method.label_en}" deleted.` };
  res.redirect('/settings/payment-methods');
});

module.exports = router;
