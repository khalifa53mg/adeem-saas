const express = require('express');
const router = express.Router();
const { getMasterDb } = require('../db/masterDb');

// GET /support — list my tickets
router.get('/', (req, res) => {
  const masterDb = getMasterDb();
  const tickets = masterDb.prepare(
    'SELECT * FROM support_tickets WHERE tenant_slug = ? ORDER BY updated_at DESC'
  ).all(req.session.tenantSlug);
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('support/index', {
    title: 'Support',
    currentPath: '/support',
    tickets,
    flash
  });
});

// GET /support/new — new ticket form
router.get('/new', (req, res) => {
  res.render('support/new', {
    title: 'New Support Ticket',
    currentPath: '/support',
    errors: null
  });
});

// POST /support — create ticket
router.post('/', (req, res) => {
  const { subject, message, priority } = req.body;
  const errors = [];
  if (!subject || !subject.trim()) errors.push('Subject is required.');
  if (!message || !message.trim()) errors.push('Message is required.');
  if (message && message.trim().length > 2000) errors.push('Message must be 2000 characters or less.');

  if (errors.length) {
    return res.render('support/new', {
      title: 'New Support Ticket',
      currentPath: '/support',
      errors,
      body: req.body
    });
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

  req.session.flash = { type: 'success', msg: 'Your support ticket has been submitted. We will get back to you soon.' };
  res.redirect('/support');
});

// GET /support/:id — view ticket thread
router.get('/:id', (req, res) => {
  const masterDb = getMasterDb();
  const ticket = masterDb.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.id);
  if (!ticket || ticket.tenant_slug !== req.session.tenantSlug) {
    return res.status(403).render('403', { title: 'Access Denied' });
  }
  const replies = masterDb.prepare(
    'SELECT * FROM support_ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC'
  ).all(ticket.id);
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('support/show', {
    title: `Ticket #${ticket.id}`,
    currentPath: '/support',
    ticket,
    replies,
    flash
  });
});

// POST /support/:id/reply — tenant adds reply
router.post('/:id/reply', (req, res) => {
  const masterDb = getMasterDb();
  const ticket = masterDb.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.id);
  if (!ticket || ticket.tenant_slug !== req.session.tenantSlug) {
    return res.status(403).render('403', { title: 'Access Denied' });
  }

  const { message } = req.body;
  if (!message || !message.trim()) {
    req.session.flash = { type: 'danger', msg: 'Reply cannot be empty.' };
    return res.redirect(`/support/${ticket.id}`);
  }

  masterDb.prepare(
    'INSERT INTO support_ticket_replies (ticket_id, author_name, author_role, message) VALUES (?, ?, ?, ?)'
  ).run(ticket.id, req.session.user.name, 'tenant', message.trim());

  masterDb.prepare(
    "UPDATE support_tickets SET updated_at = datetime('now'), status = CASE WHEN status = 'resolved' THEN 'in_progress' ELSE status END WHERE id = ?"
  ).run(ticket.id);

  req.session.flash = { type: 'success', msg: 'Reply sent.' };
  res.redirect(`/support/${ticket.id}`);
});

module.exports = router;
