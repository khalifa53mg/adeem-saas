// Ensure user is logged in
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  next();
}

// Attach user to res.locals for all views
function attachUser(req, res, next) {
  res.locals.user = req.session.user || null;
  res.locals.theme = req.session.theme || 'light';
  res.locals.lang = req.session.lang || 'ar';
  res.locals.tenantName = req.session.tenantName || '';
  next();
}

// Check tenant is active/trial (not suspended or trial-expired)
function requireActiveTenant(req, res, next) {
  const tenant = req.tenant;
  if (!tenant) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  const now = new Date();
  if (tenant.status === 'suspended') {
    return res.render('trial_expired', { title: 'Account Suspended', reason: 'suspended', trialExpiredAt: null });
  }
  if (tenant.status === 'trial' && new Date(tenant.trial_expires_at) < now) {
    return res.render('trial_expired', { title: 'Trial Expired', reason: 'trial_expired', trialExpiredAt: tenant.trial_expires_at });
  }
  if (tenant.status === 'trial') {
    res.locals.trialDaysLeft = Math.ceil((new Date(tenant.trial_expires_at) - now) / 86400000);
  }
  next();
}

module.exports = { requireAuth, attachUser, requireActiveTenant };
