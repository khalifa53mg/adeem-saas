-- ============================================================
-- ADEEM REAL ESTATE — DATABASE SCHEMA
-- ============================================================

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ============================================================
-- SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_name TEXT NOT NULL DEFAULT 'Adeem Real Estate',
  tel TEXT DEFAULT '',
  fax TEXT DEFAULT '',
  po_box TEXT DEFAULT '',
  address TEXT DEFAULT '',
  currency_label TEXT NOT NULL DEFAULT 'Bahrain Dinars',
  receipt_footer_note TEXT DEFAULT 'Cheques subject to realisation.',
  next_receipt_number INTEGER NOT NULL DEFAULT 1,
  logo_path TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add logo_path column if upgrading from older schema
CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY);
INSERT OR IGNORE INTO _migrations (key) VALUES ('add_logo_path');


-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','cashier','reporter')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  last_login DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- PROPERTIES
-- ============================================================
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  location TEXT DEFAULT '',
  address TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked')),
  is_archived INTEGER NOT NULL DEFAULT 0,
  archived_at DATETIME,
  archived_by INTEGER REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- SUB-PROPERTIES (UNITS)
-- ============================================================
CREATE TABLE IF NOT EXISTS sub_properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  unit_number TEXT DEFAULT '',
  address TEXT DEFAULT '',
  monthly_rent_bhd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','rented','blocked')),
  is_archived INTEGER NOT NULL DEFAULT 0,
  archived_at DATETIME,
  archived_by INTEGER REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- TENANTS
-- ============================================================
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  tel TEXT DEFAULT '',
  fax TEXT DEFAULT '',
  po_box TEXT DEFAULT '',
  address TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','past')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- TENANT → UNIT HISTORY
-- ============================================================
CREATE TABLE IF NOT EXISTS tenant_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  sub_property_id INTEGER NOT NULL REFERENCES sub_properties(id),
  lease_start DATE NOT NULL,
  lease_end DATE,
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_property_id INTEGER NOT NULL REFERENCES sub_properties(id),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  total_amount REAL NOT NULL,
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','card','transfer','cheque')),
  bank_name TEXT DEFAULT '',
  cheque_number TEXT DEFAULT '',
  cheque_date DATE,
  receipt_number INTEGER NOT NULL,
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  payment_date DATE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- PAYMENT ALLOCATIONS (per month)
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  sub_property_id INTEGER NOT NULL REFERENCES sub_properties(id),
  month TEXT NOT NULL,  -- YYYY-MM
  amount_allocated REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('paid','partial','unpaid'))
);

-- ============================================================
-- AUDIT LOG (INSERT ONLY — never update or delete)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',  -- JSON string
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- UNIT GROUPS (merged virtual units)
-- ============================================================
CREATE TABLE IF NOT EXISTS unit_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  virtual_sub_property_id INTEGER NOT NULL REFERENCES sub_properties(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Members of each merge group
CREATE TABLE IF NOT EXISTS unit_group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES unit_groups(id),
  sub_property_id INTEGER NOT NULL REFERENCES sub_properties(id),
  UNIQUE(sub_property_id)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_sub_properties_property ON sub_properties(property_id);
CREATE INDEX IF NOT EXISTS idx_tenant_units_tenant ON tenant_units(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_units_unit ON tenant_units(sub_property_id);
CREATE INDEX IF NOT EXISTS idx_payments_unit ON payments(sub_property_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_alloc_unit_month ON payment_allocations(sub_property_id, month);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
