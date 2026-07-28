#!/usr/bin/env node
/**
 * import-excel.js
 * Imports adeem-export.xlsx into a tenant database.
 *
 * Usage:
 *   node scripts/import-excel.js                    → imports into adeemcom
 *   node scripts/import-excel.js --tenant khalifa   → imports into khalifa
 *   node scripts/import-excel.js --dry-run          → preview only, no writes
 */

const path = require('path');
const ExcelJS = require('exceljs');
const { getTenantDb } = require('../db/tenantDb');

const EXCEL_PATH = path.resolve('/root/adeem-real-estate/adeem-export.xlsx');

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tenantIdx = args.indexOf('--tenant');
const TENANT_SLUG = tenantIdx !== -1 ? args[tenantIdx + 1] : 'adeemcom';

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────

function toDateStr(val) {
  if (!val) return null;
  if (typeof val === 'string') return val.slice(0, 10);
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return null;
}

function str(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

async function readSheet(wb, name) {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`Sheet "${name}" not found`);
  const rows = [];
  let headers = null;
  ws.eachRow((row, i) => {
    const vals = row.values.slice(1);
    if (i === 1) { headers = vals.map(h => str(h)); return; }
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] !== undefined ? vals[idx] : null; });
    rows.push(obj);
  });
  return rows;
}

// ────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────

