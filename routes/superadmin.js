const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { getMasterDb } = require('../db/masterDb');
const { getTenantDb, removeTenantDb } = require('../db/tenantDb');

function requireSuperAdmin(req, res, next) {
  if (!req.session.superAdmin) return res.redirect('/superadmin/login');
  next();
}

router.get('/login', (req, res) => {
  res.render('superadmin/login', { title: 'Super Admin Login', error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const masterDb = getMasterDb();
  const admin = masterDb.prepare('SELECT * FROM super_admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.render('superadmin/login', { title: 'Super Admin Login', error: 'Invalid credentials' });
  }
  req.session.superAdmin = { id: admin.id, username: admin.username };
  res.redirect('/superadmin/tenants');
});

router.post('/logout', (req, res) => {
  delete req.session.superAdmin;
  res.redirect('/superadmin/login');
});

function getTenantKpis(slug) {
  try {
    const db = getTenantDb(slug);
    const properties  = db.prepare('SELECT COUNT(*) AS c FROM properties  WHERE is_archived=0').get().c;
    const units       = db.prepare('SELECT COUNT(*) AS c FROM sub_properties WHERE is_archived=0').get().c;
    const payments    = db.prepare('SELECT COUNT(*) AS c FROM payments').get().c;
    const lastPayment = db.prepare('SELECT MAX(payment_date) AS d FROM payments').get().d;
    const lastLogin   = db.prepare("SELECT MAX(last_login) AS d FROM users WHERE last_login IS NOT NULL").get().d;
    return { properties, units, payments, lastPayment, lastLogin };
  } catch (_) {
    return { properties: '—', units: '—', payments: '—', lastPayment: null, lastLogin: null };
  }
}

router.get('/tenants', requireSuperAdmin, (req, res) => {
  const masterDb = getMasterDb();
  const tenants = masterDb.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
  const kpis = {};
  tenants.forEach(t => { kpis[t.id] = getTenantKpis(t.slug); });
  res.render('superadmin/dashboard', { title: 'Tenant Dashboard', tenants, kpis, superAdmin: req.session.superAdmin });
});

router.get('/tenants/:id', requireSuperAdmin, (req, res) => {
  const masterDb = getMasterDb();
  const tenant = masterDb.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).send('Tenant not found');
  const kpis = getTenantKpis(tenant.slug);
  res.render('superadmin/tenant_detail', { title: tenant.company_name, tenant, kpis, superAdmin: req.session.superAdmin });
});

router.post('/tenants/:id/activate', requireSuperAdmin, (req, res) => {
  getMasterDb().prepare("UPDATE tenants SET status='active', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  res.redirect('/superadmin/tenants/' + req.params.id);
});

router.post('/tenants/:id/suspend', requireSuperAdmin, (req, res) => {
  getMasterDb().prepare("UPDATE tenants SET status='suspended', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  res.redirect('/superadmin/tenants/' + req.params.id);
});

router.post('/tenants/:id/extend-trial', requireSuperAdmin, (req, res) => {
  const days = parseInt(req.body.days) || 14;
  getMasterDb().prepare(`
    UPDATE tenants
    SET trial_expires_at = datetime(COALESCE(trial_expires_at, 'now'), '+${days} days'),
        status = CASE WHEN status = 'suspended' THEN 'suspended' ELSE 'trial' END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.params.id);
  res.redirect('/superadmin/tenants/' + req.params.id);
});

// Reset tenant admin password
router.post('/tenants/:id/reset-password', requireSuperAdmin, (req, res) => {
  const masterDb = getMasterDb();
  const tenant = masterDb.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).send('Tenant not found');

  const { new_password, confirm_password } = req.body;
  if (!new_password || new_password.length < 8) {
    return res.render('superadmin/tenant_detail', {
      tenant,
      superAdmin: req.session.superAdmin,
      flash: { type: 'danger', msg: 'Password must be at least 8 characters.' }
    });
  }
  if (new_password !== confirm_password) {
    return res.render('superadmin/tenant_detail', {
      tenant,
      superAdmin: req.session.superAdmin,
      flash: { type: 'danger', msg: 'Passwords do not match.' }
    });
  }

  try {
    const db = getTenantDb(tenant.slug);
    const hash = bcrypt.hashSync(new_password, 10);
    db.prepare("UPDATE users SET password_hash = ? WHERE username = 'admin'").run(hash);
    res.render('superadmin/tenant_detail', {
      tenant,
      superAdmin: req.session.superAdmin,
      flash: { type: 'success', msg: 'Admin password has been reset successfully.' }
    });
  } catch (err) {
    res.render('superadmin/tenant_detail', {
      tenant,
      superAdmin: req.session.superAdmin,
      flash: { type: 'danger', msg: 'Failed to reset password: ' + err.message }
    });
  }
});

// Edit tenant — show form
router.get('/tenants/:id/edit', requireSuperAdmin, (req, res) => {
  const tenant = getMasterDb().prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).send('Tenant not found');
  res.render('superadmin/tenant_edit', {
    tenant,
    superAdmin: req.session.superAdmin,
    error: null,
    values: {}
  });
});

// Edit tenant — save
router.post('/tenants/:id/update', requireSuperAdmin, (req, res) => {
  const masterDb = getMasterDb();
  const tenant = masterDb.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).send('Tenant not found');

  const { company_name, admin_email, mobile, currency } = req.body;

  const renderError = (msg) => res.render('superadmin/tenant_edit', {
    tenant,
    superAdmin: req.session.superAdmin,
    error: msg,
    values: req.body
  });

  if (!company_name || !admin_email || !mobile || !currency) {
    return renderError('All fields are required.');
  }

  // Parse currency field "CODE|Label"
  const currencyParts = currency.split('|');
  if (currencyParts.length !== 2) return renderError('Invalid currency selection.');
  const [currency_code, currency_label] = currencyParts;

  const validCurrencies = ['BHD', 'QAR', 'OMR', 'KWD'];
  if (!validCurrencies.includes(currency_code)) return renderError('Invalid currency code.');

  // Check email uniqueness (allow same email for same tenant)
  const emailConflict = masterDb.prepare(
    'SELECT id FROM tenants WHERE admin_email = ? AND id != ?'
  ).get(admin_email, req.params.id);
  if (emailConflict) return renderError('That email is already used by another tenant.');

  try {
    // Update master DB
    masterDb.prepare(`
      UPDATE tenants
      SET company_name = ?, admin_email = ?, mobile = ?,
          currency_code = ?, currency_label = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(company_name, admin_email, mobile, currency_code, currency_label, req.params.id);

    // Update tenant's own settings table so receipts/reports show correct currency
    try {
      const db = getTenantDb(tenant.slug);
      db.prepare("UPDATE settings SET currency_label = ? WHERE id = 1").run(currency_label);
    } catch (_) { /* tenant DB might not exist yet — ignore */ }

    res.redirect('/superadmin/tenants/' + req.params.id);
  } catch (err) {
    renderError('Save failed: ' + err.message);
  }
});

router.post('/tenants/:id/delete', requireSuperAdmin, (req, res) => {
  const masterDb = getMasterDb();
  const tenant = masterDb.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.redirect('/superadmin/tenants');

  // Remove from master DB
  masterDb.prepare('DELETE FROM tenants WHERE id = ?').run(req.params.id);

  // Close DB connection and remove from cache
  removeTenantDb(tenant.slug);

  // Delete tenant directory from disk
  const tenantDir = path.join(__dirname, '../db/tenants', tenant.slug);
  fs.rmSync(tenantDir, { recursive: true, force: true });

  res.redirect('/superadmin/tenants');
});

module.exports = router;
