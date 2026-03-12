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
  const appUrl = process.env.APP_URL || 'http://localhost:3002';
  const loginUrl = `${appUrl}/${slug}/login`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #2c3e50;">Welcome to Adeem SaaS, ${adminName}!</h2>
      <p>Your company account <strong>${companyName}</strong> has been created successfully.</p>
      <p>Here are your login details:</p>
      <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
        <tr>
          <td style="padding: 10px; border: 1px solid #ddd; background: #f9f9f9; font-weight: bold;">Login URL</td>
          <td style="padding: 10px; border: 1px solid #ddd;"><a href="${loginUrl}">${loginUrl}</a></td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #ddd; background: #f9f9f9; font-weight: bold;">Username</td>
          <td style="padding: 10px; border: 1px solid #ddd;">admin</td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #ddd; background: #f9f9f9; font-weight: bold;">Password</td>
          <td style="padding: 10px; border: 1px solid #ddd;">${password}</td>
        </tr>
      </table>
      <p style="color: #e74c3c; font-size: 13px;">Please keep these credentials secure. We recommend changing your password after first login.</p>
      <p>Your trial period is active for 14 days.</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="font-size: 12px; color: #999;">This is an automated message from Adeem SaaS.</p>
    </div>
  `;

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: `Welcome to Adeem SaaS — Your Login Details for ${companyName}`,
    html,
  });
}

module.exports = { sendWelcomeEmail };
