const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY || 're_xxxxxxxxx');

async function sendTestEmail() {
  const email = await resend.emails.send({
    from: 'onboarding@resend.dev',
    to: 'benjaminpaulkastner@gmail.com',
    subject: 'Hello World',
    html: '<p>Congrats on sending your <strong>first email</strong>!</p>'
  });

  console.log('Resend email sent:', email);
}

sendTestEmail().catch((error) => {
  console.error('Resend error:', error);
  process.exit(1);
});
