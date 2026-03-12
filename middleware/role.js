// Role permission guard middleware factory
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('403', {
        title: 'Access Denied',
        message: 'You do not have permission to access this page.'
      });
    }
    next();
  };
}

// Admin only
const adminOnly = requireRole('admin');

// Admin + Cashier
const adminOrCashier = requireRole('admin', 'cashier');

module.exports = { requireRole, adminOnly, adminOrCashier };
