import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { SecurityEventType } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendPasswordResetEmail, sendWelcomeEmail } from '../../config/mailer';
import { ensureAuthenticated, type AuthenticatedRequest } from './authMiddleware';
import { recordSecurityEvent } from './securityAudit';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_TIME_FORMAT,
  DEFAULT_TIMEZONE,
  JWT_SECRET,
  SUPPORTED_LANGUAGES,
  getGoogleOAuthEnabled,
  isPasswordStrong,
  normalizeEmail,
} from '../../config/auth';

const router = Router();
const googleClient = new OAuth2Client();

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     summary: Login do usuário
 *     tags: [Autenticação]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: Login realizado com sucesso
 *       401:
 *         description: Credenciais inválidas
 */

const createToken = (userId: string) =>
  jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '8h' });

const hashResetToken = (token: string) =>
  crypto.createHash('sha256').update(token).digest('hex');

const trySendWelcomeEmail = async (email: string, name: string): Promise<boolean> => {
  try {
    await sendWelcomeEmail(email, name);
    return true;
  } catch (error) {
    console.error('[auth] Falha ao enviar e-mail de boas-vindas:', error);
    return false;
  }
};

const serializeUser = (user: any) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  status: user.status,
  setupCompleted: user.setupCompleted ?? false,
  timeFormat: user.preference?.timeFormat ?? DEFAULT_TIME_FORMAT,
  timezone: user.preference?.timezone ?? DEFAULT_TIMEZONE,
  language: user.preference?.language ?? DEFAULT_LANGUAGE,
  googleLoginEnabled: getGoogleOAuthEnabled(),
});

router.get('/config', (req: Request, res: Response) => {
  res.json({
    allowGoogleOAuth: getGoogleOAuthEnabled(),
    googleClientId: getGoogleOAuthEnabled() ? process.env.GOOGLE_CLIENT_ID : undefined,
    defaultTimezone: DEFAULT_TIMEZONE,
    defaultTimeFormat: DEFAULT_TIME_FORMAT,
    defaultLanguage: DEFAULT_LANGUAGE,
    supportedLanguages: SUPPORTED_LANGUAGES,
  });
});

router.post('/register', async (req: Request, res: Response) => {
  const { name, email, password } = req.body ?? {};

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Nome, e-mail e senha são obrigatórios.' });
  }

  if (!isPasswordStrong(password)) {
    return res.status(400).json({
      message: 'A senha informada não atende aos requisitos mínimos de segurança.',
    });
  }

  const normalizedEmail = normalizeEmail(email);

  const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (existingUser) {
    return res.status(409).json({ message: 'Já existe um usuário cadastrado com este e-mail.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const createdUser = await prisma.user.create({
    data: {
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash,
      preference: {
        create: {
          timeFormat: DEFAULT_TIME_FORMAT,
          timezone: DEFAULT_TIMEZONE,
          language: DEFAULT_LANGUAGE,
        },
      },
    },
    include: { preference: true },
  });

  const emailSent = await trySendWelcomeEmail(createdUser.email, createdUser.name);
  await recordSecurityEvent(req, createdUser.email, SecurityEventType.ACCOUNT_REGISTERED, createdUser.id);

  const token = createToken(createdUser.id);

  return res.status(201).json({
    token,
    emailSent,
    user: serializeUser(createdUser),
  });
});

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
  }

  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    include: { preference: true },
  });

  if (!user) {
    await recordSecurityEvent(req, normalizedEmail, SecurityEventType.LOGIN_FAILED);
    return res.status(401).json({ message: 'Credenciais inválidas.' });
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);

  if (!passwordMatches) {
    await recordSecurityEvent(req, normalizedEmail, SecurityEventType.LOGIN_FAILED, user.id);
    return res.status(401).json({ message: 'Credenciais inválidas.' });
  }

  await recordSecurityEvent(req, user.email, SecurityEventType.LOGIN_SUCCEEDED, user.id);

  const token = createToken(user.id);

  return res.json({
    token,
    user: serializeUser(user),
  });
});

