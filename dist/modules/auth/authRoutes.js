"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const google_auth_library_1 = require("google-auth-library");
const client_1 = require("@prisma/client");
const express_1 = require("express");
const prisma_1 = require("../../lib/prisma");
const mailer_1 = require("../../config/mailer");
const authMiddleware_1 = require("./authMiddleware");
const securityAudit_1 = require("./securityAudit");
const auth_1 = require("../../config/auth");
const router = (0, express_1.Router)();
const googleClient = new google_auth_library_1.OAuth2Client();
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
const createToken = (userId) => jsonwebtoken_1.default.sign({ sub: userId }, auth_1.JWT_SECRET, { expiresIn: '8h' });
const hashResetToken = (token) => node_crypto_1.default.createHash('sha256').update(token).digest('hex');
const trySendWelcomeEmail = async (email, name) => {
    try {
        await (0, mailer_1.sendWelcomeEmail)(email, name);
        return true;
    }
    catch (error) {
        console.error('[auth] Falha ao enviar e-mail de boas-vindas:', error);
        return false;
    }
};
const serializeUser = (user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    setupCompleted: user.setupCompleted ?? false,
    timeFormat: user.preference?.timeFormat ?? auth_1.DEFAULT_TIME_FORMAT,
    timezone: user.preference?.timezone ?? auth_1.DEFAULT_TIMEZONE,
    language: user.preference?.language ?? auth_1.DEFAULT_LANGUAGE,
    googleLoginEnabled: (0, auth_1.getGoogleOAuthEnabled)(),
});
router.get('/config', (req, res) => {
    res.json({
        allowGoogleOAuth: (0, auth_1.getGoogleOAuthEnabled)(),
        googleClientId: (0, auth_1.getGoogleOAuthEnabled)() ? process.env.GOOGLE_CLIENT_ID : undefined,
        defaultTimezone: auth_1.DEFAULT_TIMEZONE,
        defaultTimeFormat: auth_1.DEFAULT_TIME_FORMAT,
        defaultLanguage: auth_1.DEFAULT_LANGUAGE,
        supportedLanguages: auth_1.SUPPORTED_LANGUAGES,
    });
});
router.post('/register', async (req, res) => {
    const { name, email, password } = req.body ?? {};
    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Nome, e-mail e senha são obrigatórios.' });
    }
    if (!(0, auth_1.isPasswordStrong)(password)) {
        return res.status(400).json({
            message: 'A senha informada não atende aos requisitos mínimos de segurança.',
        });
    }
    const normalizedEmail = (0, auth_1.normalizeEmail)(email);
    const existingUser = await prisma_1.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingUser) {
        return res.status(409).json({ message: 'Já existe um usuário cadastrado com este e-mail.' });
    }
    const passwordHash = await bcryptjs_1.default.hash(password, 10);
    const createdUser = await prisma_1.prisma.user.create({
        data: {
            name: String(name).trim(),
            email: normalizedEmail,
            passwordHash,
            preference: {
                create: {
                    timeFormat: auth_1.DEFAULT_TIME_FORMAT,
                    timezone: auth_1.DEFAULT_TIMEZONE,
                    language: auth_1.DEFAULT_LANGUAGE,
                },
            },
        },
        include: { preference: true },
    });
    const emailSent = await trySendWelcomeEmail(createdUser.email, createdUser.name);
    await (0, securityAudit_1.recordSecurityEvent)(req, createdUser.email, client_1.SecurityEventType.ACCOUNT_REGISTERED, createdUser.id);
    const token = createToken(createdUser.id);
    return res.status(201).json({
        token,
        emailSent,
        user: serializeUser(createdUser),
    });
});
router.post('/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
        return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
    }
    const normalizedEmail = (0, auth_1.normalizeEmail)(email);
    const user = await prisma_1.prisma.user.findUnique({
        where: { email: normalizedEmail },
        include: { preference: true },
    });
    if (!user) {
        await (0, securityAudit_1.recordSecurityEvent)(req, normalizedEmail, client_1.SecurityEventType.LOGIN_FAILED);
        return res.status(401).json({ message: 'Credenciais inválidas.' });
    }
    const passwordMatches = await bcryptjs_1.default.compare(password, user.passwordHash);
    if (!passwordMatches) {
        await (0, securityAudit_1.recordSecurityEvent)(req, normalizedEmail, client_1.SecurityEventType.LOGIN_FAILED, user.id);
        return res.status(401).json({ message: 'Credenciais inválidas.' });
    }
    await (0, securityAudit_1.recordSecurityEvent)(req, user.email, client_1.SecurityEventType.LOGIN_SUCCEEDED, user.id);
    const token = createToken(user.id);
    return res.json({
        token,
        user: serializeUser(user),
    });
});
router.post('/google', async (req, res) => {
    if (!(0, auth_1.getGoogleOAuthEnabled)()) {
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
    }
    catch (error) {
        return res.status(401).json({ message: 'Credencial do Google inválida ou expirada.' });
    }
    if (!googleProfile?.sub || !googleProfile.email || googleProfile.email_verified !== true) {
        return res.status(401).json({ message: 'A conta Google não possui um e-mail verificado.' });
    }
    const normalizedEmail = (0, auth_1.normalizeEmail)(googleProfile.email);
    const existingGoogleUser = await prisma_1.prisma.user.findUnique({
        where: { googleId: googleProfile.sub },
        include: { preference: true },
    });
    let user = existingGoogleUser;
    let isNewUser = false;
    if (!user) {
        const existingEmailUser = await prisma_1.prisma.user.findUnique({
            where: { email: normalizedEmail },
            include: { preference: true },
        });
        if (existingEmailUser?.googleId && existingEmailUser.googleId !== googleProfile.sub) {
            return res.status(409).json({ message: 'Este e-mail já está vinculado a outra conta Google.' });
        }
        if (existingEmailUser) {
            user = await prisma_1.prisma.user.update({
                where: { id: existingEmailUser.id },
                data: { googleId: googleProfile.sub },
                include: { preference: true },
            });
        }
        else {
            user = await prisma_1.prisma.user.create({
                data: {
                    name: googleProfile.name?.trim() || normalizedEmail,
                    email: normalizedEmail,
                    googleId: googleProfile.sub,
                    passwordHash: await bcryptjs_1.default.hash(node_crypto_1.default.randomUUID(), 10),
                    preference: {
                        create: {
                            timeFormat: auth_1.DEFAULT_TIME_FORMAT,
                            timezone: auth_1.DEFAULT_TIMEZONE,
                            language: auth_1.DEFAULT_LANGUAGE,
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
    await (0, securityAudit_1.recordSecurityEvent)(req, user.email, client_1.SecurityEventType.GOOGLE_LOGIN_SUCCEEDED, user.id);
    if (isNewUser) {
        await (0, securityAudit_1.recordSecurityEvent)(req, user.email, client_1.SecurityEventType.ACCOUNT_REGISTERED, user.id);
    }
    return res.status(isNewUser ? 201 : 200).json({
        token,
        newUser: isNewUser,
        emailSent,
        user: serializeUser(user),
    });
});
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body ?? {};
    if (!email) {
        return res.status(400).json({ message: 'E-mail obrigatório.' });
    }
    const normalizedEmail = (0, auth_1.normalizeEmail)(email);
    const user = await prisma_1.prisma.user.findUnique({ where: { email: normalizedEmail } });
    await (0, securityAudit_1.recordSecurityEvent)(req, normalizedEmail, client_1.SecurityEventType.PASSWORD_RECOVERY_REQUESTED, user?.id);
    if (user) {
        const resetToken = node_crypto_1.default.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        const resetUrl = new URL('/', process.env.FRONTEND_URL || 'http://localhost:5173');
        resetUrl.searchParams.set('mode', 'reset');
        resetUrl.searchParams.set('token', resetToken);
        await prisma_1.prisma.user.update({
            where: { id: user.id },
            data: {
                passwordResetToken: hashResetToken(resetToken),
                passwordResetExpiresAt: expiresAt,
            },
        });
        try {
            await (0, mailer_1.sendPasswordResetEmail)(user.email, user.name, resetUrl.toString());
        }
        catch (error) {
            console.error('[auth] Falha ao enviar e-mail de recuperação:', error);
            await prisma_1.prisma.user.update({
                where: { id: user.id },
                data: { passwordResetToken: null, passwordResetExpiresAt: null },
            });
        }
    }
    return res.json({
        message: 'Se o e-mail estiver cadastrado, enviaremos instruções de recuperação.',
    });
});
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body ?? {};
    if (!token || !password) {
        return res.status(400).json({ message: 'Token e nova senha são obrigatórios.' });
    }
    if (!(0, auth_1.isPasswordStrong)(password)) {
        return res.status(400).json({
            message: 'A senha informada não atende aos requisitos mínimos de segurança.',
        });
    }
    const user = await prisma_1.prisma.user.findFirst({
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
    const passwordHash = await bcryptjs_1.default.hash(password, 10);
    await prisma_1.prisma.user.update({
        where: { id: user.id },
        data: {
            passwordHash,
            passwordResetToken: null,
            passwordResetExpiresAt: null,
        },
    });
    await (0, securityAudit_1.recordSecurityEvent)(req, user.email, client_1.SecurityEventType.PASSWORD_RESET_SUCCEEDED, user.id);
    return res.json({ message: 'Senha redefinida com sucesso.' });
});
router.get('/me', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: req.user.id },
        include: { preference: true },
    });
    if (!user) {
        return res.status(404).json({ message: 'Usuário não encontrado.' });
    }
    return res.json({ user: serializeUser(user) });
});
router.patch('/preferences', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const { timeFormat, timezone, language } = req.body ?? {};
    if (timeFormat && !['H24', 'H12'].includes(String(timeFormat))) {
        return res.status(400).json({ message: 'Formato de hora inválido.' });
    }
    if (language && !auth_1.SUPPORTED_LANGUAGES.includes(String(language))) {
        return res.status(400).json({ message: 'Idioma inválido.' });
    }
    const user = await prisma_1.prisma.user.update({
        where: { id: req.user.id },
        data: {
            setupCompleted: true,
            preference: {
                upsert: {
                    create: {
                        timeFormat: timeFormat ?? auth_1.DEFAULT_TIME_FORMAT,
                        timezone: timezone ?? auth_1.DEFAULT_TIMEZONE,
                        language: language ?? auth_1.DEFAULT_LANGUAGE,
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
exports.default = router;
