const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');
const { makeAuditLog } = require('../db/tenantDb');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const { getCurrencyDecimals } = require('../utils/currency');
const { getMethodMap, methodLabel } = require('../utils/paymentMethods');
const { describePayment } = require('../utils/period');
const { esc } = require('../utils/html');

router.use(requireAuth);
router.use(requireRole('admin'));

// ─── GET /tenants ─────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = req.db;
  const search = req.query.search || '';
  const statusFilter = req.query.status || '';

  let query = `
    SELECT t.*,
      COUNT(DISTINCT CASE WHEN tu.is_current = 1 THEN tu.id END) AS active_units
    FROM tenants t
    LEFT JOIN tenant_units tu ON tu.tenant_id = t.id
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    query += ` AND (t.full_name LIKE ? OR t.tel LIKE ? OR t.address LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (statusFilter) {
    query += ` AND t.status = ?`;
    params.push(statusFilter);
  }

  query += ` GROUP BY t.id ORDER BY t.full_name ASC`;

  const tenants = db.prepare(query).all(...params);

  res.render('tenants/index', {
    title: 'Tenants', currentPath: '/tenants',
    tenants, search, statusFilter,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── GET /tenants/new ─────────────────────────────────────────
router.get('/new', (req, res) => {
  res.render('tenants/form', {
    title: 'New Tenant', currentPath: '/tenants',
    tenant: null, errors: []
  });
});

// ─── POST /tenants ────────────────────────────────────────────
router.post('/', (req, res) => {
  const { full_name, tel, fax, po_box, address, status } = req.body;
  const errors = [];
  if (!full_name || !full_name.trim()) errors.push('Full name is required.');

  if (errors.length) {
    return res.render('tenants/form', {
      title: 'New Tenant', currentPath: '/tenants', tenant: req.body, errors
    });
  }

  const db = req.db;
  const auditLog = makeAuditLog(db);
  const result = db.prepare(`
    INSERT INTO tenants (full_name, tel, fax, po_box, address, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(full_name.trim(), (tel || '').trim(), (fax || '').trim(), (po_box || '').trim(), (address || '').trim(), status || 'active');

  auditLog(req.session.user.id, req.session.user.name, 'tenant_created', { tenant_id: result.lastInsertRowid, full_name });

  req.session.flash = { type: 'success', msg: `Tenant "${full_name}" created.` };
  res.redirect('/tenants/' + result.lastInsertRowid);
});

// ─── GET /tenants/:id ─────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db = req.db;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(req.params.id);
  if (!tenant) return res.status(404).render('404', { title: 'Not Found' });

  const leases = db.prepare(`
    SELECT tu.*, sp.name AS unit_name, sp.unit_number, sp.monthly_rent_bhd,
      p.name AS property_name, p.id AS property_id, sp.id AS unit_id
    FROM tenant_units tu
    JOIN sub_properties sp ON sp.id = tu.sub_property_id
    JOIN properties p ON p.id = sp.property_id
    WHERE tu.tenant_id = ?
    ORDER BY tu.is_current DESC, tu.lease_start DESC
  `).all(req.params.id);

  const payments = db.prepare(`
    SELECT p.*, sp.name AS unit_name, sp.unit_number, prop.name AS property_name
    FROM payments p
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    WHERE p.tenant_id = ?
    ORDER BY p.payment_date DESC
    LIMIT 15
  `).all(req.params.id);

  const tSettings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  res.render('tenants/show', {
    title: tenant.full_name, currentPath: '/tenants',
    tenant, leases, payments,
    currencyLabel: (tSettings && tSettings.currency_label) || 'BD',
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── GET /tenants/:id/edit ────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const db = req.db;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(req.params.id);
  if (!tenant) return res.status(404).render('404', { title: 'Not Found' });

  res.render('tenants/form', {
    title: 'Edit Tenant', currentPath: '/tenants', tenant, errors: []
  });
});

// ─── POST /tenants/:id/edit ───────────────────────────────────
router.post('/:id/edit', (req, res) => {
  const { full_name, tel, fax, po_box, address, status } = req.body;
  const errors = [];
  if (!full_name || !full_name.trim()) errors.push('Full name is required.');

  const db = req.db;
  const auditLog = makeAuditLog(db);
  const tenant = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(req.params.id);
  if (!tenant) return res.status(404).render('404', { title: 'Not Found' });

  if (errors.length) {
    return res.render('tenants/form', {
      title: 'Edit Tenant', currentPath: '/tenants',
      tenant: { ...tenant, ...req.body }, errors
    });
  }

  db.prepare(`
    UPDATE tenants SET full_name = ?, tel = ?, fax = ?, po_box = ?, address = ?, status = ? WHERE id = ?
  `).run(full_name.trim(), (tel || '').trim(), (fax || '').trim(), (po_box || '').trim(), (address || '').trim(), status, req.params.id);

  auditLog(req.session.user.id, req.session.user.name, 'tenant_updated', { tenant_id: req.params.id, full_name });

  req.session.flash = { type: 'success', msg: `Tenant "${full_name}" updated.` };
  res.redirect('/tenants/' + req.params.id);
});

// ─── GET /tenants/:id/statement ───────────────────────────────
// Statement of Accounts PDF. adeem-saas has no invoices, so this is purely a record of
// payments received — no charges, no running balance.
router.get('/:id/statement', async (req, res) => {
  const db = req.db;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(req.params.id);
  if (!tenant) return res.status(404).render('404', { title: 'Not Found' });

  // Both dates are optional and independent — the form submits empty strings when left
  // blank, so anything that isn't a plain YYYY-MM-DD is ignored rather than rejected.
  const asDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : '';
  let from = asDate(req.query.from);
  let to   = asDate(req.query.to);
  if (from && to && from > to) [from, to] = [to, from];

  const where = ['p.tenant_id = ?'];
  const args  = [req.params.id];
  if (from) { where.push('p.payment_date >= ?'); args.push(from); }
  if (to)   { where.push('p.payment_date <= ?'); args.push(to); }

  // Oldest first — a statement reads chronologically, unlike the Recent Payments list.
  const payments = db.prepare(`
    SELECT p.*, sp.name AS unit_name, sp.unit_number,
      prop.name AS property_name, prop.location AS property_location,
      prop.address AS property_address
    FROM payments p
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.payment_date ASC, p.receipt_number ASC
  `).all(...args);

  // Allocation months for every payment in one pass. Joined through payments rather than
  // an IN (...) list, which would hit SQLite's variable limit on a large account.
  const monthsByPayment = new Map();
  for (const r of db.prepare(`
    SELECT a.payment_id, a.month FROM payment_allocations a
    JOIN payments p ON p.id = a.payment_id
    WHERE p.tenant_id = ?
    ORDER BY a.month ASC
  `).all(req.params.id)) {
    if (!monthsByPayment.has(r.payment_id)) monthsByPayment.set(r.payment_id, []);
    monthsByPayment.get(r.payment_id).push(r.month);
  }

  const settings  = db.prepare(`SELECT * FROM settings LIMIT 1`).get() || {};
  const methodMap = getMethodMap(db);
  const dec = getCurrencyDecimals(req.tenant && req.tenant.currency_code);
  // Short currency code, not settings.currency_label — 'Bahraini Dinar' is far too wide
  // for a table cell, and the sample statement uses 'BHD 0.000'.
  const cur   = (req.tenant && req.tenant.currency_code) || 'BD';
  const money = n => `${cur} ${Number(n || 0).toFixed(dec)}`;

  // 'YYYY-MM-DD' -> '22/07/26', the format the sample statement uses throughout.
  const fmtDate = ymd => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
    return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(ymd || '');
  };
  const today = new Date().toISOString().slice(0, 10);

  const periodLine = (from || to)
    ? `${from ? fmtDate(from) : 'Start'} To ${to ? fmtDate(to) : fmtDate(today)}`
    : `All transactions up to ${fmtDate(today)}`;

  const totalReceived = payments.reduce((s, p) => s + p.total_amount, 0);

  const logoHtml = settings.logo_path
    ? `<img class="logo" src="http://localhost:${process.env.PORT || 3002}${settings.logo_path}">`
    : '';

  // settings.fax holds the email — the column kept its old name when fax was dropped.
  const contactLine = [
    settings.tel ? `Tel: ${esc(settings.tel)}` : '',
    settings.fax ? `Email: ${esc(settings.fax)}` : ''
  ].filter(Boolean).join(' | ');

  const ownerName = settings.owner_name || 'My Company';

  const rows = payments.map(p => {
    const details = describePayment(p, monthsByPayment.get(p.id) || [], false,
      { fallbackAddress: settings.default_property_address });
    const meta = [
      methodLabel(methodMap[p.payment_method], false, p.payment_method),
      p.cheque_number ? `Cheque #${p.cheque_number}` : '',
      p.bank_name || '',
      p.notes || ''
    ].filter(Boolean).join(' · ');
    return `<tr>
      <td class="nowrap">${esc(fmtDate(p.payment_date))}</td>
      <td class="nowrap">Receipt #${esc(p.receipt_number)}</td>
      <td>${esc(details) || '&nbsp;'}${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</td>
      <td class="amt">${esc(money(p.total_amount))}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #222; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 30px; }
  .logo { max-height: 92px; max-width: 230px; object-fit: contain; }
  .company { text-align: right; line-height: 1.55; }
  .company .name { font-weight: 700; font-size: 12.5px; }
  .mid { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
  .to-label { font-weight: 700; }
  .to-name { font-weight: 700; margin-top: 3px; }
  .to-detail { color: #555; margin-top: 2px; }
  .title-box { text-align: right; min-width: 290px; }
  .title { font-size: 19px; font-weight: 700; border-bottom: 1px solid #9a9a9a; padding-bottom: 7px; }
  .period { font-size: 10.5px; color: #444; padding: 6px 0; border-bottom: 1px solid #9a9a9a; }
  table.summary { width: 290px; margin-left: auto; margin-bottom: 28px; border-collapse: collapse; }
  table.summary th { background: #d9d9d9; text-align: left; padding: 6px 10px; font-size: 11px; }
  table.summary td { padding: 6px 10px; border-bottom: 1px solid #e6e6e6; }
  table.summary td.v { text-align: right; white-space: nowrap; }
  table.summary tr.total td { font-weight: 700; border-bottom: none; }
  table.tx { width: 100%; border-collapse: collapse; }
  table.tx thead th { background: #3a3a3a; color: #fff; text-align: left; padding: 6px 8px; font-size: 11px; }
  table.tx thead th.amt { text-align: right; }
  table.tx td { padding: 7px 8px; border-bottom: 1px solid #e8e8e8; vertical-align: top; }
  td.amt { text-align: right; white-space: nowrap; }
  td.nowrap { white-space: nowrap; }
  .meta { color: #777; font-size: 9.5px; margin-top: 2px; }
  .empty { text-align: center; color: #666; padding: 28px 0; }
  .grand { margin-top: 16px; padding-top: 10px; border-top: 2px solid #3a3a3a; text-align: right; font-weight: 700; font-size: 12.5px; }
  .grand .lbl { margin-right: 26px; }
  /* Repeat the column headers on every page and never split a row across a break. */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
</style>
</head>
<body>
  <div class="head">
    <div>${logoHtml}</div>
    <div class="company">
      <div class="name">${esc(ownerName)}</div>
      ${settings.address ? `<div>${esc(settings.address)}</div>` : ''}
      ${contactLine ? `<div>${contactLine}</div>` : ''}
      ${settings.po_box ? `<div>P.O. Box: ${esc(settings.po_box)}</div>` : ''}
    </div>
  </div>

  <div class="mid">
    <div>
      <div class="to-label">To</div>
      <div class="to-name">${esc(tenant.full_name)}</div>
      ${tenant.address ? `<div class="to-detail">${esc(tenant.address)}</div>` : ''}
      ${tenant.tel ? `<div class="to-detail">Tel: ${esc(tenant.tel)}</div>` : ''}
    </div>
    <div class="title-box">
      <div class="title">Statement of Accounts</div>
      <div class="period">${esc(periodLine)}</div>
    </div>
  </div>

  <table class="summary">
    <tr><th colspan="2">Account Summary</th></tr>
    <tr><td>Number of Payments</td><td class="v">${payments.length}</td></tr>
    <tr class="total"><td>Total Received</td><td class="v">${esc(money(totalReceived))}</td></tr>
  </table>

  <table class="tx">
    <thead>
      <tr>
        <th style="width:70px;">Date</th>
        <th style="width:95px;">Transaction</th>
        <th>Details</th>
        <th class="amt" style="width:110px;">Payments</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="4" class="empty">There are no transactions</td></tr>`}
    </tbody>
  </table>

  <div class="grand"><span class="lbl">Total Received</span>${esc(money(totalReceived))}</div>
</body>
</html>`;

  const nameSlug = String(tenant.full_name || 'tenant').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tenant';

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      // Unlike the receipt, this needs real margins — the page-number footer only shows
      // when there is bottom margin for it to sit in.
      margin: { top: '12mm', right: '12mm', bottom: '14mm', left: '12mm' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="font-size:8px;color:#888;width:100%;padding:0 12mm;display:flex;justify-content:space-between;">
        <span>${esc(ownerName)}</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>`
    });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="statement-${nameSlug}-${today}.pdf"`);
    res.end(pdf);
  } catch (err) {
    console.error('Statement PDF error:', err);
    res.status(500).render('500', { title: 'PDF Error', error: err.message });
  }
});

module.exports = router;
