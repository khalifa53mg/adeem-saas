require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initMasterDb } = require('./db/masterDb');

const app = express();
const PORT = process.env.PORT || 3002;

// Init master DB
initMasterDb();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Body parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session
const SQLiteStore = require('connect-sqlite3')(session);
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: './db' }),
  name: 'adeem-saas.sid',
  secret: process.env.SESSION_SECRET || 'adeem-saas-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
}));

// Middleware
const { attachUser, requireActiveTenant } = require('./middleware/auth');
const { attachTenantDb } = require('./middleware/attachTenant');

app.use(attachUser);
app.use(attachTenantDb);

// ─── Routes (no tenant check) ─────────────────────────────────
const registerRouter = require('./routes/register');
const superadminRouter = require('./routes/superadmin');
const authRouter = require('./routes/auth');

// ─── Support ticket bypass (auth only, no active-tenant check) ───
// Allows suspended/trial-expired tenants to submit a support ticket
const { requireAuth } = require('./middleware/auth');
const { getMasterDb } = require('./db/masterDb');
app.post('/support-request', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, errors: ['Not authenticated. Please refresh the page and try again.'] });
  }
  console.log('[support-request] hit, body:', req.body, 'user:', req.session.user);
  try {
    const { subject, message, priority } = req.body;
    const errors = [];
    if (!subject || !subject.trim()) errors.push('Subject is required.');
    if (!message || !message.trim()) errors.push('Message is required.');
    if (message && message.trim().length > 2000) errors.push('Message must be 2000 characters or less.');
    if (errors.length) {
      return res.status(400).json({ ok: false, errors });
    }
    const masterDb = getMasterDb();
    const tenant = masterDb.prepare('SELECT id FROM tenants WHERE slug = ?').get(req.session.tenantSlug);
    masterDb.prepare(`
      INSERT INTO support_tickets (tenant_id, tenant_slug, company_name, submitted_by, subject, message, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenant ? tenant.id : null,
      req.session.tenantSlug,
      req.session.tenantName || req.session.tenantSlug,
      req.session.user.name,
      subject.trim(),
      message.trim(),
      ['low','normal','high','urgent'].includes(priority) ? priority : 'normal'
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error('[support-request] error:', e.message);
    return res.status(500).json({ ok: false, errors: [e.message] });
  }
});

app.use('/register', registerRouter);
app.use('/superadmin', superadminRouter);
app.use('/', authRouter);

// ─── Tenant feature routes (with auth + trial/active check) ───
const propertiesRouter = require('./routes/properties');
const unitsRouter = require('./routes/units');
const tenantsRouter = require('./routes/tenants');
const paymentsRouter = require('./routes/payments');
const reportsRouter = require('./routes/reports');
const settingsRouter = require('./routes/settings');
const archiveRouter = require('./routes/archive');
const supportRouter = require('./routes/support');

const tenantRouter = express.Router();
tenantRouter.use(requireAuth);
tenantRouter.use(requireActiveTenant);
tenantRouter.use('/properties', propertiesRouter);
tenantRouter.use('/units', unitsRouter);
tenantRouter.use('/tenants', tenantsRouter);
tenantRouter.use('/payments', paymentsRouter);
tenantRouter.use('/reports', reportsRouter);
tenantRouter.use('/settings', settingsRouter);
tenantRouter.use('/archive', archiveRouter);
tenantRouter.use('/support', supportRouter);

// Dashboard: role-based redirect
tenantRouter.get('/dashboard', (req, res) => {
  const role = req.session.user ? req.session.user.role : '';
  if (role === 'cashier') return res.redirect('/payments');
  if (role === 'reporter') return res.redirect('/reports');
  return res.redirect('/properties');
});

// ─── Root redirect ────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    const role = req.session.user.role;
    if (role === 'cashier') return res.redirect('/payments');
    if (role === 'reporter') return res.redirect('/reports');
    return res.redirect('/properties');
  }
  res.render('landing', { title: 'إدارة عقاراتك بذكاء' });
});

app.use('/', tenantRouter);

// ─── 404 page ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.status(404).render('404', { title: 'Page Not Found' });
});

// ─── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('500', { title: 'Server Error', error: err.message });
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Adeem SaaS running on port ${PORT}`);
});
