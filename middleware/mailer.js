const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST || 'smtp.office365.com',
  port: parseInt(process.env.MAIL_PORT) || 587,
  secure: false, // STARTTLS
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
  tls: {
    ciphers: 'SSLv3',
  },
});

async function sendWelcomeEmail({ to, companyName, adminName, slug, password }) {
  const appUrl = process.env.APP_URL || 'https://adeem.inforiseit.com';
  const loginUrl = `${appUrl}/login?slug=${slug}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Welcome to Adeem</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f8;font-family:'Inter',system-ui,-apple-system,sans-serif;">

  <!-- Wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f2f8;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

          <!-- Header / Brand -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:10px;">
                    <div style="width:40px;height:40px;background:#5b7cfa;border-radius:10px;text-align:center;line-height:40px;font-size:20px;">🏢</div>
                  </td>
                  <td style="vertical-align:middle;">
                    <div style="font-size:20px;font-weight:700;color:#1e2238;line-height:1.1;">Adeem</div>
                    <div style="font-size:11px;color:#5a6282;font-weight:500;letter-spacing:0.04em;text-transform:uppercase;">Real Estate</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Card -->
          <tr>
            <td style="background:#ffffff;border:1px solid #dde1f0;border-radius:12px;overflow:hidden;">

              <!-- Card Top Accent -->
              <div style="height:4px;background:linear-gradient(90deg,#5b7cfa,#38bdf8);"></div>

              <!-- Card Body -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:32px 36px;">

                <!-- Greeting -->
                <tr>
                  <td style="padding-bottom:8px;">
                    <div style="font-size:22px;font-weight:700;color:#1e2238;">Welcome, ${adminName}! 👋</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:28px;">
                    <div style="font-size:14px;color:#5a6282;line-height:1.6;">
                      Your company account <strong style="color:#1e2238;">${companyName}</strong> has been created successfully on Adeem Real Estate platform. Below are your login credentials to get started.
                    </div>
                  </td>
                </tr>

                <!-- Section Title -->
                <tr>
                  <td style="padding-bottom:12px;">
                    <div style="font-size:11.5px;font-weight:600;color:#8892b0;text-transform:uppercase;letter-spacing:0.07em;">Login Details</div>
                  </td>
                </tr>

                <!-- Credentials Table -->
                <tr>
                  <td style="padding-bottom:28px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #dde1f0;border-radius:8px;overflow:hidden;">
                      <!-- Login URL -->
                      <tr style="border-bottom:1px solid #dde1f0;">
                        <td style="padding:12px 16px;background:#f8faff;width:130px;font-size:12.5px;font-weight:600;color:#5a6282;border-right:1px solid #dde1f0;white-space:nowrap;">Login URL</td>
                        <td style="padding:12px 16px;font-size:13px;color:#5b7cfa;">
                          <a href="${loginUrl}" style="color:#5b7cfa;text-decoration:none;font-weight:500;">${loginUrl}</a>
                        </td>
                      </tr>
                      <!-- Username -->
                      <tr style="border-bottom:1px solid #dde1f0;">
                        <td style="padding:12px 16px;background:#f8faff;font-size:12.5px;font-weight:600;color:#5a6282;border-right:1px solid #dde1f0;white-space:nowrap;">Username</td>
                        <td style="padding:12px 16px;font-size:13px;color:#1e2238;font-weight:500;">admin</td>
                      </tr>
                      <!-- Password -->
                      <tr>
                        <td style="padding:12px 16px;background:#f8faff;font-size:12.5px;font-weight:600;color:#5a6282;border-right:1px solid #dde1f0;white-space:nowrap;">Password</td>
                        <td style="padding:12px 16px;">
                          <span style="display:inline-block;background:rgba(91,124,250,0.1);color:#5b7cfa;font-size:13px;font-weight:600;padding:4px 12px;border-radius:6px;letter-spacing:0.05em;">${password}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- CTA Button -->
                <tr>
                  <td style="padding-bottom:28px;">
                    <a href="${loginUrl}" style="display:inline-block;background:#5b7cfa;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;letter-spacing:0.02em;">
                      Login to Your Account →
                    </a>
                  </td>
                </tr>

                <!-- Security Notice -->
                <tr>
                  <td style="padding-bottom:24px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(245,166,35,0.08);border:1px solid rgba(245,166,35,0.3);border-radius:8px;padding:12px 16px;">
                      <tr>
                        <td style="font-size:13px;color:#b07d1a;line-height:1.5;">
                          ⚠️ &nbsp;<strong>Security Reminder:</strong> Please keep your credentials secure and change your password after the first login.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Trial Badge -->
                <tr>
                  <td>
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="background:rgba(45,212,160,0.12);border:1px solid rgba(45,212,160,0.3);border-radius:20px;padding:4px 14px;">
                          <span style="font-size:12px;font-weight:600;color:#1aab7a;letter-spacing:0.03em;">✓ &nbsp;14-Day Free Trial Active</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;">
              <div style="font-size:12px;color:#8892b0;line-height:1.6;">
                This is an automated message from <strong style="color:#5a6282;">Adeem Real Estate SaaS</strong>.<br/>
                If you did not request this account, please ignore this email.
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: `Welcome to Adeem SaaS — Your Login Details for ${companyName}`,
    html,
  });
}

async function sendPromoEmail({ to, adminName, companyName }) {
  const appUrl = process.env.APP_URL || 'https://adeem.inforiseit.com';
  const loginUrl = `${appUrl}/login`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Limited Offer — Adeem SaaS</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f8;font-family:'Inter',system-ui,-apple-system,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f2f8;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

          <!-- Header / Brand -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:10px;">
                    <div style="width:40px;height:40px;background:#5b7cfa;border-radius:10px;text-align:center;line-height:40px;font-size:20px;">🏢</div>
                  </td>
                  <td style="vertical-align:middle;">
                    <div style="font-size:20px;font-weight:700;color:#1e2238;line-height:1.1;">Adeem</div>
                    <div style="font-size:11px;color:#5a6282;font-weight:500;letter-spacing:0.04em;text-transform:uppercase;">Real Estate</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Card -->
          <tr>
            <td style="background:#ffffff;border:1px solid #dde1f0;border-radius:12px;overflow:hidden;">

              <!-- Top Accent -->
              <div style="height:4px;background:linear-gradient(90deg,#5b7cfa,#38bdf8);"></div>

              <!-- Card Body -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:32px 36px;">

                <!-- Greeting -->
                <tr>
                  <td style="padding-bottom:8px;">
                    <div style="font-size:22px;font-weight:700;color:#1e2238;">Hi ${adminName}! 👋</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:28px;">
                    <div style="font-size:14px;color:#5a6282;line-height:1.7;">
                      We noticed that <strong style="color:#1e2238;">${companyName}</strong> has registered on Adeem Real Estate SaaS — and we don't want you to miss what it can do for your business.
                      <br/><br/>
                      Whether you're on a free trial or already active, <strong style="color:#1e2238;">now is the best time to explore the platform</strong>: manage properties, track payments, handle tenants, and generate reports — all in one place.
                    </div>
                  </td>
                </tr>

                <!-- Offer Banner -->
                <tr>
                  <td style="padding-bottom:28px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:linear-gradient(135deg,#5b7cfa,#38bdf8);border-radius:10px;padding:24px 28px;">
                      <tr>
                        <td align="center">
                          <div style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.8);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">⏳ Limited Time Offer</div>
                          <div style="font-size:38px;font-weight:800;color:#ffffff;line-height:1.1;margin-bottom:4px;">25% OFF</div>
                          <div style="font-size:14px;color:rgba(255,255,255,0.9);margin-bottom:16px;">on your Adeem subscription — available to early users only</div>
                          <a href="${loginUrl}" style="display:inline-block;background:#ffffff;color:#5b7cfa;text-decoration:none;font-size:14px;font-weight:700;padding:11px 28px;border-radius:8px;letter-spacing:0.02em;">
                            Log In &amp; Activate Offer →
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Why not skip -->
                <tr>
                  <td style="padding-bottom:8px;">
                    <div style="font-size:11.5px;font-weight:600;color:#8892b0;text-transform:uppercase;letter-spacing:0.07em;">Why you shouldn't skip testing</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:28px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #dde1f0;border-radius:8px;overflow:hidden;">
                      <tr>
                        <td style="padding:12px 16px;border-bottom:1px solid #dde1f0;">
                          <span style="font-size:16px;">🏘️</span>
                          <span style="font-size:13px;color:#1e2238;margin-left:10px;">Add your <strong>properties and units</strong> — see the full dashboard come to life</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:12px 16px;border-bottom:1px solid #dde1f0;">
                          <span style="font-size:16px;">👥</span>
                          <span style="font-size:13px;color:#1e2238;margin-left:10px;">Link <strong>tenants</strong> and record payments in seconds</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:12px 16px;border-bottom:1px solid #dde1f0;">
                          <span style="font-size:16px;">📊</span>
                          <span style="font-size:13px;color:#1e2238;margin-left:10px;">Generate <strong>income reports</strong>, rent rolls, and outstanding balance sheets</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:12px 16px;">
                          <span style="font-size:16px;">🌐</span>
                          <span style="font-size:13px;color:#1e2238;margin-left:10px;">Full <strong>Arabic &amp; English</strong> support — works on desktop and mobile</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Urgency notice -->
                <tr>
                  <td style="padding-bottom:24px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(245,166,35,0.08);border:1px solid rgba(245,166,35,0.3);border-radius:8px;padding:12px 16px;">
                      <tr>
                        <td style="font-size:13px;color:#b07d1a;line-height:1.5;">
                          ⚠️ &nbsp;<strong>This offer is limited</strong> and available only to users who activate or upgrade during the early access period. Don't miss it.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- CTA -->
                <tr>
                  <td>
                    <a href="${loginUrl}" style="display:inline-block;background:#5b7cfa;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;letter-spacing:0.02em;">
                      Go to Adeem Now →
                    </a>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;">
              <div style="font-size:12px;color:#8892b0;line-height:1.6;">
                You're receiving this because you registered on <strong style="color:#5a6282;">Adeem Real Estate SaaS</strong>.<br/>
                Questions? Reply to this email and we'll help you get started.
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: `🎁 25% Off — Limited Offer for Adeem Early Users`,
    html,
  });
}

module.exports = { sendWelcomeEmail, sendPromoEmail };
