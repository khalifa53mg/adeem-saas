const Database = require('better-sqlite3');
const path = require('path');

const dbCache = new Map();

function getTenantDb(slug) {
  if (dbCache.has(slug)) return dbCache.get(slug);
  const dbPath = path.join(__dirname, 'tenants', slug, 'adeem.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