router.post('/google', async (req: Request, res: Response) => {
  if (!getGoogleOAuthEnabled()) {
    return res.status(403).json({ message: 'Login do Google está desativado.' });
  }

  const { credential } = req.body ?? {};

  if (!credential) {
    return res.status(400).json({ message: 'Credencial do Google obrigatória.' });
  }

  let googleProfile;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: String(credential),
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    googleProfile = ticket.getPayload();
  } catch (error) {
    return res.status(401).json({ message: 'Credencial do Google inválida ou expirada.' });
  }

  if (!googleProfile?.sub || !googleProfile.email || googleProfile.email_verified !== true) {
    return res.status(401).json({ message: 'A conta Google não possui um e-mail verificado.' });
  }

  const normalizedEmail = normalizeEmail(googleProfile.email);
  const existingGoogleUser = await prisma.user.findUnique({
    where: { googleId: googleProfile.sub },
    include: { preference: true },
  });

  let user = existingGoogleUser;
  let isNewUser = false;

  if (!user) {
    const existingEmailUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { preference: true },
    });

    if (existingEmailUser?.googleId && existingEmailUser.googleId !== googleProfile.sub) {
      return res.status(409).json({ message: 'Este e-mail já está vinculado a outra conta Google.' });
    }

    if (existingEmailUser) {
      user = await prisma.user.update({
        where: { id: existingEmailUser.id },
        data: { googleId: googleProfile.sub },
        include: { preference: true },
      });
    } else {
      user = await prisma.user.create({
        data: {
          name: googleProfile.name?.trim() || normalizedEmail,
          email: normalizedEmail,
          googleId: googleProfile.sub,
          passwordHash: await bcrypt.hash(crypto.randomUUID(), 10),
          preference: {
            create: {
              timeFormat: DEFAULT_TIME_FORMAT,
              timezone: DEFAULT_TIMEZONE,
              language: DEFAULT_LANGUAGE,
            },
          },
        },
        include: { preference: true },
      });
      isNewUser = true;
    }
  }

  const emailSent = isNewUser
    ? await trySendWelcomeEmail(user.email, user.name)
    : undefined;

  const token = createToken(user.id);

  await recordSecurityEvent(req, user.email, SecurityEventType.GOOGLE_LOGIN_SUCCEEDED, user.id);
  if (isNewUser) {
    await recordSecurityEvent(req, user.email, SecurityEventType.ACCOUNT_REGISTERED, user.id);
  }

  return res.status(isNewUser ? 201 : 200).json({
    token,
    newUser: isNewUser,
    emailSent,
    user: serializeUser(user),
  });
});

router.post('/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body ?? {};

  if (!email) {
    return res.status(400).json({ message: 'E-mail obrigatório.' });
  }

  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  await recordSecurityEvent(
    req,
    normalizedEmail,
    SecurityEventType.PASSWORD_RECOVERY_REQUESTED,
    user?.id,
  );

  if (user) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const resetUrl = new URL('/', process.env.FRONTEND_URL || 'http://localhost:5173');
    resetUrl.searchParams.set('mode', 'reset');
    resetUrl.searchParams.set('token', resetToken);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: hashResetToken(resetToken),
        passwordResetExpiresAt: expiresAt,
      },
    });

    try {
      await sendPasswordResetEmail(user.email, user.name, resetUrl.toString());
    } catch (error) {
      console.error('[auth] Falha ao enviar e-mail de recuperação:', error);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordResetToken: null, passwordResetExpiresAt: null },
      });
    }
  }

  return res.json({
    message: 'Se o e-mail estiver cadastrado, enviaremos instruções de recuperação.',
  });
});

router.post('/reset-password', async (req: Request, res: Response) => {
  const { token, password } = req.body ?? {};

  if (!token || !password) {
    return res.status(400).json({ message: 'Token e nova senha são obrigatórios.' });
  }

  if (!isPasswordStrong(password)) {
    return res.status(400).json({
      message: 'A senha informada não atende aos requisitos mínimos de segurança.',
    });
  }

  const user = await prisma.user.findFirst({
    where: {
      passwordResetToken: hashResetToken(String(token)),
      passwordResetExpiresAt: {
        gt: new Date(),
      },
    },
  });

  if (!user) {
    return res.status(400).json({ message: 'Token inválido ou expirado.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordResetToken: null,
      passwordResetExpiresAt: null,
    },
  });

  await recordSecurityEvent(req, user.email, SecurityEventType.PASSWORD_RESET_SUCCEEDED, user.id);

  return res.json({ message: 'Senha redefinida com sucesso.' });
});

router.get('/me', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: { preference: true },
  });

  if (!user) {
    return res.status(404).json({ message: 'Usuário não encontrado.' });
  }

  return res.json({ user: serializeUser(user) });
});

router.patch('/preferences', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const { timeFormat, timezone, language } = req.body ?? {};

  if (timeFormat && !['H24', 'H12'].includes(String(timeFormat))) {
    return res.status(400).json({ message: 'Formato de hora inválido.' });
  }

  if (language && !SUPPORTED_LANGUAGES.includes(String(language) as typeof SUPPORTED_LANGUAGES[number])) {
    return res.status(400).json({ message: 'Idioma inválido.' });
  }

  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: {
      setupCompleted: true,
      preference: {
        upsert: {
          create: {
            timeFormat: timeFormat ?? DEFAULT_TIME_FORMAT,
            timezone: timezone ?? DEFAULT_TIMEZONE,
            language: language ?? DEFAULT_LANGUAGE,
          },
          update: {
            timeFormat: timeFormat ?? undefined,
            timezone: timezone ?? undefined,
            language: language ?? undefined,
          },
        },
      },
    },
    include: { preference: true },
  });

  return res.json({ user: serializeUser(user) });
});

export default router;
