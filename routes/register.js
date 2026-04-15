const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getMasterDb } = require('../db/masterDb');
const { getTenantDb, makeAuditLog } = require('../db/tenantDb');
const { initTenantDb } = require('../db/tenantInit');
const { sendWelcomeEmail } = require('../middleware/mailer');

const RESERVED_SLUGS = ['admin', 'superadmin', 'login', 'register', 'logout', 'api', 'public'];
const COUNTRY_CURRENCY = {
  'Saudi Arabia': { code: 'SAR', label: 'Saudi Riyal' },
  'Bahrain': { code: 'BHD', label: 'Bahraini Dinar' },
  'Qatar':   { code: 'QAR', label: 'Qatari Riyal' },
  'Oman':    { code: 'OMR', label: 'Omani Rial' },
  'Kuwait':  { code: 'KWD', label: 'Kuwaiti Dinar' },
};

router.get('/', (req, res) => {
  res.render('register', { title: 'Register', error: null, values: {} });
});

function deriveSlug(email) {
  return (email.split('@')[0] || 'company')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28) || 'company';
}

function deriveCompanyName(email) {
  const prefix = email.split('@')[0] || 'My Company';
  return prefix
    .replace(/[.\-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function uniqueSlug(masterDb, base) {
  if (!masterDb.prepare('SELECT id FROM tenants WHERE slug = ?').get(base) && !RESERVED_SLUGS.includes(base)) {
    return base;
  }
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base.slice(0, 26)}-${i}`;
    if (!masterDb.prepare('SELECT id FROM tenants WHERE slug = ?').get(candidate)) return candidate;
  }
  return `${base.slice(0, 20)}-${Date.now()}`.slice(0, 30);
}

router.post('/', (req, res) => {
  const { country, admin_name, mobile, admin_email, password, confirm_password } = req.body;

  // Generate slug and company name from email
  const slug         = uniqueSlug(getMasterDb(), deriveSlug(admin_email || ''));
  const company_name = (req.body.company_name && req.body.company_name.trim())
    ? req.body.company_name.trim()
    : deriveCompanyName(admin_email || '');

  // Validation
  if (!country || !admin_name || !mobile || !admin_email || !password || !confirm_password) {
    return res.render('register', { title: 'Register', error: 'جميع الحقول مطلوبة', values: req.body });
  }
  if (!COUNTRY_CURRENCY[country]) {
    return res.render('register', { title: 'Register', error: 'اختر دولة صحيحة', values: req.body });
  }
  if (password.length < 8) {
    return res.render('register', { title: 'Register', error: 'كلمة المرور يجب أن تكون ٨ أحرف على الأقل', values: req.body });
  }
  if (password !== confirm_password) {
    return res.render('register', { title: 'Register', error: 'كلمتا المرور غير متطابقتين', values: req.body });
  }

  const masterDb = getMasterDb();

  // Check email uniqueness
  const existingEmail = masterDb.prepare('SELECT id FROM tenants WHERE admin_email = ?').get(admin_email);
  if (existingEmail) {
    return res.render('register', { title: 'Register', error: 'هذا البريد الإلكتروني مسجّل مسبقًا', values: req.body });
  }

  try {
    const currency = COUNTRY_CURRENCY[country];

    // Create tenant directory
    const tenantDir = path.join(__dirname, '../db/tenants', slug);
    fs.mkdirSync(tenantDir, { recursive: true });

    // Initialize tenant DB
    const db = getTenantDb(slug);
    initTenantDb(db, {
      adminName: admin_name,
      adminEmail: admin_email,
      adminPassword: password,
      currencyLabel: currency.label,
      companyName: company_name,
    });

    // Insert into master DB
    const trialExpires = new Date();
    trialExpires.setDate(trialExpires.getDate() + 14);

    masterDb.prepare(`
      INSERT INTO tenants (company_name, slug, admin_email, admin_name, mobile, country, currency_code, currency_label, status, trial_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'trial', ?)
    `).run(company_name, slug, admin_email, admin_name, mobile, country, currency.code, currency.label, trialExpires.toISOString());

    // Get the newly created admin user's ID
    const newUser = db.prepare("SELECT id FROM users WHERE username = 'admin' LIMIT 1").get();

    // Auto-login: set session just like the login handler does
    req.session.tenantSlug = slug;
    req.session.tenantName = company_name;
    req.session.user = {
      id: newUser.id,
      name: admin_name,
      username: 'admin',
      role: 'admin'
    };

    // Log audit entry for the auto-login
    const auditLog = makeAuditLog(db);
    auditLog(newUser.id, admin_name, 'login', { username: 'admin', role: 'admin', note: 'auto-login after registration' });

    // Send welcome email with login details (non-blocking)
    sendWelcomeEmail({
      to: admin_email,
      companyName: company_name,
      adminName: admin_name,
      slug,
      password,
    }).catch(err => console.error('Welcome email failed:', err));

    req.session.lang = 'ar';
    req.session.save(() => {
      res.redirect('/properties');
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.render('register', { title: 'Register', error: 'Registration failed: ' + err.message, values: req.body });
  }
});

module.exports = router;
