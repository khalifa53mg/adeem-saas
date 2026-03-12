const bcrypt = require('bcryptjs');
const { initMasterDb, getMasterDb } = require('./db/masterDb');

initMasterDb();
const db = getMasterDb();

const username = 'superadmin';
const password = 'SuperAdmin123!';
const hash = bcrypt.hashSync(password, 10);

const existing = db.prepare('SELECT id FROM super_admins WHERE username = ?').get(username);
if (existing) {
  db.prepare('UPDATE super_admins SET password_hash = ? WHERE username = ?').run(hash, username);
  console.log('Updated superadmin password');
} else {
  db.prepare('INSERT INTO super_admins (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log('Created superadmin user');
}
console.log('Username:', username, '| Password:', password);
