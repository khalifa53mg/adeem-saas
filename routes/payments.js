const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');
const path = require('path');
const { makeAuditLog } = require('../db/tenantDb');
const { requireAuth } = require('../middleware/auth');
const { adminOrCashier, requireRole } = require('../middleware/role');
const { getCurrencyDecimals } = require('../utils/currency');

router.use(requireAuth);
router.use(requireRole('admin', 'cashier'));

// ─── GET /payments — list ────────────────────────────────────
router.get('/', (req, res) => {
  const db = req.db;
  const search       = req.query.search     || '';
  const methodFilter = req.query.method     || '';
  const dateFrom     = req.query.date_from  || '';
  const dateTo       = req.query.date_to    || '';
  const propertyFilter = req.query.property_id || '';
  const tenantFilter   = req.query.tenant_id   || '';
  const unitFilter     = req.query.unit_id     || '';
  const page         = Math.max(1, parseInt(req.query.page) || 1);
  const perPage      = 25;
  const offset       = (page - 1) * perPage;

  let where = `WHERE 1=1`;
  const params = [];

  if (search) {
    where += ` AND (t.full_name LIKE ? OR p.receipt_number LIKE ? OR p.cheque_number LIKE ? OR sp.name LIKE ? OR prop.name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (methodFilter) {
    where += ` AND p.payment_method = ?`;
    params.push(methodFilter);
  }
  if (dateFrom) {
    where += ` AND p.payment_date >= ?`;
    params.push(dateFrom);
  }
  if (dateTo) {
    where += ` AND p.payment_date <= ?`;
    params.push(dateTo);
  }
  if (propertyFilter) {
    where += ` AND prop.id = ?`;
    params.push(propertyFilter);
  }
  if (tenantFilter) {
    where += ` AND t.id = ?`;
    params.push(tenantFilter);
  }
  if (unitFilter) {
    where += ` AND sp.id = ?`;
    params.push(unitFilter);
  }

  // Dropdown data for filters
  const filterProperties = db.prepare(`
    SELECT DISTINCT prop.id, prop.name
    FROM payments p
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    ORDER BY prop.name
  `).all();

  const filterTenants = db.prepare(`
    SELECT DISTINCT t.id, t.full_name
    FROM payments p
    JOIN tenants t ON t.id = p.tenant_id
    ORDER BY t.full_name
  `).all();

  const filterUnits = db.prepare(`
    SELECT DISTINCT sp.id, sp.name AS unit_name, sp.unit_number, prop.name AS property_name
    FROM payments p
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    ORDER BY prop.name, sp.unit_number, sp.name
  `).all();

  const baseQuery = `
    FROM payments p
    JOIN tenants t ON t.id = p.tenant_id
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    LEFT JOIN users u ON u.id = p.created_by
    ${where}
  `;

  const total = db.prepare(`SELECT COUNT(*) AS cnt ${baseQuery}`).get(...params).cnt;

  const payments = db.prepare(`
    SELECT p.*, t.full_name AS tenant_name,
      sp.name AS unit_name, sp.unit_number,
      prop.name AS property_name,
      u.name AS created_by_name
    ${baseQuery}
    ORDER BY p.payment_date DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  // Attach allocation summary (total allocated + month labels) to each payment
  if (payments.length > 0) {
    const ids = payments.map(p => p.id);
    const placeholders = ids.map(() => '?').join(',');
    const allocs = db.prepare(`
      SELECT payment_id, month, amount_allocated
      FROM payment_allocations
      WHERE payment_id IN (${placeholders})
      ORDER BY month ASC
    `).all(...ids);

    const allocMap = {};
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    allocs.forEach(a => {
      if (!allocMap[a.payment_id]) allocMap[a.payment_id] = { total: 0, months: [] };
      allocMap[a.payment_id].total += a.amount_allocated;
      const [y, mo] = a.month.split('-');
      allocMap[a.payment_id].months.push(monthNames[parseInt(mo) - 1] + '-' + y.slice(2));
    });

    payments.forEach(p => {
      const a = allocMap[p.id] || { total: 0, months: [] };
      p.total_allocated = a.total;
      p.unallocated     = p.total_amount - a.total;
      p.months_label    = a.months.join(' / ');
    });
  }

  const settings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  res.render('payments/index', {
    title: 'Payments', currentPath: '/payments',
    payments, search, methodFilter, dateFrom, dateTo,
    propertyFilter, tenantFilter, unitFilter,
    filterProperties, filterTenants, filterUnits,
    page, perPage, total,
    currencyLabel: (settings && settings.currency_label) || 'BD',
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── GET /payments/new ────────────────────────────────────────
router.get('/new', (req, res) => {
  const db = req.db;
  const unitId = req.query.unit_id || '';
  const settings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();

  // Active units with tenant
  const units = db.prepare(`
    SELECT sp.id, sp.name, sp.unit_number, sp.monthly_rent_bhd,
      p.id AS property_id, p.name AS property_name,
      t.full_name AS tenant_name, t.id AS tenant_id,
      tu.lease_start, tu.lease_end
    FROM sub_properties sp
    JOIN properties p ON p.id = sp.property_id
    JOIN tenant_units tu ON tu.sub_property_id = sp.id AND tu.is_current = 1
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE sp.is_archived = 0 AND sp.status = 'rented'
    ORDER BY p.name, sp.unit_number, sp.name
  `).all();

  // Properties that have at least one rented unit (for building dropdown)
  const properties = [];
  const seenPropIds = new Set();
  for (const u of units) {
    if (!seenPropIds.has(u.property_id)) {
      properties.push({ id: u.property_id, name: u.property_name });
      seenPropIds.add(u.property_id);
    }
  }

  // Units grouped by property_id for JS cascade
  const unitsGrouped = {};
  for (const u of units) {
    if (!unitsGrouped[u.property_id]) unitsGrouped[u.property_id] = [];
    unitsGrouped[u.property_id].push(u);
  }

  let selectedUnit = null;
  let selectedBuildingId = '';
  let monthlyRent = 0;

  if (unitId) {
    selectedUnit = units.find(u => String(u.id) === String(unitId));
    if (selectedUnit) {
      selectedBuildingId = String(selectedUnit.property_id);
      monthlyRent = selectedUnit.monthly_rent_bhd;
    }
  }

  // Build month list: from lease_start (or earliest across all units) to +6 months ahead (capped at lease_end)
  const now = new Date();
  let endDate = new Date(now.getFullYear(), now.getMonth() + 6, 1);
  let startDate;
  if (selectedUnit && selectedUnit.lease_start) {
    const [sy, sm] = selectedUnit.lease_start.slice(0, 7).split('-');
    startDate = new Date(parseInt(sy), parseInt(sm) - 1, 1);
    if (selectedUnit.lease_end) {
      const [ey, em] = selectedUnit.lease_end.slice(0, 7).split('-');
      const leaseEndDate = new Date(parseInt(ey), parseInt(em) - 1, 1);
      if (leaseEndDate < endDate) endDate = leaseEndDate;
    }
  } else {
    const cap = new Date(now.getFullYear(), now.getMonth() - 23, 1);
    const earliestRaw = units.reduce((min, u) => {
      if (!u.lease_start) return min;
      return u.lease_start.slice(0, 7) < min ? u.lease_start.slice(0, 7) : min;
    }, '9999-99');
    const earliest = earliestRaw === '9999-99' ? now.toISOString().slice(0, 7) : earliestRaw;
    const [sy, sm] = earliest.split('-');
    startDate = new Date(parseInt(sy), parseInt(sm) - 1, 1);
    if (startDate < cap) startDate = cap;
  }
  const months = [];
  const cur = new Date(startDate);
  while (cur <= endDate) {
    months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  months.sort((a, b) => b.localeCompare(a));

  // Existing allocations for all units (aggregated per unit+month for partial top-up support)
  const existingAllocs = db.prepare(`
    SELECT pa.sub_property_id, pa.month,
      SUM(pa.amount_allocated) AS total_allocated,
      MIN(p.receipt_number) AS receipt,
      sp.monthly_rent_bhd
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id
    JOIN sub_properties sp ON sp.id = pa.sub_property_id
    GROUP BY pa.sub_property_id, pa.month
  `).all();
  const existingAllocsJson = {};
  existingAllocs.forEach(a => {
    if (!existingAllocsJson[a.sub_property_id]) existingAllocsJson[a.sub_property_id] = {};
    const monthlyRent = a.monthly_rent_bhd || 0;
    const remaining = Math.max(0, monthlyRent - a.total_allocated);
    const status = remaining <= 0.001 ? 'paid' : 'partial';
    existingAllocsJson[a.sub_property_id][a.month] = {
      amount: a.total_allocated,
      remaining: remaining,
      status: status,
      receipt: a.receipt,
      monthlyRent: monthlyRent
    };
  });

  res.render('payments/new', {
    title: 'Record Payment', currentPath: '/payments',
    units, properties, unitsGrouped, selectedUnit, selectedBuildingId, monthlyRent, months,
    nextReceiptNumber: settings.next_receipt_number,
    today: new Date().toISOString().slice(0, 10),
    existingAllocsJson,
    currencyLabel: (settings && settings.currency_label) || 'BD',
    errors: []
  });
});

// ─── POST /payments ───────────────────────────────────────────
router.post('/', (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const {
    sub_property_id, tenant_id, total_amount, payment_method,
    bank_name, cheque_number, cheque_date, payment_date, notes,
    alloc_months, alloc_amounts, alloc_statuses
  } = req.body;

  const errors = [];
  if (!sub_property_id) errors.push('Unit is required.');
  if (!tenant_id) errors.push('Tenant is required.');
  const amt = parseFloat(total_amount);
  if (isNaN(amt) || amt <= 0) errors.push('Total amount must be greater than zero.');
  if (!['cash', 'card', 'transfer', 'cheque'].includes(payment_method)) errors.push('Invalid payment method.');
  if (!payment_date) errors.push('Payment date is required.');

  const settings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  const dec = getCurrencyDecimals(req.tenant && req.tenant.currency_code);
  const units = db.prepare(`
    SELECT sp.id, sp.name, sp.unit_number, sp.monthly_rent_bhd,
      p.id AS property_id, p.name AS property_name, t.full_name AS tenant_name, t.id AS tenant_id,
      tu.lease_start, tu.lease_end
    FROM sub_properties sp JOIN properties p ON p.id = sp.property_id
    JOIN tenant_units tu ON tu.sub_property_id = sp.id AND tu.is_current = 1
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE sp.is_archived = 0 AND sp.status = 'rented'
    ORDER BY p.name, sp.unit_number, sp.name
  `).all();

  const properties = [];
  const seenPropIds = new Set();
  for (const u of units) {
    if (!seenPropIds.has(u.property_id)) {
      properties.push({ id: u.property_id, name: u.property_name });
      seenPropIds.add(u.property_id);
    }
  }
  const unitsGrouped = {};
  for (const u of units) {
    if (!unitsGrouped[u.property_id]) unitsGrouped[u.property_id] = [];
    unitsGrouped[u.property_id].push(u);
  }

  const selectedUnit = units.find(u => String(u.id) === String(sub_property_id));
  const now = new Date();
  let endDate = new Date(now.getFullYear(), now.getMonth() + 6, 1);
  let startDate;
  if (selectedUnit && selectedUnit.lease_start) {
    const [sy, sm] = selectedUnit.lease_start.slice(0, 7).split('-');
    startDate = new Date(parseInt(sy), parseInt(sm) - 1, 1);
    if (selectedUnit.lease_end) {
      const [ey, em] = selectedUnit.lease_end.slice(0, 7).split('-');
      const leaseEndDate = new Date(parseInt(ey), parseInt(em) - 1, 1);
      if (leaseEndDate < endDate) endDate = leaseEndDate;
    }
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  }
  const months = [];
  const cur = new Date(startDate);
  while (cur <= endDate) {
    months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  months.sort((a, b) => b.localeCompare(a));

  // Validate per-month allocations against lease_start, lease_end, monthly rent, and existing allocations
  const monthlyRentVal = selectedUnit ? selectedUnit.monthly_rent_bhd : 0;
  const leaseStartVal = selectedUnit && selectedUnit.lease_start ? selectedUnit.lease_start.slice(0, 7) : null;
  const leaseEndVal = selectedUnit && selectedUnit.lease_end ? selectedUnit.lease_end.slice(0, 7) : null;
  const allocMonthsCheck = Array.isArray(alloc_months) ? alloc_months : (alloc_months ? [alloc_months] : []);
  const allocAmountsCheck = Array.isArray(alloc_amounts) ? alloc_amounts : (alloc_amounts ? [alloc_amounts] : []);
  for (let i = 0; i < allocMonthsCheck.length; i++) {
    const allocAmt = parseFloat(allocAmountsCheck[i] || 0);
    if (allocAmt <= 0) continue;
    if (leaseStartVal && allocMonthsCheck[i] < leaseStartVal) {
      errors.push(`Cannot allocate to ${allocMonthsCheck[i]} — before the rental start (${leaseStartVal}).`);
    }
    if (leaseEndVal && allocMonthsCheck[i] > leaseEndVal) {
      errors.push(`Cannot allocate to ${allocMonthsCheck[i]} — after the lease end (${leaseEndVal}).`);
    }
    if (monthlyRentVal > 0 && allocAmt > monthlyRentVal + 0.001) {
      errors.push(`Month ${allocMonthsCheck[i]}: BD ${allocAmt.toFixed(dec)} exceeds monthly rent of BD ${monthlyRentVal.toFixed(dec)}.`);
    }
    // Check for existing allocation for this unit+month — block only if fully paid or over-limit
    const existing = db.prepare(`
      SELECT SUM(pa.amount_allocated) AS total_allocated, sp.monthly_rent_bhd
      FROM payment_allocations pa
      JOIN sub_properties sp ON sp.id = pa.sub_property_id
      WHERE pa.sub_property_id = ? AND pa.month = ?
      GROUP BY pa.sub_property_id, pa.month
    `).get(sub_property_id, allocMonthsCheck[i]);
    if (existing) {
      const remaining = (existing.monthly_rent_bhd || 0) - existing.total_allocated;
      if (remaining <= 0.001) {
        errors.push(`${allocMonthsCheck[i]} is already fully paid (BD ${existing.total_allocated.toFixed(dec)}).`);
      } else if (allocAmt > remaining + 0.001) {
        errors.push(`Month ${allocMonthsCheck[i]}: BD ${allocAmt.toFixed(dec)} exceeds remaining amount of BD ${remaining.toFixed(dec)}.`);
      }
    }
  }

  // Build existingAllocsJson for re-render on error (aggregated per unit+month)
  const existingAllocsRaw = db.prepare(`
    SELECT pa.sub_property_id, pa.month,
      SUM(pa.amount_allocated) AS total_allocated,
      MIN(p.receipt_number) AS receipt,
      sp.monthly_rent_bhd
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id
    JOIN sub_properties sp ON sp.id = pa.sub_property_id
    GROUP BY pa.sub_property_id, pa.month
  `).all();
  const existingAllocsJson = {};
  existingAllocsRaw.forEach(a => {
    if (!existingAllocsJson[a.sub_property_id]) existingAllocsJson[a.sub_property_id] = {};
    const monthlyRent = a.monthly_rent_bhd || 0;
    const remaining = Math.max(0, monthlyRent - a.total_allocated);
    existingAllocsJson[a.sub_property_id][a.month] = {
      amount: a.total_allocated,
      remaining: remaining,
      status: remaining <= 0.001 ? 'paid' : 'partial',
      receipt: a.receipt,
      monthlyRent: monthlyRent
    };
  });

  if (errors.length) {
    return res.render('payments/new', {
      title: 'Record Payment', currentPath: '/payments',
      units, properties, unitsGrouped,
      selectedUnit,
      selectedBuildingId: selectedUnit ? String(selectedUnit.property_id) : '',
      monthlyRent: selectedUnit ? selectedUnit.monthly_rent_bhd : 0,
      months, nextReceiptNumber: settings.next_receipt_number,
      today: payment_date || now.toISOString().slice(0, 10),
      existingAllocsJson, errors
    });
  }

  const receiptNumber = settings.next_receipt_number;

  // Use a transaction for atomicity
  const insertPayment = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO payments (sub_property_id, tenant_id, total_amount, payment_method,
        bank_name, cheque_number, cheque_date, receipt_number, notes, created_by, payment_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sub_property_id, tenant_id, amt, payment_method,
      (bank_name || '').trim(), (cheque_number || '').trim(),
      cheque_date || null, receiptNumber,
      (notes || '').trim(), req.session.user.id, payment_date
    );

    const paymentId = result.lastInsertRowid;

    // Insert allocations
    const allocMonths  = Array.isArray(alloc_months)   ? alloc_months   : (alloc_months  ? [alloc_months]  : []);
    const allocAmounts = Array.isArray(alloc_amounts)   ? alloc_amounts  : (alloc_amounts ? [alloc_amounts] : []);
    const allocStates  = Array.isArray(alloc_statuses)  ? alloc_statuses : (alloc_statuses? [alloc_statuses]: []);

    for (let i = 0; i < allocMonths.length; i++) {
      const allocAmt = parseFloat(allocAmounts[i] || 0);
      if (!allocMonths[i] || allocAmt <= 0) continue;
      db.prepare(`
        INSERT INTO payment_allocations (payment_id, sub_property_id, month, amount_allocated, status)
        VALUES (?, ?, ?, ?, ?)
      `).run(paymentId, sub_property_id, allocMonths[i], allocAmt, allocStates[i] || 'paid');
    }

    // Increment receipt number
    db.prepare(`UPDATE settings SET next_receipt_number = next_receipt_number + 1`).run();

    return paymentId;
  });

  const paymentId = insertPayment();

  auditLog(req.session.user.id, req.session.user.name, 'payment_recorded', {
    payment_id: paymentId, receipt_number: receiptNumber, amount: amt, unit: sub_property_id
  });

  // Check if any amount is unallocated and warn (don't block)
  const allocMonthsArr  = Array.isArray(alloc_months)  ? alloc_months  : (alloc_months  ? [alloc_months]  : []);
  const allocAmountsArr = Array.isArray(alloc_amounts)  ? alloc_amounts : (alloc_amounts ? [alloc_amounts] : []);
  const totalAllocated  = allocAmountsArr.reduce((sum, v, i) => {
    return allocMonthsArr[i] ? sum + parseFloat(v || 0) : sum;
  }, 0);
  const unallocated = amt - totalAllocated;

  if (unallocated > 0.001) {
    req.session.flash = {
      type: 'warning',
      msg: `Payment recorded (Receipt #${receiptNumber}). BD ${unallocated.toFixed(dec)} is unallocated — not assigned to any rental month.`
    };
  } else {
    req.session.flash = { type: 'success', msg: `Payment recorded. Receipt #${receiptNumber}.` };
  }
  res.redirect('/payments/' + paymentId);
});

// ─── GET /payments/:id ────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db = req.db;
  const payment = db.prepare(`
    SELECT p.*, t.full_name AS tenant_name, t.tel AS tenant_tel, t.address AS tenant_address,
      t.po_box AS tenant_po_box,
      sp.name AS unit_name, sp.unit_number, sp.monthly_rent_bhd,
      prop.name AS property_name, prop.location AS property_location,
      prop.address AS property_address,
      u.name AS created_by_name
    FROM payments p
    JOIN tenants t ON t.id = p.tenant_id
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    LEFT JOIN users u ON u.id = p.created_by
    WHERE p.id = ?
  `).get(req.params.id);

  if (!payment) return res.status(404).render('404', { title: 'Not Found' });

  const allocations = db.prepare(`
    SELECT * FROM payment_allocations WHERE payment_id = ? ORDER BY month ASC
  `).all(req.params.id);

  const settings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();

  res.render('payments/show', {
    title: `Receipt #${payment.receipt_number}`,
    currentPath: '/payments',
    payment, allocations, settings,
    currencyLabel: (settings && settings.currency_label) || 'BD',
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ─── GET /payments/:id/edit ──────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const db = req.db;
  const payment = db.prepare(`
    SELECT p.*, t.full_name AS tenant_name,
      sp.name AS unit_name, sp.unit_number, sp.monthly_rent_bhd,
      prop.name AS property_name,
      tu.lease_start, tu.lease_end
    FROM payments p
    JOIN tenants t ON t.id = p.tenant_id
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    LEFT JOIN tenant_units tu ON tu.sub_property_id = p.sub_property_id AND tu.is_current = 1
    WHERE p.id = ?
  `).get(req.params.id);

  if (!payment) return res.status(404).render('404', { title: 'Not Found' });

  const editSettings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  const existingAllocs = db.prepare(`
    SELECT * FROM payment_allocations WHERE payment_id = ? ORDER BY month ASC
  `).all(req.params.id);

  // Build month list: from lease_start to +6 months ahead (capped at lease_end) + any existing allocation months
  const monthSet = new Set();
  const now = new Date();
  const leaseStart = payment.lease_start ? payment.lease_start.slice(0, 7) : null;
  const leaseEnd = payment.lease_end ? payment.lease_end.slice(0, 7) : null;
  let endDate = new Date(now.getFullYear(), now.getMonth() + 6, 1);
  let startDate;
  if (leaseStart) {
    const [sy, sm] = leaseStart.split('-');
    startDate = new Date(parseInt(sy), parseInt(sm) - 1, 1);
    if (leaseEnd) {
      const [ey, em] = leaseEnd.split('-');
      const leaseEndDate = new Date(parseInt(ey), parseInt(em) - 1, 1);
      if (leaseEndDate < endDate) endDate = leaseEndDate;
    }
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  }
  const cur = new Date(startDate);
  while (cur <= endDate) {
    monthSet.add(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  existingAllocs.forEach(a => monthSet.add(a.month));
  const months = Array.from(monthSet).sort((a, b) => b.localeCompare(a));

  // Build allocMap for quick lookup in the template
  const allocMap = {};
  existingAllocs.forEach(a => { allocMap[a.month] = a; });

  // Allocations from OTHER payments for this unit (aggregated, to warn about occupied months)
  const otherAllocsRaw = db.prepare(`
    SELECT pa.month,
      SUM(pa.amount_allocated) AS total_allocated,
      MIN(p.receipt_number) AS receipt,
      sp.monthly_rent_bhd
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id
    JOIN sub_properties sp ON sp.id = pa.sub_property_id
    WHERE pa.sub_property_id = ? AND pa.payment_id != ?
    GROUP BY pa.month
  `).all(payment.sub_property_id, req.params.id);
  const otherAllocsJson = {};
  otherAllocsRaw.forEach(r => {
    const monthlyRent = r.monthly_rent_bhd || 0;
    const remaining = Math.max(0, monthlyRent - r.total_allocated);
    otherAllocsJson[r.month] = {
      amount: r.total_allocated,
      remaining: remaining,
      status: remaining <= 0.001 ? 'paid' : 'partial',
      receipt: r.receipt,
      monthlyRent: monthlyRent
    };
  });

  res.render('payments/edit', {
    title: `Edit Receipt #${payment.receipt_number}`,
    currentPath: '/payments',
    payment, months, allocMap,
    monthlyRent: payment.monthly_rent_bhd || 0,
    leaseStart: leaseStart || '',
    leaseEnd: leaseEnd || '',
    otherAllocsJson,
    currencyLabel: (editSettings && editSettings.currency_label) || 'BD',
    errors: []
  });
});

// ─── POST /payments/:id/edit ──────────────────────────────────
router.post('/:id/edit', (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const {
    total_amount, payment_method, bank_name, cheque_number,
    cheque_date, payment_date, notes,
    alloc_months, alloc_amounts, alloc_statuses
  } = req.body;

  const payment = db.prepare(`
    SELECT p.*, t.full_name AS tenant_name,
      sp.name AS unit_name, sp.unit_number, sp.monthly_rent_bhd,
      prop.name AS property_name,
      tu.lease_start, tu.lease_end
    FROM payments p
    JOIN tenants t ON t.id = p.tenant_id
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    LEFT JOIN tenant_units tu ON tu.sub_property_id = p.sub_property_id AND tu.is_current = 1
    WHERE p.id = ?
  `).get(req.params.id);

  if (!payment) return res.status(404).render('404', { title: 'Not Found' });

  const errors = [];
  const dec = getCurrencyDecimals(req.tenant && req.tenant.currency_code);
  const amt = parseFloat(total_amount);
  if (isNaN(amt) || amt <= 0) errors.push('Total amount must be greater than zero.');
  if (!['cash', 'card', 'transfer', 'cheque'].includes(payment_method)) errors.push('Invalid payment method.');
  if (!payment_date) errors.push('Payment date is required.');

  // Per-month allocation validation
  const editLeaseStart = payment.lease_start ? payment.lease_start.slice(0, 7) : null;
  const editLeaseEnd = payment.lease_end ? payment.lease_end.slice(0, 7) : null;
  const editMonthlyRent = payment.monthly_rent_bhd || 0;
  const editAllocMonths = Array.isArray(alloc_months) ? alloc_months : (alloc_months ? [alloc_months] : []);
  const editAllocAmounts = Array.isArray(alloc_amounts) ? alloc_amounts : (alloc_amounts ? [alloc_amounts] : []);
  for (let i = 0; i < editAllocMonths.length; i++) {
    const allocAmt = parseFloat(editAllocAmounts[i] || 0);
    if (allocAmt <= 0) continue;
    if (editLeaseStart && editAllocMonths[i] < editLeaseStart) {
      errors.push(`Cannot allocate to ${editAllocMonths[i]} — before the rental start (${editLeaseStart}).`);
    }
    if (editLeaseEnd && editAllocMonths[i] > editLeaseEnd) {
      errors.push(`Cannot allocate to ${editAllocMonths[i]} — after the lease end (${editLeaseEnd}).`);
    }
    if (editMonthlyRent > 0 && allocAmt > editMonthlyRent + 0.001) {
      errors.push(`Month ${editAllocMonths[i]}: BD ${allocAmt.toFixed(dec)} exceeds monthly rent of BD ${editMonthlyRent.toFixed(dec)}.`);
    }
    // Check for existing allocation in OTHER payments for same unit+month — block only if fully paid or over-limit
    const conflicting = db.prepare(`
      SELECT SUM(pa.amount_allocated) AS total_allocated, sp.monthly_rent_bhd
      FROM payment_allocations pa
      JOIN sub_properties sp ON sp.id = pa.sub_property_id
      WHERE pa.sub_property_id = ? AND pa.month = ? AND pa.payment_id != ?
      GROUP BY pa.sub_property_id, pa.month
    `).get(payment.sub_property_id, editAllocMonths[i], req.params.id);
    if (conflicting) {
      const remaining = (conflicting.monthly_rent_bhd || 0) - conflicting.total_allocated;
      if (remaining <= 0.001) {
        errors.push(`${editAllocMonths[i]} is already fully paid by other receipts (BD ${conflicting.total_allocated.toFixed(dec)}).`);
      } else if (allocAmt > remaining + 0.001) {
        errors.push(`Month ${editAllocMonths[i]}: BD ${allocAmt.toFixed(dec)} exceeds remaining amount of BD ${remaining.toFixed(dec)} from other receipts.`);
      }
    }
  }

  // Build otherAllocsJson for re-render (aggregated allocs from OTHER payments for this unit)
  const buildOtherAllocs = () => {
    const rows = db.prepare(`
      SELECT pa.month,
        SUM(pa.amount_allocated) AS total_allocated,
        MIN(p.receipt_number) AS receipt,
        sp.monthly_rent_bhd
      FROM payment_allocations pa
      JOIN payments p ON p.id = pa.payment_id
      JOIN sub_properties sp ON sp.id = pa.sub_property_id
      WHERE pa.sub_property_id = ? AND pa.payment_id != ?
      GROUP BY pa.month
    `).all(payment.sub_property_id, req.params.id);
    const map = {};
    rows.forEach(r => {
      const monthlyRent = r.monthly_rent_bhd || 0;
      const remaining = Math.max(0, monthlyRent - r.total_allocated);
      map[r.month] = {
        amount: r.total_allocated,
        remaining: remaining,
        status: remaining <= 0.001 ? 'paid' : 'partial',
        receipt: r.receipt,
        monthlyRent: monthlyRent
      };
    });
    return map;
  };

  if (errors.length) {
    const existingAllocs = db.prepare(`SELECT * FROM payment_allocations WHERE payment_id = ? ORDER BY month ASC`).all(req.params.id);
    const monthSet = new Set();
    const now = new Date();
    let endDate = new Date(now.getFullYear(), now.getMonth() + 6, 1);
    let startDate;
    if (editLeaseStart) {
      const [sy, sm] = editLeaseStart.split('-');
      startDate = new Date(parseInt(sy), parseInt(sm) - 1, 1);
      if (editLeaseEnd) {
        const [ey, em] = editLeaseEnd.split('-');
        const leaseEndDate = new Date(parseInt(ey), parseInt(em) - 1, 1);
        if (leaseEndDate < endDate) endDate = leaseEndDate;
      }
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    }
    const cur = new Date(startDate);
    while (cur <= endDate) {
      monthSet.add(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
      cur.setMonth(cur.getMonth() + 1);
    }
    existingAllocs.forEach(a => monthSet.add(a.month));
    const months = Array.from(monthSet).sort((a, b) => b.localeCompare(a));
    const allocMap = {};
    existingAllocs.forEach(a => { allocMap[a.month] = a; });

    const postEditSettings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
    return res.render('payments/edit', {
      title: `Edit Receipt #${payment.receipt_number}`,
      currentPath: '/payments',
      payment: { ...payment, total_amount: amt || payment.total_amount, payment_method, bank_name, cheque_number, cheque_date, payment_date, notes },
      months, allocMap,
      monthlyRent: editMonthlyRent,
      leaseStart: editLeaseStart || '',
      leaseEnd: editLeaseEnd || '',
      otherAllocsJson: buildOtherAllocs(),
      currencyLabel: (postEditSettings && postEditSettings.currency_label) || 'BD',
      errors
    });
  }

  const allocMonthsArr  = Array.isArray(alloc_months)   ? alloc_months   : (alloc_months   ? [alloc_months]   : []);
  const allocAmountsArr = Array.isArray(alloc_amounts)   ? alloc_amounts  : (alloc_amounts  ? [alloc_amounts]  : []);
  const allocStatesArr  = Array.isArray(alloc_statuses)  ? alloc_statuses : (alloc_statuses ? [alloc_statuses] : []);

  db.transaction(() => {
    db.prepare(`
      UPDATE payments SET
        total_amount = ?, payment_method = ?, bank_name = ?,
        cheque_number = ?, cheque_date = ?, payment_date = ?, notes = ?
      WHERE id = ?
    `).run(
      amt, payment_method,
      (bank_name || '').trim(), (cheque_number || '').trim(),
      cheque_date || null, payment_date,
      (notes || '').trim(), req.params.id
    );

    // Replace all allocations
    db.prepare(`DELETE FROM payment_allocations WHERE payment_id = ?`).run(req.params.id);

    for (let i = 0; i < allocMonthsArr.length; i++) {
      const allocAmt = parseFloat(allocAmountsArr[i] || 0);
      if (!allocMonthsArr[i] || allocAmt <= 0) continue;
      db.prepare(`
        INSERT INTO payment_allocations (payment_id, sub_property_id, month, amount_allocated, status)
        VALUES (?, ?, ?, ?, ?)
      `).run(req.params.id, payment.sub_property_id, allocMonthsArr[i], allocAmt, allocStatesArr[i] || 'paid');
    }
  })();

  auditLog(req.session.user.id, req.session.user.name, 'payment_edited', {
    payment_id: parseInt(req.params.id), receipt_number: payment.receipt_number, new_amount: amt
  });

  // Warn if unallocated
  const totalAllocated = allocAmountsArr.reduce((sum, v, i) => {
    return allocMonthsArr[i] ? sum + parseFloat(v || 0) : sum;
  }, 0);
  const unallocated = amt - totalAllocated;

  if (unallocated > 0.001) {
    req.session.flash = {
      type: 'warning',
      msg: `Changes saved. BD ${unallocated.toFixed(dec)} is unallocated — not assigned to any rental month.`
    };
  } else {
    req.session.flash = { type: 'success', msg: 'Payment updated successfully.' };
  }

  res.redirect('/payments/' + req.params.id);
});

// ─── POST /payments/:id/delete ───────────────────────────────
router.post('/:id/delete', requireRole('admin'), (req, res) => {
  const db = req.db;
  const auditLog = makeAuditLog(db);
  const payment = db.prepare(`SELECT id, receipt_number FROM payments WHERE id = ?`).get(req.params.id);
  if (!payment) {
    req.session.flash = { type: 'danger', msg: 'Payment not found.' };
    return res.redirect('/payments');
  }

  db.prepare(`DELETE FROM payment_allocations WHERE payment_id = ?`).run(payment.id);
  db.prepare(`DELETE FROM payments WHERE id = ?`).run(payment.id);

  auditLog(req.session.user.id, req.session.user.name, 'payment_deleted', {
    payment_id: payment.id, receipt_number: payment.receipt_number
  });

  req.session.flash = { type: 'success', msg: `Receipt #${payment.receipt_number} deleted.` };
  res.redirect('/payments');
});

// ─── GET /payments/:id/pdf ────────────────────────────────────
router.get('/:id/pdf', async (req, res) => {
  const db = req.db;
  const payment = db.prepare(`
    SELECT p.*, t.full_name AS tenant_name, t.tel AS tenant_tel, t.address AS tenant_address,
      t.po_box AS tenant_po_box,
      sp.name AS unit_name, sp.unit_number, sp.monthly_rent_bhd,
      prop.name AS property_name, prop.location AS property_location,
      prop.address AS property_address,
      u.name AS created_by_name
    FROM payments p
    JOIN tenants t ON t.id = p.tenant_id
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    LEFT JOIN users u ON u.id = p.created_by
    WHERE p.id = ?
  `).get(req.params.id);

  if (!payment) return res.status(404).render('404', { title: 'Not Found' });

  const allocations = db.prepare(`SELECT * FROM payment_allocations WHERE payment_id = ? ORDER BY month ASC`).all(req.params.id);
  const settings    = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  const dec         = getCurrencyDecimals(req.tenant && req.tenant.currency_code);

  // Build allocation period string
  const periodStr = allocations.length > 0
    ? allocations.map(a => a.month).join(', ')
    : '';

  // Note field: combine period + payment notes
  const noteStr = [
    periodStr ? `Period: ${periodStr}` : '',
    payment.notes || ''
  ].filter(Boolean).join(' — ');

  // Cheque type label
  const methodLabel = payment.payment_method.charAt(0).toUpperCase() + payment.payment_method.slice(1);

  // Unit label
  const unitLabel = [payment.unit_number, payment.unit_name].filter(Boolean).join(' — ');

  // Whether to hide company name (anonymous copy)
  const hideName = req.query.noname === '1';

  // Convert numeric amount to English words (Dinars + Fils)
  function numberToWords(amount) {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
                  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
                  'Seventeen', 'Eighteen', 'Nineteen'];
    const tensArr = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    function hundreds(n) {
      if (n === 0) return '';
      let r = '';
      if (n >= 100) { r += ones[Math.floor(n / 100)] + ' Hundred'; n %= 100; if (n) r += ' and '; }
      if (n >= 20)  { r += tensArr[Math.floor(n / 10)]; if (n % 10) r += ' ' + ones[n % 10]; }
      else if (n)   { r += ones[n]; }
      return r;
    }

    function intToWords(n) {
      if (n === 0) return 'Zero';
      let r = '';
      if (n >= 1000000) { r += hundreds(Math.floor(n / 1000000)) + ' Million '; n %= 1000000; }
      if (n >= 1000)    { r += hundreds(Math.floor(n / 1000)) + ' Thousand '; n %= 1000; }
      if (n > 0)        { if (r && n < 100) r += 'and '; r += hundreds(n); }
      return r.trim();
    }

    const totalFils = Math.round(amount * 1000);
    const dinars    = Math.floor(totalFils / 1000);
    const fils      = totalFils % 1000;
    let words = intToWords(dinars) + (dinars === 1 ? ' Dinar' : ' Dinars');
    if (fils > 0) words += ' and ' + intToWords(fils) + (fils === 1 ? ' Fil' : ' Fils');
    return words + ' Only';
  }

  const amountInWords = numberToWords(payment.total_amount);

  // Logo HTML
  const logoHtml = settings.logo_path
    ? `<img src="http://localhost:${process.env.PORT || 3002}${settings.logo_path}" style="max-height:50px;max-width:120px;object-fit:contain;display:block;margin-bottom:4px;">`
    : '';

  const ownerName = settings.owner_name || 'My Company';

  // One receipt block — called twice with different copy label
  function receiptBlock(copyLabel) {
    return `
    <div class="receipt">
      <div class="receipt-title-row">
        <div class="receipt-word">RECEIPT</div>
        <div class="copy-label">${copyLabel}</div>
      </div>
      <div class="receipt-header">
        <div class="company-info">
          ${logoHtml}
          ${hideName ? '' : `<div class="company-name">${ownerName}</div>`}
          ${settings.address ? `<div class="company-detail">${settings.address}</div>` : ''}
          ${(settings.tel || settings.fax) ? `<div class="company-detail">Tel: ${settings.tel || ''}${settings.fax ? ' | Fax: ' + settings.fax : ''}</div>` : ''}
          ${settings.po_box ? `<div class="company-detail">P.O. Box: ${settings.po_box}</div>` : ''}
        </div>
        <div class="receipt-id-block">
          <div class="receipt-num">No. ${payment.receipt_number}</div>
          <table class="id-table">
            <tr>
              <td class="id-label">Date</td>
              <td class="id-value">${payment.payment_date}</td>
            </tr>
            <tr>
              <td class="id-label">Currency</td>
              <td class="id-value">${settings.currency_label || 'Bahrain Dinars'}</td>
            </tr>
          </table>
        </div>
      </div>
      <table class="body-table">
        <tr>
          <td class="field-label" style="width:110px;">Received from</td>
          <td class="field-value" colspan="3">
            <strong>${payment.tenant_name}</strong>
            ${payment.tenant_address ? ` — ${payment.tenant_address}` : ''}
            ${payment.tenant_tel ? ` — Tel: ${payment.tenant_tel}` : ''}
          </td>
        </tr>
        <tr>
          <td class="field-label">Property / Unit</td>
          <td class="field-value" colspan="3">${payment.property_name}${unitLabel ? ' — ' + unitLabel : ''}</td>
        </tr>
        <tr>
          <td class="field-label">Amount</td>
          <td class="field-value amount-val">${settings.currency_label || 'BD'} ${payment.total_amount.toFixed(dec)}</td>
          <td class="field-label" style="width:100px;">Cheque Type</td>
          <td class="field-value">${methodLabel}${payment.cheque_number ? ' — #' + payment.cheque_number : ''}</td>
        </tr>
        <tr>
          <td class="field-label">Bank</td>
          <td class="field-value">${payment.bank_name || '&nbsp;'}${payment.cheque_date ? ' — ' + payment.cheque_date : ''}</td>
          <td class="field-label">Note</td>
          <td class="field-value">${noteStr || '&nbsp;'}</td>
        </tr>
        <tr>
          <td class="field-label" style="white-space:nowrap;">Amount in Words</td>
          <td class="field-value amount-words" colspan="3">${amountInWords}</td>
        </tr>
      </table>
      <div class="receipt-footer">
        <div class="footer-note">${settings.receipt_footer_note || ''}</div>
        <div class="received-by">Received by: <span class="sig-line"></span></div>
      </div>
    </div>`;
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #000; background: #fff; width: 210mm; padding: 8mm 10mm; }
  .receipt { width: 100%; border: 1.5px solid #000; padding: 8px 10px; position: relative; height: 128mm; display: flex; flex-direction: column; justify-content: space-between; }
  .receipt-title-row { display: flex; justify-content: center; align-items: center; position: relative; margin-bottom: 5px; }
  .copy-label { position: absolute; right: 0; top: 50%; transform: translateY(-50%); font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; border: 1px solid #000; padding: 1px 6px; color: #000; }
  .receipt-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #000; padding-bottom: 6px; margin-bottom: 0; }
  .company-name { font-size: 14px; font-weight: 900; text-transform: uppercase; letter-spacing: .02em; margin-bottom: 3px; }
  .company-detail { font-size: 9.5px; color: #222; line-height: 1.5; }
  .receipt-id-block { text-align: right; }
  .receipt-word { font-size: 18px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
  .receipt-num { font-size: 13px; font-weight: 700; margin-bottom: 4px; }
  .id-table { border-collapse: collapse; margin-left: auto; }
  .id-table td { padding: 1px 4px; font-size: 9.5px; }
  .id-label { color: #444; text-align: right; }
  .id-value { font-weight: 600; border-bottom: 1px solid #aaa; min-width: 90px; }
  .body-table { width: 100%; border-collapse: collapse; flex: 1; margin-top: 0; }
  .body-table tr { border: 1px solid #000; }
  .body-table td { border: 1px solid #000; padding: 5px 7px; vertical-align: middle; }
  .field-label { background: #f0f0f0; font-weight: 700; font-size: 10px; white-space: nowrap; color: #222; }
  .field-value { font-size: 11px; }
  .amount-val { font-size: 13px; font-weight: 900; }
  .amount-words { font-style: italic; font-weight: 600; }
  .receipt-footer { display: flex; justify-content: space-between; align-items: flex-end; border-top: 1px solid #000; padding-top: 5px; margin-top: 0; }
  .footer-note { font-size: 8.5px; color: #333; font-style: italic; max-width: 55%; }
  .received-by { font-size: 10px; font-weight: 600; white-space: nowrap; }
  .sig-line { display: inline-block; width: 100px; border-bottom: 1px solid #000; margin-left: 6px; vertical-align: bottom; }
  .cut-line { width: 100%; text-align: center; border-top: 1.5px dashed #666; margin: 5mm 0; position: relative; line-height: 0; }
  .cut-line span { background: #fff; padding: 0 8px; font-size: 8px; color: #888; position: relative; top: -6px; font-family: Arial, sans-serif; }
</style>
</head>
<body>
  ${receiptBlock('Customer Copy')}
  <div class="cut-line"><span>&#9986; &nbsp; CUT HERE &nbsp; &#9986;</span></div>
  ${receiptBlock('Internal Copy')}
</body>
</html>`;

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', margin: { top: '0', right: '0', bottom: '0', left: '0' }, printBackground: true });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${payment.receipt_number}.pdf"`);
    res.end(pdf);
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).render('500', { title: 'PDF Error', error: err.message });
  }
});

module.exports = router;
