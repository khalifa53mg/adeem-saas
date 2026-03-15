const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

function initTenantDb(db, { adminName, adminEmail, adminPassword, currencyLabel, companyName }) {
  // Run init.sql schema
  const sql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');
  db.exec(sql);

  // Add logo_path column if not present (safe migration)
  try { db.exec(`ALTER TABLE settings ADD COLUMN logo_path TEXT DEFAULT ''`); } catch (_) {}

  // Ensure UNIQUE constraint on payment_allocations
  const paTable = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_allocations'`).get();
  if (paTable && !paTable.sql.includes('UNIQUE')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE payment_allocations_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          payment_id INTEGER NOT NULL REFERENCES payments(id),
          sub_property_id INTEGER NOT NULL REFERENCES sub_properties(id),
          month TEXT NOT NULL,
          amount_allocated REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('paid','partial','unpaid')),
          UNIQUE(sub_property_id, month)
        )
      `);
      db.exec(`INSERT OR IGNORE INTO payment_allocations_new SELECT * FROM payment_allocations ORDER BY id ASC`);
      db.exec(`DROP TABLE payment_allocations`);
      db.exec(`ALTER TABLE payment_allocations_new RENAME TO payment_allocations`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_alloc_payment ON payment_allocations(payment_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_alloc_unit_month ON payment_allocations(sub_property_id, month)`);
    })();
  }

  // Migration: remove UNIQUE(sub_property_id, month) to allow partial top-ups
  const paTable2 = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_allocations'`).get();
  if (paTable2 && paTable2.sql.includes('UNIQUE')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE payment_allocations_new2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          payment_id INTEGER NOT NULL REFERENCES payments(id),
          sub_property_id INTEGER NOT NULL REFERENCES sub_properties(id),
          month TEXT NOT NULL,
          amount_allocated REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('paid','partial','unpaid'))
        )
      `);
      db.exec(`INSERT INTO payment_allocations_new2 SELECT * FROM payment_allocations`);
      db.exec(`DROP TABLE payment_allocations`);
      db.exec(`ALTER TABLE payment_allocations_new2 RENAME TO payment_allocations`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_alloc_payment ON payment_allocations(payment_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_alloc_unit_month ON payment_allocations(sub_property_id, month)`);
    })();
  }

  // Seed default settings if not exists
  const settings = db.prepare('SELECT id FROM settings LIMIT 1').get();
  if (!settings) {
    db.prepare(`
      INSERT INTO settings (owner_name, currency_label, receipt_footer_note, next_receipt_number)
      VALUES (?, ?, ?, ?)
    `).run(companyName || 'My Company', currencyLabel || 'Bahraini Dinar', 'Cheques subject to realisation.', 1);
  } else {
    // Update currency label from registration
    db.prepare(`UPDATE settings SET currency_label = ?, owner_name = ?`)
      .run(currencyLabel || 'Bahraini Dinar', companyName || 'My Company');
  }

  // Create admin user
  const existingAdmin = db.prepare("SELECT COUNT(*) as count FROM users WHERE username = 'admin'").get();
  if (existingAdmin.count === 0) {
    const hash = bcrypt.hashSync(adminPassword, 10);
    db.prepare(`INSERT INTO users (name, username, password_hash, role, status) VALUES (?, ?, ?, 'admin', 'active')`)
      .run(adminName, 'admin', hash);
  }
}

module.exports = { initTenantDb };
