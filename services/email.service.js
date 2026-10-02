const nodemailer = require('nodemailer');

function isEmailEnabled() {
    return String(process.env.EMAIL_ENABLED || 'true')
        .trim()
        .toLowerCase() === 'true';
}

const port = Number(process.env.SMTP_PORT || 587);

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
    }
});

async function sendEmail({ to, subject, text, html }) {
    if (!isEmailEnabled()) {
        return {
            skipped: true,
            reason: 'EMAIL_DISABLED'
        };
    }

    return transporter.sendMail({
        from: process.env.SMTP_FROM,
        to,
        subject,
        text,
        html
    });
}

async function verifyEmailTransport() {
    if (!isEmailEnabled()) {
        return;
    }

    await transporter.verify();
}

module.exports = {
    sendEmail,
    verifyEmailTransport,
    isEmailEnabled
};