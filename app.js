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

app.use('/register', registerRouter);
app.use('/superadmin', superadminRouter);
app.use('/', authRouter);

// ─── Tenant feature routes (with auth + trial/active check) ───
const { requireAuth } = require('./middleware/auth');
const propertiesRouter = require('./routes/properties');
const unitsRouter = require('./routes/units');
const tenantsRouter = require('./routes/tenants');
const paymentsRouter = require('./routes/payments');
const reportsRouter = require('./routes/reports');
const settingsRouter = require('./routes/settings');
const archiveRouter = require('./routes/archive');

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

// Dashboard: role-based redirect
tenantRouter.get('/dashboard', (req, res) => {
  const role = req.session.user ? req.session.user.role : '';
  if (role === 'cashier') return res.redirect('/payments');
  if (role === 'reporter') return res.redirect('/reports');
  return res.redirect('/properties');
});

app.use('/', tenantRouter);

// ─── Root redirect ────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    const role = req.session.user.role;
    if (role === 'cashier') return res.redirect('/payments');
    if (role === 'reporter') return res.redirect('/reports');
    return res.redirect('/properties');
  }
  res.redirect('/login');
});

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
