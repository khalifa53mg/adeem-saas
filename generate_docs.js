/**
 * generate_docs.js
 * Bilingual (English + Arabic) user guide PDF generator for Adeem SaaS
 *
 * Usage:
 *   node generate_docs.js
 *   node generate_docs.js --slug lazada-homes --username admin --password mypassword
 *
 * If --password is omitted, the script creates a temporary admin user
 * for the screenshot session, then deletes it when done.
 */

'use strict';

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
const BASE_URL = `http://localhost:${PORT}`;
const MASTER_DB_PATH = path.join(__dirname, 'db', 'master.db');
const OUTPUT_PATH = path.join(__dirname, 'adeem_user_guide.pdf');
const TEMP_PASSWORD = 'docgen123';

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
};
const CLI_SLUG = getArg('slug');
const CLI_USERNAME = getArg('username');
const CLI_PASSWORD = getArg('password');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function isAppRunning() {
  try {
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get(`${BASE_URL}/login`, (res) => { resolve(true); req.destroy(); });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
  } catch { return false; }
}

function toBase64(buffer) {
  return buffer.toString('base64');
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
function getTenantInfo(slug) {
  const masterDb = new Database(MASTER_DB_PATH, { readonly: true });
  let tenant;
  if (slug) {
    tenant = masterDb.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  } else {
    tenant = masterDb.prepare("SELECT * FROM tenants WHERE status IN ('trial','active') ORDER BY id LIMIT 1").get();
  }
  masterDb.close();
  if (!tenant) throw new Error('No tenant found in master DB');
  return tenant;
}

function getTenantDbPath(slug) {
  return path.join(__dirname, 'db', 'tenants', slug, 'adeem.db');
}

function getAdminUser(tenantDbPath, username) {
  const db = new Database(tenantDbPath, { readonly: true });
  const user = username
    ? db.prepare("SELECT * FROM users WHERE username = ? AND status = 'active'").get(username)
    : db.prepare("SELECT * FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1").get();
  db.close();
  if (!user) throw new Error('No admin user found in tenant DB');
  return user;
}

const TEMP_USERNAME = '_docgen_tmp';

function createTempUser(tenantDbPath, password) {
  const db = new Database(tenantDbPath);
  // Remove stale temp user if any (clear FK-referenced audit_log rows first)
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(TEMP_USERNAME);
  if (existing) {
    try { db.prepare("DELETE FROM audit_log WHERE user_id = ?").run(existing.id); } catch {}
    db.prepare("DELETE FROM users WHERE id = ?").run(existing.id);
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    "INSERT INTO users (name, username, password_hash, role, status) VALUES (?, ?, ?, 'admin', 'active')"
  ).run('Docgen Temp', TEMP_USERNAME, hash);
  db.close();
  return info.lastInsertRowid;
}

function deleteTempUser(tenantDbPath) {
  const db = new Database(tenantDbPath);
  // Find and delete audit log entries for the temp user first
  const user = db.prepare("SELECT id FROM users WHERE username = ?").get(TEMP_USERNAME);
  if (user) {
    try { db.prepare("DELETE FROM audit_log WHERE user_id = ?").run(user.id); } catch {}
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  }
  db.close();
}

// ─── Screenshots ──────────────────────────────────────────────────────────────
async function screenshot(page, url, waitForSel, opts = {}) {
  console.log(`  📸 ${url}`);
  await page.goto(`${BASE_URL}${url}`, { waitUntil: 'networkidle2', timeout: 30000 });
  if (waitForSel) {
    try { await page.waitForSelector(waitForSel, { timeout: 8000 }); } catch {}
  }
  if (opts.action) await opts.action(page);
  await sleep(600);
  return page.screenshot({ fullPage: true, type: 'png' });
}

// ─── HTML Builder ────────────────────────────────────────────────────────────
function buildHtml(sections) {
  const tocEnRows = sections.map((s, i) =>
    `<tr><td style="padding:4px 12px;color:#555;">${i + 1}</td><td style="padding:4px 12px;">${s.titleEn}</td></tr>`
  ).join('');
  const tocArRows = sections.map((s, i) =>
    `<tr><td style="padding:4px 12px;color:#555;">${i + 1}</td><td style="padding:4px 12px;">${s.titleAr}</td></tr>`
  ).join('');

  const sectionHtml = sections.map((s, idx) => {
    const screenshotImgs = s.screenshots.map((buf, si) => {
      if (!buf) return '';
      const b64 = toBase64(buf);
      return `<div style="margin:16px 0;text-align:center;">
        <img src="data:image/png;base64,${b64}"
             style="max-width:100%;border:1px solid #ddd;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.1);"
             alt="Screenshot ${si + 1}" />
      </div>`;
    }).join('');

    const stepsEnHtml = s.stepsEn.map((step, i) =>
      `<li style="margin-bottom:8px;">${step}</li>`
    ).join('');

    const stepsArHtml = s.stepsAr.map((step, i) =>
      `<li style="margin-bottom:8px;">${step}</li>`
    ).join('');

    return `
    <!-- ===== SECTION ${idx + 1} ===== -->
    <div style="page-break-before: always; padding: 12px 0;">

      <!-- English -->
      <div dir="ltr" lang="en" style="font-family:'Inter',sans-serif;">
        <div style="background:#1a56db;color:#fff;padding:18px 24px;border-radius:8px 8px 0 0;">
          <span style="font-size:13px;opacity:.8;letter-spacing:.5px;">SECTION ${idx + 1}</span>
          <h2 style="margin:4px 0 0;font-size:22px;">${s.titleEn}</h2>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px;">
          <p style="color:#374151;line-height:1.7;margin-bottom:16px;">${s.descEn}</p>
          <ol style="color:#374151;line-height:1.8;padding-left:20px;">
            ${stepsEnHtml}
          </ol>
          ${screenshotImgs}
        </div>
      </div>

      <!-- Arabic -->
      <div dir="rtl" lang="ar" style="font-family:'Cairo',sans-serif;margin-top:24px;">
        <div style="background:#1e40af;color:#fff;padding:18px 24px;border-radius:8px 8px 0 0;">
          <span style="font-size:13px;opacity:.8;letter-spacing:.5px;">القسم ${idx + 1}</span>
          <h2 style="margin:4px 0 0;font-size:22px;">${s.titleAr}</h2>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px;">
          <p style="color:#374151;line-height:1.9;margin-bottom:16px;">${s.descAr}</p>
          <ol style="color:#374151;line-height:2;padding-right:20px;">
            ${stepsArHtml}
          </ol>
        </div>
      </div>

    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #fff; color: #111; font-size: 14px; }
  @page { margin: 15mm; }
</style>
</head>
<body>

<!-- ===== COVER PAGE ===== -->
<div style="page-break-after:always;min-height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;background:linear-gradient(135deg,#1a56db 0%,#1e3a8a 100%);color:#fff;padding:60px 40px;text-align:center;">
  <div style="font-size:72px;margin-bottom:24px;">🏢</div>
  <h1 style="font-family:'Inter',sans-serif;font-size:36px;font-weight:700;margin-bottom:12px;">Adeem Real Estate</h1>
  <p style="font-family:'Inter',sans-serif;font-size:18px;opacity:.85;margin-bottom:8px;">Property Management System — User Guide</p>
  <p style="font-family:'Cairo',sans-serif;font-size:18px;opacity:.85;margin-bottom:40px;">نظام إدارة العقارات — دليل المستخدم</p>
  <div style="width:60px;height:3px;background:rgba(255,255,255,.5);border-radius:2px;margin-bottom:40px;"></div>
  <p style="font-family:'Inter',sans-serif;font-size:13px;opacity:.6;">Generated ${new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
</div>

<!-- ===== TABLE OF CONTENTS ===== -->
<div style="page-break-after:always;padding:40px;">

  <!-- EN ToC -->
  <div dir="ltr" lang="en" style="font-family:'Inter',sans-serif;margin-bottom:48px;">
    <h2 style="font-size:24px;font-weight:700;color:#1a56db;border-bottom:2px solid #1a56db;padding-bottom:8px;margin-bottom:20px;">Table of Contents</h2>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#374151;width:40px;">#</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#374151;">Section</th>
        </tr>
      </thead>
      <tbody>${tocEnRows}</tbody>
    </table>
  </div>

  <!-- AR ToC -->
  <div dir="rtl" lang="ar" style="font-family:'Cairo',sans-serif;">
    <h2 style="font-size:24px;font-weight:700;color:#1e40af;border-bottom:2px solid #1e40af;padding-bottom:8px;margin-bottom:20px;">جدول المحتويات</h2>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px 12px;text-align:right;font-weight:600;color:#374151;width:40px;">#</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600;color:#374151;">القسم</th>
        </tr>
      </thead>
      <tbody>${tocArRows}</tbody>
    </table>
  </div>

</div>

${sectionHtml}

</body>
</html>`;
}

// ─── Section Definitions ─────────────────────────────────────────────────────
function buildSections(screenshots) {
  const [
    ssDashboard,
    ssProperties, ssPropertyNew,
    ssUnitNew,
    ssTenants, ssTenantNew,
    ssUnitShow,
    ssPaymentNew, ssPaymentShow,
    ssCalendar,
  ] = screenshots;

  return [
    {
      titleEn: 'Dashboard Overview',
      titleAr: 'نظرة عامة على لوحة التحكم',
      descEn: 'The Dashboard provides a real-time summary of your portfolio: properties, units, tenants, outstanding balances, and recent payments. It is the first screen you see after logging in.',
      descAr: 'توفر لوحة التحكم ملخصاً فورياً للمحفظة العقارية: العقارات والوحدات والمستأجرين والأرصدة المستحقة والمدفوعات الأخيرة. وهي أول شاشة تظهر بعد تسجيل الدخول.',
      stepsEn: [
        'Navigate to <strong>Reports</strong> in the left sidebar (or go to <code>/reports</code>).',
        'View the summary cards: Total Properties, Units, Tenants, and Payments this month.',
        'Use the top action buttons to switch between Calendar, Income, Rent Roll, and Outstanding views.',
        'Click any stat card to drill down into the corresponding list.',
      ],
      stepsAr: [
        'انتقل إلى <strong>التقارير</strong> في الشريط الجانبي الأيسر (أو اذهب إلى <code>/reports</code>).',
        'اطلع على بطاقات الملخص: إجمالي العقارات والوحدات والمستأجرين والمدفوعات هذا الشهر.',
        'استخدم أزرار الإجراءات العلوية للتبديل بين عروض التقويم والدخل وسجل الإيجار والمتأخرات.',
        'انقر على أي بطاقة إحصاء للانتقال إلى القائمة المقابلة.',
      ],
      screenshots: [ssDashboard],
    },
    {
      titleEn: 'Creating a Property',
      titleAr: 'إنشاء عقار',
      descEn: 'Properties are the top-level containers for your units. Each property has a name, address, type, and optional details. You can add multiple properties and manage them independently.',
      descAr: 'العقارات هي الحاويات الرئيسية للوحدات. يحتوي كل عقار على اسم وعنوان ونوع وتفاصيل اختيارية. يمكنك إضافة عقارات متعددة وإدارتها بشكل مستقل.',
      stepsEn: [
        'Click <strong>Properties</strong> in the left sidebar.',
        'Click the <strong>+ Add Property</strong> button in the top-right corner.',
        'Fill in the property details: Name, Type, Address, City.',
        'Click <strong>Save Property</strong> to create it.',
        'The new property will appear in the properties list immediately.',
      ],
      stepsAr: [
        'انقر على <strong>العقارات</strong> في الشريط الجانبي الأيسر.',
        'انقر على زر <strong>+ إضافة عقار</strong> في الزاوية العلوية اليمنى.',
        'أدخل تفاصيل العقار: الاسم والنوع والعنوان والمدينة.',
        'انقر على <strong>حفظ العقار</strong> لإنشائه.',
        'سيظهر العقار الجديد في قائمة العقارات فوراً.',
      ],
      screenshots: [ssProperties, ssPropertyNew],
    },
    {
      titleEn: 'Creating a Unit',
      titleAr: 'إنشاء وحدة',
      descEn: 'Units belong to a property and represent individual rentable spaces (apartments, offices, shops). Each unit has a unit number, floor, type, size, and monthly rent.',
      descAr: 'الوحدات تنتمي إلى عقار وتمثل المساحات القابلة للإيجار (شقق ومكاتب ومحلات). يحتوي كل وحدة على رقم وطابق ونوع ومساحة وإيجار شهري.',
      stepsEn: [
        'Open a property by clicking its name in the Properties list.',
        'Click the <strong>+ Add Unit</strong> button.',
        'Enter unit details: Unit Number, Floor, Type (apartment/office/shop/warehouse), Area (m²), Monthly Rent.',
        'Optionally add notes about the unit.',
        'Click <strong>Save Unit</strong>. The unit will appear in the property\'s unit list.',
      ],
      stepsAr: [
        'افتح عقاراً بالنقر على اسمه في قائمة العقارات.',
        'انقر على زر <strong>+ إضافة وحدة</strong>.',
        'أدخل تفاصيل الوحدة: رقم الوحدة والطابق والنوع (شقة/مكتب/محل/مستودع) والمساحة (م²) والإيجار الشهري.',
        'أضف ملاحظات عن الوحدة اختيارياً.',
        'انقر على <strong>حفظ الوحدة</strong>. ستظهر الوحدة في قائمة وحدات العقار.',
      ],
      screenshots: [ssUnitNew],
    },
    {
      titleEn: 'Creating a Tenant',
      titleAr: 'إنشاء مستأجر',
      descEn: 'Tenants are the people or businesses that rent your units. You can store their contact details, ID information, and track their payment history.',
      descAr: 'المستأجرون هم الأشخاص أو الشركات التي تستأجر وحداتك. يمكنك تخزين بيانات الاتصال الخاصة بهم ومعلومات الهوية وتتبع سجل مدفوعاتهم.',
      stepsEn: [
        'Click <strong>Tenants</strong> in the left sidebar.',
        'Click the <strong>+ Add Tenant</strong> button.',
        'Fill in the tenant\'s details: Full Name, Phone, Email (optional), National ID (optional).',
        'Click <strong>Save Tenant</strong>.',
        'The tenant is now in the system and can be assigned to a unit.',
      ],
      stepsAr: [
        'انقر على <strong>المستأجرون</strong> في الشريط الجانبي الأيسر.',
        'انقر على زر <strong>+ إضافة مستأجر</strong>.',
        'أدخل تفاصيل المستأجر: الاسم الكامل والهاتف والبريد الإلكتروني (اختياري) والهوية الوطنية (اختياري).',
        'انقر على <strong>حفظ المستأجر</strong>.',
        'المستأجر الآن في النظام ويمكن تعيينه لوحدة.',
      ],
      screenshots: [ssTenants, ssTenantNew],
    },
    {
      titleEn: 'Assigning a Tenant to a Unit',
      titleAr: 'تعيين المستأجر للوحدة',
      descEn: 'Once a tenant and a unit exist, you can create a lease by assigning the tenant to the unit. This sets the lease start and end dates, monthly rent, and advance payment.',
      descAr: 'بعد إنشاء المستأجر والوحدة، يمكنك إنشاء عقد إيجار بتعيين المستأجر للوحدة. يحدد ذلك تاريخي بدء العقد ونهايته والإيجار الشهري ودفعة التأمين.',
      stepsEn: [
        'Navigate to the unit\'s detail page (Properties → Property → Unit).',
        'Click the <strong>Assign Tenant</strong> button.',
        'In the modal, select the tenant from the dropdown.',
        'Set the Lease Start Date and Lease End Date.',
        'Enter the monthly rent and optional advance/deposit amount.',
        'Click <strong>Assign</strong> to activate the lease.',
      ],
      stepsAr: [
        'انتقل إلى صفحة تفاصيل الوحدة (العقارات ← العقار ← الوحدة).',
        'انقر على زر <strong>تعيين مستأجر</strong>.',
        'في النافذة المنبثقة، اختر المستأجر من القائمة المنسدلة.',
        'حدد تاريخ بدء العقد وتاريخ انتهائه.',
        'أدخل الإيجار الشهري ومبلغ التأمين الاختياري.',
        'انقر على <strong>تعيين</strong> لتفعيل عقد الإيجار.',
      ],
      screenshots: [ssUnitShow],
    },
    {
      titleEn: 'Recording a Payment & Month Allocation',
      titleAr: 'تسجيل دفعة وتوزيع الأشهر',
      descEn: 'Payments are recorded against a tenant\'s lease. Each payment is allocated to one or more rent months. The system supports partial payments, top-ups, and multiple payment methods.',
      descAr: 'تُسجَّل المدفوعات مقابل عقد إيجار المستأجر. يُوزَّع كل دفعة على شهر أو أكثر من أشهر الإيجار. يدعم النظام المدفوعات الجزئية والتكميلية وطرق الدفع المتعددة.',
      stepsEn: [
        'Click <strong>Payments</strong> in the left sidebar.',
        'Click <strong>+ New Payment</strong>.',
        'Select the tenant and their active lease.',
        'Enter the payment amount and select the payment method (Cash, Cheque, Bank Transfer, etc.).',
        'In the month allocation grid, check the months this payment covers.',
        'For partial months, enter the partial amount instead of the full rent.',
        'Click <strong>Save Payment</strong> to record it.',
        'A receipt PDF can be downloaded from the payment detail page.',
      ],
      stepsAr: [
        'انقر على <strong>المدفوعات</strong> في الشريط الجانبي الأيسر.',
        'انقر على <strong>+ دفعة جديدة</strong>.',
        'اختر المستأجر وعقد الإيجار النشط الخاص به.',
        'أدخل مبلغ الدفعة واختر طريقة الدفع (نقداً أو شيك أو تحويل بنكي إلخ).',
        'في شبكة تخصيص الأشهر، ضع علامة على الأشهر التي تغطيها هذه الدفعة.',
        'للأشهر الجزئية، أدخل المبلغ الجزئي بدلاً من الإيجار الكامل.',
        'انقر على <strong>حفظ الدفعة</strong> لتسجيلها.',
        'يمكن تنزيل إيصال PDF من صفحة تفاصيل الدفعة.',
      ],
      screenshots: [ssPaymentNew, ssPaymentShow],
    },
    {
      titleEn: 'Calendar Overview',
      titleAr: 'نظرة عامة على التقويم',
      descEn: 'The Calendar view shows all lease events and payment due dates visually. You can quickly see which tenants have upcoming rent due, which leases are expiring, and filter by property.',
      descAr: 'يعرض عرض التقويم جميع أحداث عقود الإيجار وتواريخ استحقاق المدفوعات بشكل مرئي. يمكنك بسرعة معرفة المستأجرين الذين لديهم إيجارات مستحقة قادمة والعقود المنتهية وتصفيتها حسب العقار.',
      stepsEn: [
        'Navigate to <strong>Reports → Calendar</strong> or click the Calendar button on the Reports page.',
        'The calendar shows the current month with events for each day.',
        'Green events represent payments received; red/orange events indicate upcoming or overdue rent.',
        'Click on an event to see the details.',
        'Use the month navigation arrows to move forward or backward in time.',
      ],
      stepsAr: [
        'انتقل إلى <strong>التقارير ← التقويم</strong> أو انقر على زر التقويم في صفحة التقارير.',
        'يعرض التقويم الشهر الحالي مع الأحداث لكل يوم.',
        'الأحداث الخضراء تمثل المدفوعات المستلمة؛ الأحداث الحمراء/البرتقالية تشير إلى إيجارات قادمة أو متأخرة.',
        'انقر على حدث لعرض تفاصيله.',
        'استخدم أسهم التنقل بين الأشهر للتنقل للأمام أو للخلف في الوقت.',
      ],
      screenshots: [ssCalendar],
    },
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Adeem User Guide PDF Generator');
  console.log('===================================\n');

  // 1. Resolve tenant + user credentials
  console.log('📦 Step 1: Resolving credentials...');
  const tenant = getTenantInfo(CLI_SLUG);
  console.log(`  Tenant: ${tenant.company_name} (${tenant.slug})`);

  const tenantDbPath = getTenantDbPath(tenant.slug);
  if (!fs.existsSync(tenantDbPath)) {
    throw new Error(`Tenant DB not found at: ${tenantDbPath}`);
  }

  const adminUser = getAdminUser(tenantDbPath, CLI_USERNAME);
  console.log(`  Admin user: ${adminUser.username}`);

  let loginPassword = CLI_PASSWORD || TEMP_PASSWORD;
  let loginUsername = adminUser.username;
  let useTempUser = !CLI_PASSWORD;

  if (useTempUser) {
    console.log(`  No --password supplied. Creating temporary admin user "${TEMP_USERNAME}"...`);
    createTempUser(tenantDbPath, TEMP_PASSWORD);
    loginUsername = TEMP_USERNAME;
    loginPassword = TEMP_PASSWORD;
    console.log('  Temporary user created.');
  }

  // 2. Start app if not running
  let appProcess = null;
  console.log('\n🌐 Step 2: Checking if app is running...');
  const running = await isAppRunning();
  if (running) {
    console.log(`  App already running at ${BASE_URL}`);
  } else {
    console.log(`  Starting app on port ${PORT}...`);
    appProcess = spawn('node', ['app.js'], {
      cwd: __dirname,
      stdio: 'pipe',
      detached: false,
    });
    appProcess.stderr.on('data', (d) => process.stderr.write(d));
    await sleep(3000);
    const started = await isAppRunning();
    if (!started) throw new Error('Failed to start app. Check app.js for errors.');
    console.log('  App started successfully.');
  }

  // 3. Launch Puppeteer and take screenshots
  console.log('\n📷 Step 3: Launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const screenshots = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1.5 });

    // Login
    console.log('\n🔐 Logging in...');

    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle2' });

    // Fill form fields
    await page.waitForSelector('input[name="slug"]');
    await page.focus('input[name="slug"]');
    await page.keyboard.type(tenant.slug);
    await page.focus('input[name="username"]');
    await page.keyboard.type(loginUsername);
    await page.focus('input[name="password"]');
    await page.keyboard.type(loginPassword);

    console.log(`  Submitting login form (slug=${tenant.slug}, user=${loginUsername})...`);

    // Click the specific login submit button (not the language toggle button at top of page)
    const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
    // The login button is inside form[action="/login"]
    await page.click('form[action="/login"] button[type="submit"]');
    await navPromise;

    // Check if login succeeded
    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      const errText = await page.$eval('.alert-danger', el => el.textContent.trim()).catch(() => 'no error message visible');
      const pageTitle = await page.title().catch(() => 'unknown');
      throw new Error(`Login failed (title: ${pageTitle}): ${errText}`);
    }
    console.log(`  Logged in successfully.`);

    // ── Screenshots ─────────────────────────────────────────────────────
    console.log('\n📸 Taking screenshots...');

    // 1. Dashboard
    screenshots.push(await screenshot(page, '/reports', '.stat-card'));

    // 2. Properties list
    screenshots.push(await screenshot(page, '/properties', '.topbar-title'));
    // 3. New property form
    screenshots.push(await screenshot(page, '/properties/new', 'form'));

    // 4. New unit form (try any existing property's unit new, fallback to raw /units/new-style)
    screenshots.push(await screenshot(page, '/units/new', 'form').catch(async () => {
      // Some apps route unit creation through properties; take a properties screenshot as fallback
      return screenshot(page, '/properties', '.topbar-title');
    }));

    // 5. Tenants list
    screenshots.push(await screenshot(page, '/tenants', '.topbar-title'));
    // 6. New tenant form
    screenshots.push(await screenshot(page, '/tenants/new', 'form'));

    // 7. Unit show page (first unit if any)
    const unitScreenshot = await (async () => {
      try {
        await page.goto(`${BASE_URL}/properties`, { waitUntil: 'networkidle2' });
        // Try to click the first property
        const propLink = await page.$('table tbody tr td a, .property-card a, a[href^="/properties/"]');
        if (propLink) {
          await propLink.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
          // Now on property show page, click first unit
          const unitLink = await page.$('a[href*="/units/"]');
          if (unitLink) {
            await unitLink.click();
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
            await sleep(500);
            return page.screenshot({ fullPage: true, type: 'png' });
          }
        }
      } catch {}
      return screenshot(page, '/properties', '.topbar-title');
    })();
    screenshots.push(unitScreenshot);

    // 8. New payment form
    screenshots.push(await screenshot(page, '/payments/new', 'form, .topbar-title'));

    // 9. Payment show (first payment if any)
    const paymentShowScreenshot = await (async () => {
      try {
        await page.goto(`${BASE_URL}/payments`, { waitUntil: 'networkidle2' });
        const payLink = await page.$('table tbody tr td a, a[href^="/payments/"]');
        if (payLink) {
          const href = await page.evaluate(el => el.getAttribute('href'), payLink);
          if (href && href.match(/\/payments\/\d+/)) {
            await payLink.click();
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
            await sleep(500);
            return page.screenshot({ fullPage: true, type: 'png' });
          }
        }
      } catch {}
      return screenshot(page, '/payments', '.topbar-title');
    })();
    screenshots.push(paymentShowScreenshot);

    // 10. Calendar
    screenshots.push(await screenshot(page, '/reports/calendar', '.topbar-title, table'));

    console.log(`  ✅ ${screenshots.length} screenshots captured`);

  } finally {
    await browser.close();

    // Remove temp user
    if (useTempUser) {
      console.log('\n🧹 Removing temporary user...');
      deleteTempUser(tenantDbPath);
      console.log('  Temporary user removed.');
    }

    // Kill app process if we started it
    if (appProcess) {
      appProcess.kill('SIGTERM');
      console.log('\n🛑 App process terminated.');
    }
  }

  // 4. Build HTML
  console.log('\n📝 Step 4: Building HTML document...');
  const sections = buildSections(screenshots);
  const html = buildHtml(sections);
  console.log('  HTML built successfully.');

  // 5. Generate PDF
  console.log('\n📄 Step 5: Generating PDF...');
  const pdfBrowser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const pdfPage = await pdfBrowser.newPage();
    await pdfPage.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    // Give Google Fonts a moment to load
    await sleep(2000);
    const pdfBuffer = await pdfPage.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
    });
    fs.writeFileSync(OUTPUT_PATH, pdfBuffer);
    console.log(`  ✅ PDF saved to: ${OUTPUT_PATH}`);
    console.log(`  📏 File size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);
  } finally {
    await pdfBrowser.close();
  }

  console.log('\n✨ Done! Open adeem_user_guide.pdf to review the guide.');
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
