const Database = require('better-sqlite3');
const path = require('path');

const dbCache = new Map();

function getTenantDb(slug) {
  if (dbCache.has(slug)) return dbCache.get(slug);
  const dbPath = path.join(__dirname, 'tenants', slug, 'adeem.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Migration: remove UNIQUE(sub_property_id, month) from payment_allocations to allow partial top-ups
  const paTable = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_allocations'`).get();
  if (paTable && paTable.sql.includes('UNIQUE')) {
    db.transaction(() => {
      db.exec(`CREATE TABLE payment_allocations_mig (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER NOT NULL REFERENCES payments(id),
        sub_property_id INTEGER NOT NULL REFERENCES sub_properties(id),
        month TEXT NOT NULL,
        amount_allocated REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('paid','partial','unpaid'))
      )`);
      db.exec(`INSERT INTO payment_allocations_mig SELECT * FROM payment_allocations`);
      db.exec(`DROP TABLE payment_allocations`);
      db.exec(`ALTER TABLE payment_allocations_mig RENAME TO payment_allocations`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_alloc_payment ON payment_allocations(payment_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_alloc_unit_month ON payment_allocations(sub_property_id, month)`);
    })();
  }
  dbCache.set(slug, db);
  return db;
}

function makeAuditLog(db) {
  return function auditLog(userId, userName, action, details = {}) {
    try {
      db.prepare('INSERT INTO audit_log (user_id, user_name, action, details) VALUES (?, ?, ?, ?)')
        .run(userId, userName, action, JSON.stringify(details));
    } catch (e) {
      console.error('Audit log error:', e.message);
    }
  };
}

function removeTenantDb(slug) {
  if (dbCache.has(slug)) {
    dbCache.get(slug).close();
    dbCache.delete(slug);
  }
}

module.exports = { getTenantDb, makeAuditLog, removeTenantDb };
