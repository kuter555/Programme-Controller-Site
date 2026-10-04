'use strict';
// Sends account emails over SMTP when SMTP_HOST is configured in .env.
// Without it (e.g. local testing) the message is printed to the server log
// instead, so the set-password link can still be copied from there.
const nodemailer = require('nodemailer');

let transport = null;
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

function sendMail(to, subject, text) {
  if (!transport) {
    console.log('[mail] SMTP not configured — would have sent:\n  To: ' + to + '\n  Subject: ' + subject + '\n' + text.replace(/^/gm, '  '));
    return Promise.resolve();
  }
  return transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
}

module.exports = { sendMail, configured: !!transport };
