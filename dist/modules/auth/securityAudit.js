"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordSecurityEvent = recordSecurityEvent;
const prisma_1 = require("../../lib/prisma");
async function recordSecurityEvent(req, email, type, userId) {
    try {
        await prisma_1.prisma.securityEvent.create({
            data: {
                email: email.trim().toLowerCase().slice(0, 255),
                type,
                userId,
                ipAddress: req.ip?.slice(0, 64),
                userAgent: req.get('user-agent')?.slice(0, 500),
            },
        });
    }
    catch (error) {
        console.error('[audit] Não foi possível gravar evento de segurança.');
    }
}
