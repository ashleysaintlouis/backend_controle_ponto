"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAuthenticated = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = require("../../lib/prisma");
const auth_1 = require("../../config/auth");
const ensureAuthenticated = async (req, res, next) => {
    const authorizationHeader = req.headers.authorization;
    if (!authorizationHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Token de autenticação ausente.' });
    }
    try {
        const payload = jsonwebtoken_1.default.verify(authorizationHeader.slice(7), auth_1.JWT_SECRET);
        const user = await prisma_1.prisma.user.findUnique({ where: { id: payload.sub } });
        if (!user) {
            return res.status(401).json({ message: 'Usuário não encontrado.' });
        }
        req.user = { id: user.id, email: user.email };
        return next();
    }
    catch (error) {
        return res.status(401).json({ message: 'Token inválido ou expirado.' });
    }
};
exports.ensureAuthenticated = ensureAuthenticated;
