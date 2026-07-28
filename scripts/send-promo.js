#!/usr/bin/env node
/**
 * send-promo.js
 * Sends the 25% discount promo email.
 *
 * Usage:
 *   node scripts/send-promo.js --test          → sends only to khalifa1002@gmail.com
 *   node scripts/send-promo.js --all           → sends to all trial + active tenants
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getMasterDb }    = require('../db/masterDb');
const { sendPromoEmail } = require('../middleware/mailer');

const mode = process.argv[2] || '--test';

async function main() {
  const db = getMasterDb();

  let recipients;

  if (mode === '--test') {
    recipients = [{ admin_email: 'khalifa1002@gmail.com', admin_name: 'Khalifa', company_name: 'Adeem Test' }];
    console.log('MODE: test — sending to khalifa1002@gmail.com only');
  } else if (mode === '--all') {
    recipients = db.prepare(
      `SELECT admin_email, admin_name, company_name
       FROM tenants
       WHERE status IN ('trial','active') AND admin_email IS NOT NULL AND admin_email != ''`
    ).all();
    console.log(`MODE: all — ${recipients.length} tenant(s) found`);
  } else {
    console.error('Unknown flag. Use --test or --all');
    process.exit(1);
  }

  let ok = 0, fail = 0;
  for (const r of recipients) {
    try {
      await sendPromoEmail({ to: r.admin_email, adminName: r.admin_name, companyName: r.company_name });
      console.log(`  ✓  ${r.admin_email} (${r.company_name})`);
      ok++;
    } catch (err) {
      console.error(`  ✗  ${r.admin_email} — ${err.message}`);
      fail++;
    }
    // small delay to avoid SMTP rate limits
    await new Promise(res => setTimeout(res, 500));
  }

  console.log(`\nDone: ${ok} sent, ${fail} failed`);
}

main().catch(err => { console.error(err); process.exit(1); });
