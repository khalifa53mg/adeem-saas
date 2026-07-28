const fs = require('fs');

// Fixed badge palette — admin picks one per method (see .badge-pm-* in public/css/style.css)
const BADGE_COLORS = ['green', 'blue', 'cyan', 'amber', 'purple', 'teal', 'gray'];

// Seeded into every tenant DB. Mirrors the four methods that used to be hardcoded.
const DEFAULT_METHODS = [
  { code: 'cash',     label_en: 'Cash',     label_ar: 'نقداً', requires_bank_details: 0, badge_color: 'green', sort_order: 1 },
  { code: 'cheque',   label_en: 'Cheque',   label_ar: 'شيك',   requires_bank_details: 1, badge_color: 'blue',  sort_order: 2 },
  { code: 'transfer', label_en: 'Transfer', label_ar: 'تحويل', requires_bank_details: 0, badge_color: 'cyan',  sort_order: 3 },
  { code: 'card',     label_en: 'Card',     label_ar: 'بطاقة', requires_bank_details: 0, badge_color: 'amber', sort_order: 4 }
];

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS payment_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    label_en TEXT NOT NULL,
    label_ar TEXT NOT NULL DEFAULT '',
    requires_bank_details INTEGER NOT NULL DEFAULT 0,
    badge_color TEXT NOT NULL DEFAULT 'gray',
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

// payments table without the old CHECK(payment_method IN (...)) constraint.
// Column list and order must match the legacy table exactly — INSERT ... SELECT * relies on it.
const PAYMENTS_TABLE_SQL = (name) => `
  CREATE TABLE ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sub_property_id INTEGER NOT NULL REFERENCES sub_properties(id),
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    total_amount REAL NOT NULL,
    payment_method TEXT NOT NULL,
    bank_name TEXT DEFAULT '',
    cheque_number TEXT DEFAULT '',
    cheque_date DATE,
    receipt_number INTEGER NOT NULL,
    notes TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    payment_date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

/**
 * Creates + seeds payment_methods, and rebuilds `payments` to drop the legacy
 * CHECK(payment_method IN (...)) constraint so custom codes can be stored.
 * Idempotent — safe to call on every DB open.
 *
 * @param {Database} db        better-sqlite3 handle
 * @param {string}  [dbPath]   on-disk path, used to write a pre-migration backup
 */
function ensurePaymentMethods(db, dbPath) {
  db.exec(CREATE_TABLE_SQL);

  const seed = db.prepare(`
    INSERT OR IGNORE INTO payment_methods
      (code, label_en, label_ar, requires_bank_details, badge_color, is_active, sort_order, is_builtin)
    VALUES (?, ?, ?, ?, ?, 1, ?, 1)
  `);
  for (const m of DEFAULT_METHODS) {
    seed.run(m.code, m.label_en, m.label_ar, m.requires_bank_details, m.badge_color, m.sort_order);
  }

  const paymentsTable = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'`
  ).get();
  if (!paymentsTable || !paymentsTable.sql.includes('CHECK(payment_method')) return;

  // Back up before the only destructive step in this migration. WAL must be
  // checkpointed first or the copy can miss committed pages.
  if (dbPath && fs.existsSync(dbPath)) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(dbPath, `${dbPath}.pre-pm-${Date.now()}.bak`);
    } catch (e) {
      console.error(`payment_methods migration: backup failed for ${dbPath} — skipping rebuild:`, e.message);
      return;
    }
  }

  const before = db.prepare('SELECT COUNT(*) AS c FROM payments').get().c;

  // payment_allocations references payments(id); enforcement must be off for the
  // drop/rename. SQLite ignores this pragma inside a transaction, so it goes outside.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(PAYMENTS_TABLE_SQL('payments_mig'));
      db.exec('INSERT INTO payments_mig SELECT * FROM payments');
      const after = db.prepare('SELECT COUNT(*) AS c FROM payments_mig').get().c;
      if (after !== before) {
        throw new Error(`payments row count mismatch (${before} → ${after}) — rolling back`);
      }
      db.exec('DROP TABLE payments');
      db.exec('ALTER TABLE payments_mig RENAME TO payments');
      db.exec('CREATE INDEX IF NOT EXISTS idx_payments_unit ON payments(sub_property_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id)');
    })();

    const violations = db.pragma('foreign_key_check');
    if (violations.length) {
      console.error(`payment_methods migration: ${violations.length} FK violation(s) after rebuild of ${dbPath || 'db'}`);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function getActiveMethods(db) {
  return db.prepare(
    `SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`
  ).all();
}

function getAllMethods(db) {
  return db.prepare(
    `SELECT * FROM payment_methods ORDER BY sort_order ASC, id ASC`
  ).all();
}

function getMethodMap(db) {
  const map = {};
  for (const m of db.prepare(`SELECT * FROM payment_methods`).all()) map[m.code] = m;
  return map;
}

function findMethod(db, code) {
  if (!code) return null;
  return db.prepare(`SELECT * FROM payment_methods WHERE code = ?`).get(String(code)) || null;
}

/**
 * Methods to offer on a payment form. Active ones, plus the payment's current
 * method when it has since been deactivated — so editing an old receipt doesn't
 * silently change how it was paid.
 */
function getFormMethods(db, currentCode) {
  const methods = getActiveMethods(db);
  if (currentCode && !methods.some(m => m.code === currentCode)) {
    const current = findMethod(db, currentCode);
    if (current) methods.push(current);
  }
  return methods;
}

/**
 * Display label for a method. `row` may be undefined when a payment references a
 * method that was deleted from an older DB — then fall back to the raw code.
 */
function methodLabel(row, isAr, fallbackCode) {
  if (row) return (isAr && row.label_ar) ? row.label_ar : row.label_en;
  const code = fallbackCode || '';
  return code ? code.charAt(0).toUpperCase() + code.slice(1) : '';
}

/** { code: 1|0 } — drives the bank/cheque field toggle in the payment forms. */
function bankDetailFlags(methods) {
  const flags = {};
  for (const m of methods) flags[m.code] = m.requires_bank_details ? 1 : 0;
  return flags;
}

module.exports = {
  BADGE_COLORS, DEFAULT_METHODS,
  ensurePaymentMethods,
  getActiveMethods, getAllMethods, getMethodMap, getFormMethods, findMethod,
  methodLabel, bankDetailFlags
};