async function main() {
  console.log(`\nAdeem Excel Import`);
  console.log(`  Source : ${EXCEL_PATH}`);
  console.log(`  Target : ${TENANT_SLUG}`);
  console.log(`  Mode   : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}\n`);

  // Load Excel
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_PATH);

  const propRows     = await readSheet(wb, 'Properties');
  const unitRows     = await readSheet(wb, 'Units');
  const tenantRows   = await readSheet(wb, 'Tenants');
  const tenancyRows  = await readSheet(wb, 'Tenancies');
  const paymentRows  = await readSheet(wb, 'Payments');

  console.log('Excel data loaded:');
  console.log(`  Properties : ${propRows.length}`);
  console.log(`  Units      : ${unitRows.length}`);
  console.log(`  Tenants    : ${tenantRows.length}`);
  console.log(`  Tenancies  : ${tenancyRows.length}`);
  console.log(`  Payments   : ${paymentRows.length}`);

  if (dryRun) {
    previewWarnings(propRows, unitRows, tenantRows, tenancyRows, paymentRows);
    console.log('\n[DRY RUN] No changes written.');
    return;
  }

  // Open DB
  const db = getTenantDb(TENANT_SLUG);

  // Check DB is empty
  const existing = db.prepare('SELECT COUNT(*) as n FROM properties').get();
  if (existing.n > 0) {
    console.error(`\nERROR: ${TENANT_SLUG} already has ${existing.n} properties. Aborting to prevent duplicates.`);
    console.error('       Drop the database or use a fresh tenant to re-import.');
    process.exit(1);
  }

  // Run all inserts in one transaction
  db.transaction(() => {
    // ── Phase 1: Properties ──────────────────────────────────────────
    const insertProp = db.prepare(`
      INSERT INTO properties (id, name, location, address, status, is_archived, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const propNameToId = {};  // "1002" → 4
    for (const r of propRows) {
      const id = Number(r['ID']);
      const name = str(r['Name']);
      insertProp.run(id, name, str(r['Location']), str(r['Address']),
        str(r['Status']) || 'active', Number(r['Archived']) || 0, str(r['Created At']) || null);
      propNameToId[name] = id;
    }
    console.log(`\n✓ Properties inserted: ${propRows.length}`);

    // ── Phase 2: Units (sub_properties) ──────────────────────────────
    const insertUnit = db.prepare(`
      INSERT INTO sub_properties (id, property_id, name, unit_number, address, monthly_rent_bhd, status, is_archived, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Two lookup maps for tenancy matching
    const unitKeyByNum  = {};  // "propId_unitNumber" → unitId
    const unitKeyByName = {};  // "propId_unitName"   → unitId
    let unitCount = 0;
    for (const r of unitRows) {
      const id        = Number(r['ID']);
      const propName  = str(r['Property']);
      const propId    = propNameToId[propName];
      if (!propId) { console.warn(`  WARN unit ${id}: unknown property "${propName}"`); continue; }
      const unitNum   = str(r['Unit Number']);
      const unitName  = str(r['Unit Name']);
      const rent      = Number(r['Monthly Rent (BD)']) || 0;
      const status    = str(r['Status']) || 'new';
      insertUnit.run(id, propId, unitName || unitNum, unitNum, str(r['Address']),
        rent, status, Number(r['Archived']) || 0, str(r['Created At']) || null);
      if (unitNum)  unitKeyByNum[`${propId}_${unitNum}`]   = id;
      if (unitName) unitKeyByName[`${propId}_${unitName}`] = id;
      unitCount++;
    }
    console.log(`✓ Units inserted: ${unitCount}`);

    // ── Phase 3: Tenants ─────────────────────────────────────────────
    const insertTenant = db.prepare(`
      INSERT INTO tenants (id, full_name, tel, fax, po_box, address, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tenantNameToId = {};  // "FULL NAME" → id
    for (const r of tenantRows) {
      const id   = Number(r['ID']);
      const name = str(r['Full Name']);
      insertTenant.run(id, name, str(r['Tel']), str(r['Fax']), str(r['PO Box']),
        str(r['Address']), str(r['Status']) || 'active', str(r['Created At']) || null);
      tenantNameToId[name] = id;
    }
    console.log(`✓ Tenants inserted: ${tenantRows.length}`);

    // ── Phase 4: Tenancies (tenant_units) ────────────────────────────
    const insertTenancy = db.prepare(`
      INSERT INTO tenant_units (tenant_id, sub_property_id, lease_start, lease_end, is_current)
      VALUES (?, ?, ?, ?, ?)
    `);
    let tenancyOk = 0, tenancyWarn = 0;
    for (const r of tenancyRows) {
      const tenantName = str(r['Tenant']);
      const propName   = str(r['Property']);
      const unitNum    = str(r['Unit Number']);
      const unitName   = str(r['Unit Name']);

      const tenantId = tenantNameToId[tenantName];
      const propId   = propNameToId[propName];

      if (!tenantId) {
        console.warn(`  WARN tenancy: tenant not found "${tenantName}"`);
        tenancyWarn++; continue;
      }
      if (!propId) {
        console.warn(`  WARN tenancy: property not found "${propName}" for tenant "${tenantName}"`);
        tenancyWarn++; continue;
      }

      // Unit lookup: try unit_number first, fall back to unit_name
      let unitId = unitKeyByNum[`${propId}_${unitNum}`]
                || unitKeyByName[`${propId}_${unitName}`];

      if (!unitId) {
        console.warn(`  WARN tenancy: unit not found prop="${propName}" num="${unitNum}" name="${unitName}" tenant="${tenantName}"`);
        tenancyWarn++; continue;
      }

      insertTenancy.run(tenantId, unitId,
        toDateStr(r['Lease Start']), toDateStr(r['Lease End']),
        r['Current'] === 1 || r['Current'] === true ? 1 : 0);
      tenancyOk++;
    }
    console.log(`✓ Tenancies inserted: ${tenancyOk}${tenancyWarn ? `  (${tenancyWarn} warnings)` : ''}`);

    // ── Phase 5: Payments + Allocations ──────────────────────────────
    const insertPayment = db.prepare(`
      INSERT INTO payments (sub_property_id, tenant_id, total_amount, payment_method,
        bank_name, cheque_number, receipt_number, notes, payment_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `);
    const insertAlloc = db.prepare(`
      INSERT INTO payment_allocations (payment_id, sub_property_id, month, amount_allocated, status)
      VALUES (?, ?, ?, ?, 'paid')
    `);

    // Payment methods are tenant-configurable — match the sheet's Method column
    // against the configured codes and labels, falling back to 'cash'.
    const methodRows = db.prepare(`SELECT code, label_en, label_ar FROM payment_methods`).all();
    const methodLookup = {};
    for (const m of methodRows) {
      methodLookup[m.code.toLowerCase()] = m.code;
      if (m.label_en) methodLookup[m.label_en.toLowerCase()] = m.code;
      if (m.label_ar) methodLookup[m.label_ar.toLowerCase()] = m.code;
    }
    const resolveMethod = (raw) => {
      const key = str(raw).trim().toLowerCase();
      if (!key) return 'cash';
      const hit = methodLookup[key];
      if (hit) return hit;
      console.warn(`  WARN unknown payment method "${raw}" — defaulting to cash`);
      return 'cash';
    };
    let payOk = 0, payWarn = 0;
    for (const r of paymentRows) {
      const tenantName = str(r['Tenant']);
      const propName   = str(r['Property']);
      const unitNum    = str(r['Unit']);

      const tenantId = tenantNameToId[tenantName];
      const propId   = propNameToId[propName];
      let unitId     = propId ? (unitKeyByNum[`${propId}_${unitNum}`] || unitKeyByName[`${propId}_${unitNum}`]) : null;

      if (!tenantId || !unitId) {
        console.warn(`  WARN payment receipt#${r['Receipt #']}: tenant="${tenantName}" prop="${propName}" unit="${unitNum}" — not matched`);
        payWarn++; continue;
      }

      const amount     = Number(r['Amount (BD)']) || 0;
      const method     = resolveMethod(r['Method']);
      const receiptNum = Number(r['Receipt #']);
      const payDate    = toDateStr(r['Payment Date']);

      const info = insertPayment.run(unitId, tenantId, amount, method,
        str(r['Bank']), str(r['Cheque #']), receiptNum, str(r['Notes']), payDate);

      const month = payDate ? payDate.slice(0, 7) : null;
      if (month) insertAlloc.run(info.lastInsertRowid, unitId, month, amount);

      payOk++;
    }
    console.log(`✓ Payments inserted: ${payOk}${payWarn ? `  (${payWarn} warnings)` : ''}`);

    // ── Phase 6: Update next_receipt_number in settings ──────────────
    const maxReceipt = db.prepare('SELECT MAX(receipt_number) as mx FROM payments').get();
    if (maxReceipt && maxReceipt.mx) {
      db.prepare('UPDATE settings SET next_receipt_number = ?').run(maxReceipt.mx + 1);
      console.log(`✓ Settings updated: next_receipt_number = ${maxReceipt.mx + 1}`);
    }

  })();  // end transaction

  console.log('\nImport complete.\n');

  // Final count verification
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM properties)         AS properties,
      (SELECT COUNT(*) FROM sub_properties)     AS units,
      (SELECT COUNT(*) FROM tenants)            AS tenants,
      (SELECT COUNT(*) FROM tenant_units)       AS tenancies,
      (SELECT COUNT(*) FROM payments)           AS payments,
      (SELECT COUNT(*) FROM payment_allocations) AS allocations
  `).get();
  console.log('Database counts:');
  console.log(`  Properties  : ${counts.properties}`);
  console.log(`  Units       : ${counts.units}`);
  console.log(`  Tenants     : ${counts.tenants}`);
  console.log(`  Tenancies   : ${counts.tenancies}`);
  console.log(`  Payments    : ${counts.payments}`);
  console.log(`  Allocations : ${counts.allocations}\n`);
}

// ────────────────────────────────────────────────
// Dry-run preview
// ────────────────────────────────────────────────

function previewWarnings(propRows, unitRows, tenantRows, tenancyRows, paymentRows) {
  console.log('\nPreview:');
  console.log(`  Will insert ${propRows.length} properties`);
  console.log(`  Will insert ${unitRows.length} units`);
  console.log(`  Will insert ${tenantRows.length} tenants`);
  console.log(`  Will insert up to ${tenancyRows.length} tenancies`);
  console.log(`  Will insert up to ${paymentRows.length} payments`);

  // Build lookup maps to check for unmatched rows
  const propNameToId = {};
  propRows.forEach(r => { propNameToId[str(r['Name'])] = Number(r['ID']); });

  const unitKeyByNum  = {};
  const unitKeyByName = {};
  unitRows.forEach(r => {
    const propId = propNameToId[str(r['Property'])];
    if (!propId) return;
    if (str(r['Unit Number']))  unitKeyByNum[`${propId}_${str(r['Unit Number'])}`]  = Number(r['ID']);
    if (str(r['Unit Name']))    unitKeyByName[`${propId}_${str(r['Unit Name'])}`]   = Number(r['ID']);
  });

  const tenantNameToId = {};
  tenantRows.forEach(r => { tenantNameToId[str(r['Full Name'])] = Number(r['ID']); });

  let tenancyWarns = 0;
  for (const r of tenancyRows) {
    const propId   = propNameToId[str(r['Property'])];
    const tenantId = tenantNameToId[str(r['Tenant'])];
    const unitId   = propId
      ? (unitKeyByNum[`${propId}_${str(r['Unit Number'])}`] || unitKeyByName[`${propId}_${str(r['Unit Name'])}`])
      : null;
    if (!tenantId || !unitId) {
      console.warn(`  WARN tenancy: tenant="${str(r['Tenant'])}" prop="${str(r['Property'])}" unit="${str(r['Unit Number'])}" → not matched`);
      tenancyWarns++;
    }
  }
  if (tenancyWarns === 0) console.log('  All tenancies matched OK');

  let payWarns = 0;
  for (const r of paymentRows) {
    const propId   = propNameToId[str(r['Property'])];
    const tenantId = tenantNameToId[str(r['Tenant'])];
    const unitId   = propId
      ? (unitKeyByNum[`${propId}_${str(r['Unit'])}`] || unitKeyByName[`${propId}_${str(r['Unit'])}`])
      : null;
    if (!tenantId || !unitId) {
      console.warn(`  WARN payment receipt#${r['Receipt #']}: tenant="${str(r['Tenant'])}" unit="${str(r['Unit'])}" → not matched`);
      payWarns++;
    }
  }
  if (payWarns === 0) console.log('  All payments matched OK');
}

main().catch(err => { console.error('\nFATAL:', err.message); process.exit(1); });
