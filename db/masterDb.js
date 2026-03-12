const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'master.db');
let masterDb;

function getMasterDb() {
  if (masterDb) return masterDb;
  masterDb = new Database(DB_PATH);
  masterDb.pragma('journal_mode = WAL');
  masterDb.pragma('foreign_keys = ON');
  return masterDb;
}

function initMasterDb() {
  const db = getMasterDb();
  const sql = fs.readFileSync(path.join(__dirname, 'master-init.sql'), 'utf8');
  db.exec(sql);
  return db;
}

module.exports = { getMasterDb, initMasterDb };
