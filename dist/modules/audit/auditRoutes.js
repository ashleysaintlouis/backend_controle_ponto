"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authMiddleware_1 = require("../auth/authMiddleware");
const prisma_1 = require("../../lib/prisma");
const router = (0, express_1.Router)();
router.get('/security', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const requestedLimit = Number(req.query.limit ?? 100);
    const take = Number.isInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
    const events = await prisma_1.prisma.securityEvent.findMany({
        where: {
            OR: [
                { userId: req.user.id },
                { email: req.user.email },
            ],
        },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
            id: true,
            type: true,
            email: true,
            ipAddress: true,
            userAgent: true,
            createdAt: true,
        },
    });
    return res.json({ events });
});
exports.default = router;
