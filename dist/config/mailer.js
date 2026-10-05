"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendWelcomeEmail = sendWelcomeEmail;
exports.sendPasswordResetEmail = sendPasswordResetEmail;
exports.sendSystemNotificationEmail = sendSystemNotificationEmail;
const nodemailer_1 = __importDefault(require("nodemailer"));
let transporter;
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => {
    const entities = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    };
    return entities[character];
});
const getTransporter = () => {
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const user = process.env.SMTP_USER || process.env.GOOGLE_EMAIL;
    const pass = process.env.SMTP_PASS || process.env.GOOGLE_PASSWORD_APP;
    const fromAddress = process.env.SMTP_FROM_EMAIL || user;
    if (!fromAddress) {
        throw new Error('GOOGLE_EMAIL (ou SMTP_USER / SMTP_FROM_EMAIL) precisa estar configurado.');
    }
    if (!transporter) {
        const port = Number(process.env.SMTP_PORT || 587);
        transporter = nodemailer_1.default.createTransport({
            host,
            port,
            secure: process.env.SMTP_SECURE === 'true' || port === 465,
            auth: user && pass ? { user, pass } : undefined,
        });
    }
    return {
        client: transporter,
        from: `${process.env.SMTP_FROM_NAME || 'Controle de Ponto'} <${fromAddress}>`,
    };
};
async function sendWelcomeEmail(email, name) {
    const { client, from } = getTransporter();
    const safeName = escapeHtml(name);
    await client.sendMail({
        from,
        to: email,
        subject: 'Sua conta no Controle de Ponto foi criada',
        text: `Olá, ${name}! Sua conta no Controle de Ponto foi criada com sucesso.`,
        html: `<p>Olá, ${safeName}!</p><p>Sua conta no Controle de Ponto foi criada com sucesso.</p>`,
    });
}
async function sendPasswordResetEmail(email, name, resetUrl) {
    const { client, from } = getTransporter();
    const safeName = escapeHtml(name);
    const safeUrl = escapeHtml(resetUrl);
    await client.sendMail({
        from,
        to: email,
        subject: 'Redefinição de senha do Controle de Ponto',
        text: `Olá, ${name}! Use este link para redefinir sua senha. O link expira em 1 hora: ${resetUrl}`,
        html: `<p>Olá, ${safeName}!</p><p><a href="${safeUrl}">Redefinir senha</a></p><p>Este link expira em 1 hora. Se você não solicitou a redefinição, ignore este e-mail.</p>`,
    });
}
async function sendSystemNotificationEmail(email, name, message) {
    const { client, from } = getTransporter();
    const safeName = escapeHtml(name);
    const safeMessage = escapeHtml(message);
    await client.sendMail({
        from,
        to: email,
        subject: 'Aviso do Controle de Ponto',
        text: `Olá, ${name}. ${message}`,
        html: `<p>Olá, ${safeName}.</p><p>${safeMessage}</p>`,
    });
}
