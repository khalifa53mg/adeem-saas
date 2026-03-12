require('dotenv').config();
const { sendWelcomeEmail } = require('./middleware/mailer');

sendWelcomeEmail({
  to: 'adeem@inforiseit.com',
  companyName: 'Test Company',
  adminName: 'Adeem',
  slug: 'test-company',
  password: 'TestPass123',
}).then(() => {
  console.log('Email sent successfully!');
}).catch(err => {
  console.error('Email failed:', err.message);
});
