const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getMasterDb } = require('../db/masterDb');
const { getTenantDb } = require('../db/tenantDb');
const { makeAuditLog } = require('../db/tenantDb');

// GET /login
router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect(roleRedirect(req.session.user.role));
  }
  if (req.query.lang) {
    req.session.lang = req.query.lang;
    res.locals.lang = req.query.lang;
  }
  res.render('login', {
    title: 'Login',
    error: null,
    slug: req.query.slug || '',
    registered: req.query.registered === '1'
  });
});

// POST /login
router.post('/login', (req, res) => {
  const { slug, username, password } = req.body;

  if (!slug || !slug.trim()) {
    return res.render('login', { title: 'Login', error: 'Company ID is required.', slug: slug || '', registered: false });
  }

  const masterDb = getMasterDb();
  const tenant = masterDb.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug.trim().toLowerCase());

  if (!tenant) {
    return res.render('login', { title: 'Login', error: 'Company not found. Check your Company ID.', slug: slug || '', registered: false });
  }

  let db;
  try {
    db = getTenantDb(tenant.slug);
  } catch (e) {
    return res.render('login', { title: 'Login', error: 'Company database not available.', slug: slug || '', registered: false });
  }

  const user = db.prepare(`SELECT * FROM users WHERE username = ? AND status = 'active'`).get(username);

  if (!user) {
    return res.render('login', { title: 'Login', error: 'Invalid username or password.', slug: slug || '', registered: false });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.render('login', { title: 'Login', error: 'Invalid username or password.', slug: slug || '', registered: false });
  }

  // Update last login
  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

  // Store session
  req.session.tenantSlug = tenant.slug;
  req.session.tenantName = tenant.company_name;
  req.session.user = {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role
  };

  // Audit log
  const auditLog = makeAuditLog(db);
  auditLog(user.id, user.name, 'login', { username: user.username, role: user.role });

  res.redirect(roleRedirect(user.role));
});

// POST /logout
router.post('/logout', (req, res) => {
  const user = req.session.user;
  const slug = req.session.tenantSlug;
  if (user && slug) {
    try {
      const db = getTenantDb(slug);
      const auditLog = makeAuditLog(db);
      auditLog(user.id, user.name, 'logout', { username: user.username });
    } catch (e) { /* ignore */ }
  }
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// GET /logout (convenience)
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// POST /theme — toggle dark/light
router.post('/theme', (req, res) => {
  const current = req.session.theme || 'light';
  req.session.theme = current === 'dark' ? 'light' : 'dark';
  res.json({ theme: req.session.theme });
});

// POST /language — toggle en/ar
router.post('/language', (req, res) => {
  const current = req.session.lang || 'en';
  req.session.lang = current === 'en' ? 'ar' : 'en';
  res.redirect(req.headers.referer || '/');
});

function roleRedirect(role) {
  switch (role) {
    case 'cashier': return '/payments';
    case 'reporter': return '/reports';
    default: return '/properties';
  }
}

module.exports = router;
