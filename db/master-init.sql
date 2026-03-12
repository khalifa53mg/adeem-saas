PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS tenants (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name     TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  admin_email      TEXT NOT NULL UNIQUE,
  admin_name       TEXT NOT NULL,
  mobile           TEXT NOT NULL,
  country          TEXT NOT NULL CHECK(country IN ('Bahrain','Qatar','Oman','Kuwait')),
  currency_code    TEXT NOT NULL CHECK(currency_code IN ('BHD','QAR','OMR','KWD')),
  currency_label   TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'trial'
                     CHECK(status IN ('trial','active','suspended')),
  trial_expires_at DATETIME NOT NULL DEFAULT (datetime('now', '+14 days')),
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);

CREATE TABLE IF NOT EXISTS super_admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
