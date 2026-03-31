const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');

router.use(requireAuth);
router.use(requireRole('admin', 'reporter'));

// ─── GET /reports ─────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = req.db;

  // Dashboard stats
  const totalProperties = db.prepare(`SELECT COUNT(*) AS cnt FROM properties WHERE is_archived = 0`).get().cnt;
  const totalUnits = db.prepare(`
    SELECT COUNT(*) AS cnt FROM sub_properties
    WHERE is_archived = 0
      AND id NOT IN (SELECT virtual_sub_property_id FROM unit_groups)
  `).get().cnt;

  const rentedUnits = db.prepare(`
    SELECT COUNT(*) AS cnt FROM sub_properties sp
    WHERE sp.is_archived = 0
      AND sp.id NOT IN (SELECT virtual_sub_property_id FROM unit_groups)
      AND (
        sp.status = 'rented'
        OR sp.id IN (
          SELECT ugm.sub_property_id
          FROM unit_group_members ugm
          JOIN unit_groups ug ON ug.id = ugm.group_id
          JOIN sub_properties vsp ON vsp.id = ug.virtual_sub_property_id
          WHERE vsp.status = 'rented'
        )
      )
  `).get().cnt;
  const totalTenants    = db.prepare(`SELECT COUNT(*) AS cnt FROM tenants WHERE status = 'active'`).get().cnt;

  // Current month income
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthIncome = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) AS total
    FROM payments
    WHERE strftime('%Y-%m', payment_date) = ?
  `).get(thisMonth).total;

  // Last 12 months income chart data
  const monthlyIncome = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const row = db.prepare(`SELECT COALESCE(SUM(total_amount), 0) AS total FROM payments WHERE strftime('%Y-%m', payment_date) = ?`).get(m);
    monthlyIncome.push({ month: m, total: row.total });
  }

  // Recent payments
  const recentPayments = db.prepare(`
    SELECT p.*, t.full_name AS tenant_name, sp.name AS unit_name, sp.unit_number,
      prop.name AS property_name
    FROM payments p
    JOIN tenants t ON t.id = p.tenant_id
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    ORDER BY p.payment_date DESC, p.id DESC
    LIMIT 3
  `).all();

  // Vacant units grouped by property (physical units only)
  const vacantByProperty = db.prepare(`
    SELECT p.id AS property_id, p.name AS property_name, COUNT(*) AS vacant_count
    FROM sub_properties sp
    JOIN properties p ON p.id = sp.property_id
    WHERE sp.is_archived = 0
      AND sp.id NOT IN (SELECT virtual_sub_property_id FROM unit_groups)
      AND (
        sp.status = 'new'
        OR sp.id IN (
          SELECT ugm.sub_property_id
          FROM unit_group_members ugm
          JOIN unit_groups ug ON ug.id = ugm.group_id
          JOIN sub_properties vsp ON vsp.id = ug.virtual_sub_property_id
          WHERE vsp.status = 'new'
        )
      )
    GROUP BY p.id, p.name
    ORDER BY vacant_count DESC
  `).all();

  const vacantCount     = totalUnits - rentedUnits;
  const occupancyPct    = totalUnits > 0 ? Math.round((rentedUnits / totalUnits) * 100) : 0;
  const vacancyPct      = totalUnits > 0 ? Math.round((vacantCount / totalUnits) * 100) : 0;
  const expectedMonthly = db.prepare(`
    SELECT COALESCE(SUM(monthly_rent_bhd), 0) AS total
    FROM sub_properties WHERE is_archived = 0 AND status = 'rented'
  `).get().total;

  const rSettings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  res.render('reports/index', {
    title: 'Reports & Dashboard', currentPath: '/reports',
    totalProperties, totalUnits, rentedUnits, totalTenants,
    monthIncome, thisMonth, monthlyIncome, recentPayments,
    vacantByProperty, vacantCount, occupancyPct, vacancyPct, expectedMonthly,
    currencyLabel: (rSettings && rSettings.currency_label) || 'BD'
  });
});

// ─── GET /reports/income ──────────────────────────────────────
router.get('/income', (req, res) => {
  const db = req.db;
  const now = new Date();
  const yearFilter  = parseInt(req.query.year)  || now.getFullYear();
  const monthFilter = req.query.month || '';
  const propFilter  = req.query.property_id || '';

  let where = `WHERE 1=1`;
  const params = [];

  if (yearFilter) {
    where += ` AND strftime('%Y', p.payment_date) = ?`;
    params.push(String(yearFilter));
  }
  if (monthFilter) {
    where += ` AND strftime('%m', p.payment_date) = ?`;
    params.push(monthFilter.padStart(2, '0'));
  }
  if (propFilter) {
    where += ` AND prop.id = ?`;
    params.push(propFilter);
  }

  const payments = db.prepare(`
    SELECT p.*, t.full_name AS tenant_name,
      sp.name AS unit_name, sp.unit_number,
      prop.name AS property_name, prop.id AS property_id
    FROM payments p
    JOIN tenants t ON t.id = p.tenant_id
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    ${where}
    ORDER BY p.payment_date DESC, p.id DESC
  `).all(...params);

  const totalIncome = payments.reduce((s, p) => s + p.total_amount, 0);

  const properties = db.prepare(`SELECT id, name FROM properties WHERE is_archived = 0 ORDER BY name`).all();

  // Group by property
  const byProperty = {};
  payments.forEach(p => {
    if (!byProperty[p.property_id]) {
      byProperty[p.property_id] = { name: p.property_name, total: 0, count: 0 };
    }
    byProperty[p.property_id].total += p.total_amount;
    byProperty[p.property_id].count++;
  });

  const years = [];
  for (let y = now.getFullYear(); y >= now.getFullYear() - 5; y--) years.push(y);

  const incSettings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  res.render('reports/income', {
    title: 'Income Report', currentPath: '/reports/income',
    payments, totalIncome, byProperty,
    properties, yearFilter, monthFilter, propFilter, years,
    currencyLabel: (incSettings && incSettings.currency_label) || 'BD'
  });
});

// ─── GET /reports/rent-roll ───────────────────────────────────
router.get('/rent-roll', (req, res) => {
  const db = req.db;
  const now = new Date();
  const year  = parseInt(req.query.year)  || now.getFullYear();
  const month = req.query.month || String(now.getMonth() + 1).padStart(2, '0');
  const targetMonth = `${year}-${month.padStart(2, '0')}`;

  // All rented units with tenant and allocation status for target month
  const rows = db.prepare(`
    SELECT sp.id AS unit_id, sp.name AS unit_name, sp.unit_number,
      sp.monthly_rent_bhd,
      p.name AS property_name,
      t.full_name AS tenant_name, t.id AS tenant_id,
      COALESCE(SUM(pa.amount_allocated), 0) AS paid_amount,
      MAX(pa.status) AS alloc_status
    FROM sub_properties sp
    JOIN properties p ON p.id = sp.property_id
    LEFT JOIN tenant_units tu ON tu.sub_property_id = sp.id AND tu.is_current = 1
    LEFT JOIN tenants t ON t.id = tu.tenant_id
    LEFT JOIN payment_allocations pa ON pa.sub_property_id = sp.id AND pa.month = ?
    WHERE sp.is_archived = 0
    GROUP BY sp.id
    ORDER BY p.name, sp.unit_number, sp.name
  `).all(targetMonth);

  const totalRent  = rows.filter(r => r.tenant_id).reduce((s, r) => s + r.monthly_rent_bhd, 0);
  const totalPaid  = rows.reduce((s, r) => s + r.paid_amount, 0);

  const years = [];
  for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y--) years.push(y);

  const rrSettings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  res.render('reports/rent_roll', {
    title: 'Rent Roll', currentPath: '/reports/rent-roll',
    rows, targetMonth, year, month, years, totalRent, totalPaid,
    currencyLabel: (rrSettings && rrSettings.currency_label) || 'BD'
  });
});

// ─── GET /reports/income/export — Excel ───────────────────────
router.get('/income/export', (req, res) => {
  const db = req.db;
  const now = new Date();
  const yearFilter  = parseInt(req.query.year)  || now.getFullYear();
  const monthFilter = req.query.month || '';
  const propFilter  = req.query.property_id || '';

  let where = `WHERE 1=1`;
  const params = [];
  if (yearFilter) { where += ` AND strftime('%Y', p.payment_date) = ?`; params.push(String(yearFilter)); }
  if (monthFilter) { where += ` AND strftime('%m', p.payment_date) = ?`; params.push(monthFilter.padStart(2, '0')); }
  if (propFilter) { where += ` AND prop.id = ?`; params.push(propFilter); }

  const payments = db.prepare(`
    SELECT p.payment_date, p.receipt_number, t.full_name AS tenant_name,
      prop.name AS property_name, sp.unit_number, sp.name AS unit_name,
      p.payment_method, p.cheque_number, p.bank_name, p.total_amount, p.notes
    FROM payments p
    JOIN tenants t ON t.id = p.tenant_id
    JOIN sub_properties sp ON sp.id = p.sub_property_id
    JOIN properties prop ON prop.id = sp.property_id
    ${where}
    ORDER BY p.payment_date DESC, p.id DESC
  `).all(...params);

  const settings = db.prepare(`SELECT owner_name FROM settings LIMIT 1`).get();
  const wb = new ExcelJS.Workbook();
  wb.creator = settings.owner_name;
  const ws = wb.addWorksheet('Income Report');

  // Title row
  ws.mergeCells('A1:K1');
  ws.getCell('A1').value = `${settings.owner_name} — Income Report`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A1').alignment = { horizontal: 'center' };

  const filterDesc = [
    yearFilter ? `Year: ${yearFilter}` : '',
    monthFilter ? `Month: ${monthFilter}` : '',
    propFilter ? `Property filter applied` : ''
  ].filter(Boolean).join(' | ') || 'All Records';
  ws.mergeCells('A2:K2');
  ws.getCell('A2').value = filterDesc;
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF666666' } };
  ws.getCell('A2').alignment = { horizontal: 'center' };

  ws.addRow([]);

  // Header
  const headerRow = ws.addRow([
    'Date', 'Receipt #', 'Tenant', 'Property', 'Unit No.', 'Unit Name',
    'Method', 'Cheque #', 'Bank', 'Amount', 'Notes'
  ]);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
    cell.alignment = { horizontal: 'center' };
    cell.border = { bottom: { style: 'thin' } };
  });

  // Data rows
  let total = 0;
  payments.forEach((p, i) => {
    const row = ws.addRow([
      p.payment_date, p.receipt_number, p.tenant_name, p.property_name,
      p.unit_number || '', p.unit_name, p.payment_method, p.cheque_number || '',
      p.bank_name || '', p.total_amount, p.notes || ''
    ]);
    if (i % 2 === 0) {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
      });
    }
    row.getCell(10).numFmt = '#,##0.000';
    total += p.total_amount;
  });

  // Total row
  ws.addRow([]);
  const totalRow = ws.addRow(['', '', '', '', '', '', '', '', 'TOTAL', total, '']);
  totalRow.getCell(9).font = { bold: true };
  totalRow.getCell(10).font = { bold: true };
  totalRow.getCell(10).numFmt = '#,##0.000';

  // Column widths
  ws.columns = [
    { width: 12 }, { width: 10 }, { width: 24 }, { width: 22 }, { width: 9 },
    { width: 20 }, { width: 10 }, { width: 12 }, { width: 18 }, { width: 13 }, { width: 24 }
  ];

  const filename = `income-report-${yearFilter}${monthFilter ? '-' + monthFilter : ''}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  wb.xlsx.write(res).then(() => res.end());
});

