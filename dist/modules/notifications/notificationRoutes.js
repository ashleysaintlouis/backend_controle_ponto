"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authMiddleware_1 = require("../auth/authMiddleware");
const prisma_1 = require("../../lib/prisma");
const router = (0, express_1.Router)();
router.get('/', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const notifications = await prisma_1.prisma.notification.findMany({
        where: { userId: req.user.id },
        orderBy: { scheduledAt: 'desc' },
        take: 100,
    });
    return res.json({ notifications });
});
router.patch('/:id/read', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const updated = await prisma_1.prisma.notification.updateMany({
        where: { id: String(req.params.id), userId: req.user.id },
        data: { status: 'READ', readAt: new Date() },
    });
    if (!updated.count)
        return res.status(404).json({ message: 'Notificação não encontrada.' });
    return res.json({ message: 'Notificação marcada como lida.' });
});
exports.default = router;
