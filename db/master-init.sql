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

CREATE TABLE IF NOT EXISTS support_tickets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  tenant_slug   TEXT NOT NULL,
  company_name  TEXT NOT NULL,
  submitted_by  TEXT NOT NULL,
  subject       TEXT NOT NULL,
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK(status IN ('open','in_progress','resolved','closed')),
  priority      TEXT NOT NULL DEFAULT 'normal'
                  CHECK(priority IN ('low','normal','high','urgent')),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant ON support_tickets(tenant_slug);

CREATE TABLE IF NOT EXISTS support_ticket_replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL CHECK(author_role IN ('tenant','superadmin')),
  message     TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