// ─── GET /reports/rent-roll/export — Excel ────────────────────
router.get('/rent-roll/export', (req, res) => {
  const db = req.db;
  const now = new Date();
  const year  = parseInt(req.query.year)  || now.getFullYear();
  const month = req.query.month || String(now.getMonth() + 1).padStart(2, '0');
  const targetMonth = `${year}-${month.padStart(2, '0')}`;

  const rows = db.prepare(`
    SELECT sp.id AS unit_id, sp.name AS unit_name, sp.unit_number,
      sp.monthly_rent_bhd, p.name AS property_name,
      t.full_name AS tenant_name,
      COALESCE(SUM(pa.amount_allocated), 0) AS paid_amount
    FROM sub_properties sp
    JOIN properties p ON p.id = sp.property_id
    LEFT JOIN tenant_units tu ON tu.sub_property_id = sp.id AND tu.is_current = 1
    LEFT JOIN tenants t ON t.id = tu.tenant_id
    LEFT JOIN payment_allocations pa ON pa.sub_property_id = sp.id AND pa.month = ?
    WHERE sp.is_archived = 0
    GROUP BY sp.id
    ORDER BY p.name, sp.unit_number, sp.name
  `).all(targetMonth);

  const settings = db.prepare(`SELECT owner_name FROM settings LIMIT 1`).get();
  const wb = new ExcelJS.Workbook();
  wb.creator = settings.owner_name;
  const ws = wb.addWorksheet('Rent Roll');

  ws.mergeCells('A1:G1');
  ws.getCell('A1').value = `${settings.owner_name} — Rent Roll: ${targetMonth}`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.addRow([]);

  const headerRow = ws.addRow(['Property', 'Unit No.', 'Unit Name', 'Tenant', 'Rent', 'Paid', 'Balance', 'Status']);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
    cell.alignment = { horizontal: 'center' };
  });

  let totalRent = 0, totalPaid = 0;
  rows.forEach((r, i) => {
    const balance = r.tenant_name ? r.monthly_rent_bhd - r.paid_amount : 0;
    const rent = r.tenant_name ? r.monthly_rent_bhd : 0;
    let status;
    if (!r.tenant_name) status = 'Vacant';
    else if (r.paid_amount >= r.monthly_rent_bhd) status = 'Paid';
    else if (r.paid_amount > 0) status = 'Partial';
    else status = 'Unpaid';

    const row = ws.addRow([
      r.property_name, r.unit_number || '', r.unit_name,
      r.tenant_name || '—', rent, r.paid_amount, balance, status
    ]);
    if (i % 2 === 0) {
      row.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } }; });
    }
    row.getCell(5).numFmt = '#,##0.000';
    row.getCell(6).numFmt = '#,##0.000';
    row.getCell(7).numFmt = '#,##0.000';
    if (status === 'Unpaid') row.getCell(8).font = { color: { argb: 'FFCC0000' }, bold: true };
    if (status === 'Paid')   row.getCell(8).font = { color: { argb: 'FF006600' }, bold: true };
    totalRent += rent;
    totalPaid += r.paid_amount;
  });

  ws.addRow([]);
  const totalRow = ws.addRow(['', '', '', 'TOTAL', totalRent, totalPaid, totalRent - totalPaid, '']);
  totalRow.getCell(4).font = { bold: true };
  [5, 6, 7].forEach(c => { totalRow.getCell(c).font = { bold: true }; totalRow.getCell(c).numFmt = '#,##0.000'; });

  ws.columns = [{ width: 22 }, { width: 9 }, { width: 20 }, { width: 24 }, { width: 12 }, { width: 12 }, { width: 13 }, { width: 10 }];

  const filename = `rent-roll-${targetMonth}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  wb.xlsx.write(res).then(() => res.end());
});

// ─── GET /reports/outstanding ─────────────────────────────────
router.get('/outstanding', (req, res) => {
  const db = req.db;
  const now = new Date();

  // Build last 6 months list
  const checkMonths = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    checkMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  // For each rented unit, find months with no full payment
  const rentedUnits = db.prepare(`
    SELECT sp.id, sp.name AS unit_name, sp.unit_number, sp.monthly_rent_bhd,
      p.name AS property_name,
      t.full_name AS tenant_name, t.id AS tenant_id, t.tel AS tenant_tel,
      tu.lease_start
    FROM sub_properties sp
    JOIN properties p ON p.id = sp.property_id
    JOIN tenant_units tu ON tu.sub_property_id = sp.id AND tu.is_current = 1
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE sp.is_archived = 0
    ORDER BY p.name, sp.unit_number, sp.name
  `).all();

  const outstanding = [];
  for (const unit of rentedUnits) {
    let totalOwed = 0;
    const unpaidMonths = [];

    for (const m of checkMonths) {
      // Only check months after lease start
      if (m < unit.lease_start.slice(0, 7)) continue;

      const alloc = db.prepare(`
        SELECT COALESCE(SUM(amount_allocated), 0) AS paid
        FROM payment_allocations
        WHERE sub_property_id = ? AND month = ?
      `).get(unit.id, m);

      const paid = alloc.paid;
      const owed = unit.monthly_rent_bhd - paid;
      if (owed > 0.001) {
        unpaidMonths.push({ month: m, paid, owed });
        totalOwed += owed;
      }
    }

    if (unpaidMonths.length > 0) {
      outstanding.push({ ...unit, unpaidMonths, totalOwed });
    }
  }

  // Sort by total owed descending
  outstanding.sort((a, b) => b.totalOwed - a.totalOwed);

  const grandTotal = outstanding.reduce((s, r) => s + r.totalOwed, 0);

  const osSettings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  res.render('reports/outstanding', {
    title: 'Outstanding Balances', currentPath: '/reports/outstanding',
    outstanding, grandTotal, checkMonths,
    currencyLabel: (osSettings && osSettings.currency_label) || 'BD'
  });
});

// ─── GET /reports/calendar ────────────────────────────────────
router.get('/calendar', (req, res) => {
  const db  = req.db;
  const now = new Date();
  const year       = parseInt(req.query.year) || now.getFullYear();
  const propFilter = req.query.property_id   || '';

  // All months for this year
  const months = [];
  for (let m = 1; m <= 12; m++) {
    months.push(`${year}-${String(m).padStart(2, '0')}`);
  }

  // All non-archived units, optionally filtered by property
  let unitQuery = `
    SELECT sp.id, sp.name AS unit_name, sp.unit_number, sp.monthly_rent_bhd,
           sp.status AS unit_status,
           p.id AS property_id, p.name AS property_name
    FROM sub_properties sp
    JOIN properties p ON p.id = sp.property_id
    WHERE sp.is_archived = 0 AND p.is_archived = 0 AND sp.status != 'blocked'
  `;
  const unitParams = [];
  if (propFilter) { unitQuery += ` AND p.id = ?`; unitParams.push(propFilter); }
  unitQuery += ` ORDER BY p.name, sp.unit_number, sp.name`;
  const units = db.prepare(unitQuery).all(...unitParams);

  // All payment allocations for this year
  const allocations = db.prepare(`
    SELECT pa.sub_property_id, pa.month, pa.amount_allocated, pa.status, pa.payment_id
    FROM payment_allocations pa
    WHERE pa.month LIKE ?
  `).all(`${year}-%`);

  // Build allocation lookup: unitId → month → { status, payment_id, amount }
  const allocMap = {};
  for (const a of allocations) {
    if (!allocMap[a.sub_property_id]) allocMap[a.sub_property_id] = {};
    if (!allocMap[a.sub_property_id][a.month]) {
      allocMap[a.sub_property_id][a.month] = { status: a.status, payment_id: a.payment_id, amount: 0 };
    }
    allocMap[a.sub_property_id][a.month].amount += a.amount_allocated;
  }

  // All tenant leases that overlap this year (to know if unit was rented each month)
  const leases = db.prepare(`
    SELECT tu.sub_property_id, tu.lease_start, tu.lease_end, tu.is_current,
           t.full_name AS tenant_name, t.id AS tenant_id
    FROM tenant_units tu
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE tu.lease_start <= ? AND (tu.lease_end IS NULL OR tu.lease_end >= ?)
  `).all(`${year}-12-31`, `${year}-01-01`);

  // Build lease lookup: unitId → array of { tenant_name, tenant_id, lease_start, lease_end }
  const leaseMap = {};
  for (const l of leases) {
    if (!leaseMap[l.sub_property_id]) leaseMap[l.sub_property_id] = [];
    leaseMap[l.sub_property_id].push(l);
  }

  // Helper: was a unit rented in a given month?
  function getTenantForMonth(unitId, month) {
    const ls = leaseMap[unitId] || [];
    const mStart = month + '-01';
    const mEnd   = month + '-31';
    for (const l of ls) {
      const leaseEnd = l.lease_end || '9999-12-31';
      if (l.lease_start <= mEnd && leaseEnd >= mStart) return l;
    }
    return null;
  }

  // Build grid data: array of { unit, cells: [{ month, cellStatus, payment_id, amount, tenant }] }
  const grid = units.map(unit => {
    const cells = months.map(month => {
      const tenant = getTenantForMonth(unit.id, month);
      const alloc  = (allocMap[unit.id] || {})[month];

      let cellStatus;
      if (!tenant) {
        cellStatus = 'vacant';
      } else if (!alloc) {
        // Future months: don't mark unpaid yet
        const monthDate = new Date(month + '-01');
        const todayMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        cellStatus = monthDate > todayMonth ? 'future' : 'unpaid';
      } else {
        // Derive status from amount vs monthly rent
        const rent = unit.monthly_rent_bhd;
        if (alloc.amount >= rent - 0.001) {
          cellStatus = 'paid';
        } else if (alloc.amount > 0.001) {
          cellStatus = 'partial';
        } else {
          cellStatus = 'unpaid';
        }
      }

      return {
        month,
        cellStatus,
        payment_id: alloc ? alloc.payment_id : null,
        amount:     alloc ? alloc.amount      : 0,
        tenant:     tenant ? tenant.tenant_name : null,
        tenant_id:  tenant ? tenant.tenant_id  : null
      };
    });

    return { unit, cells };
  });

  // Group grid by property
  const byProperty = {};
  for (const row of grid) {
    const pid = row.unit.property_id;
    if (!byProperty[pid]) byProperty[pid] = { name: row.unit.property_name, rows: [] };
    byProperty[pid].rows.push(row);
  }

  // Summary counts across all cells
  let totalPaid = 0, totalPartial = 0, totalUnpaid = 0, totalVacant = 0;
  for (const row of grid) {
    for (const cell of row.cells) {
      if (cell.cellStatus === 'paid')    totalPaid++;
      else if (cell.cellStatus === 'partial') totalPartial++;
      else if (cell.cellStatus === 'unpaid')  totalUnpaid++;
      else if (cell.cellStatus === 'vacant')  totalVacant++;
    }
  }

  const properties = db.prepare(`SELECT id, name FROM properties WHERE is_archived = 0 ORDER BY name`).all();
  const years = [];
  for (let y = now.getFullYear() + 1; y >= now.getFullYear() - 4; y--) years.push(y);

  const calSettings = db.prepare(`SELECT * FROM settings LIMIT 1`).get();
  res.render('reports/calendar', {
    title: 'Payment Calendar', currentPath: '/reports/calendar',
    grid, byProperty, months, year, propFilter,
    properties, years,
    totalPaid, totalPartial, totalUnpaid, totalVacant,
    monthNames: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    currencyLabel: (calSettings && calSettings.currency_label) || 'BD'
  });
});

module.exports = router;
