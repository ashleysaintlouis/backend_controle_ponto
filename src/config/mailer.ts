import nodemailer, { type Transporter } from 'nodemailer';

let transporter: Transporter | undefined;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
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

    transporter = nodemailer.createTransport({
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

export async function sendWelcomeEmail(email: string, name: string): Promise<void> {
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

export async function sendPasswordResetEmail(
  email: string,
  name: string,
  resetUrl: string,
): Promise<void> {
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

export async function sendSystemNotificationEmail(
  email: string,
  name: string,
  message: string,
): Promise<void> {
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