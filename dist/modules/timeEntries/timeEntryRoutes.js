"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authMiddleware_1 = require("../auth/authMiddleware");
const auth_1 = require("../../config/auth");
const prisma_1 = require("../../lib/prisma");
const localDate_1 = require("../shared/localDate");
const imageUpload_1 = require("../shared/imageUpload");
const router = (0, express_1.Router)();
const clockTypes = ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'];
const isClockType = (value) => typeof value === 'string' && clockTypes.includes(value);
const getEntriesForDate = async (userId, timeZone, dateKey) => {
    const now = new Date();
    const todayKey = (0, localDate_1.getDateKey)(now, timeZone);
    const dateStart = new Date(`${dateKey}T00:00:00.000Z`);
    const rangeStart = dateKey === todayKey
        ? new Date(now.getTime() - 48 * 60 * 60 * 1000)
        : new Date(dateStart.getTime() - 36 * 60 * 60 * 1000);
    const rangeEnd = dateKey === todayKey
        ? now
        : new Date(dateStart.getTime() + 60 * 60 * 60 * 1000);
    const entries = await prisma_1.prisma.timeEntry.findMany({
        where: {
            userId,
            timestamp: { gte: rangeStart, lt: rangeEnd },
        },
        orderBy: { timestamp: 'asc' },
        take: 200,
    });
    return entries.filter((entry) => (0, localDate_1.getDateKey)(entry.timestamp, timeZone) === dateKey);
};
const getTodayEntries = async (userId, timeZone) => getEntriesForDate(userId, timeZone, (0, localDate_1.getDateKey)(new Date(), timeZone));
const getTimezone = async (userId) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: userId },
        include: { preference: true },
    });
    return user?.preference?.timezone || auth_1.DEFAULT_TIMEZONE;
};
const nextTypes = {
    NONE: ['CLOCK_IN'],
    CLOCK_IN: ['BREAK_START', 'CLOCK_OUT'],
    BREAK_START: ['BREAK_END'],
    BREAK_END: ['BREAK_START', 'CLOCK_OUT'],
    CLOCK_OUT: [],
};
const snapshot = (entry) => ({
    id: entry.id,
    type: entry.type,
    timestamp: entry.timestamp.toISOString(),
    isManual: entry.isManual,
    notes: entry.notes,
});
router.get('/images/:imageId', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const image = await prisma_1.prisma.imageAttachment.findFirst({
        where: {
            id: String(req.params.imageId),
            timeEntry: { is: { userId: req.user.id } },
        },
        select: { data: true, contentType: true, fileName: true, sizeBytes: true },
    });
    if (!image)
        return res.status(404).json({ message: 'Imagem não encontrada.' });
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', image.sizeBytes);
    res.setHeader('Content-Disposition', `inline; filename="${image.fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(Buffer.from(image.data));
});
router.get('/', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const timeZone = await getTimezone(req.user.id);
    const dateKey = typeof req.query.date === 'string'
        ? req.query.date
        : (0, localDate_1.getDateKey)(new Date(), timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || Number.isNaN(new Date(`${dateKey}T00:00:00Z`).getTime())) {
        return res.status(400).json({ message: 'Data inválida. Use AAAA-MM-DD.' });
    }
    const entries = await getEntriesForDate(req.user.id, timeZone, dateKey);
    const entryIds = entries.map(({ id }) => id);
    const images = entryIds.length ? await prisma_1.prisma.imageAttachment.findMany({
        where: { timeEntryId: { in: entryIds } },
        select: { id: true, timeEntryId: true, fileName: true, contentType: true, sizeBytes: true },
    }) : [];
    return res.json({
        entries: entries.map((entry) => ({
            ...entry,
            images: images.filter((image) => image.timeEntryId === entry.id)
                .map(({ id, fileName, contentType, sizeBytes }) => ({ id, fileName, contentType, sizeBytes })),
        })),
    });
});
router.get('/next', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const timeZone = await getTimezone(req.user.id);
    const entries = await getTodayEntries(req.user.id, timeZone);
    const lastType = entries.at(-1)?.type ?? 'NONE';
    return res.json({ allowedTypes: nextTypes[lastType] ?? [], lastType });
});
router.post('/clock', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const { type } = req.body ?? {};
    if (!isClockType(type)) {
        return res.status(400).json({ message: 'Tipo de marcação inválido.' });
    }
    const timeZone = await getTimezone(req.user.id);
    const entries = await getTodayEntries(req.user.id, timeZone);
    const lastType = entries.at(-1)?.type ?? 'NONE';
    if (!nextTypes[lastType]?.includes(type)) {
        return res.status(409).json({ message: 'Esta marcação não corresponde à próxima etapa da jornada.' });
    }
    const entry = await prisma_1.prisma.timeEntry.create({
        data: { userId: req.user.id, type, timestamp: new Date(), isManual: false },
    });
    return res.status(201).json({ message: 'Ponto registrado com sucesso!', entry });
});
router.post('/', authMiddleware_1.ensureAuthenticated, imageUpload_1.optionalImageUpload, async (req, res) => {
    const { type, timestamp, reason } = req.body ?? {};
    const entryDate = new Date(timestamp);
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!isClockType(type) || !timestamp || Number.isNaN(entryDate.getTime())) {
        return res.status(400).json({ message: 'Tipo de marcação e data/hora válidos são obrigatórios.' });
    }
    if (entryDate.getTime() > Date.now()) {
        return res.status(400).json({ message: 'Uma marcação manual não pode estar no futuro.' });
    }
    if (normalizedReason.length < 3 || normalizedReason.length > 500) {
        return res.status(400).json({ message: 'Informe uma justificativa de 3 a 500 caracteres.' });
    }
    const entry = await prisma_1.prisma.$transaction(async (transaction) => {
        const images = (0, imageUpload_1.uploadedImages)(req);
        const createdEntry = await transaction.timeEntry.create({
            data: {
                userId: req.user.id,
                type,
                timestamp: entryDate,
                isManual: true,
                notes: normalizedReason,
                ...(images.length ? { images: { create: images } } : {}),
            },
            include: { images: { select: { id: true, fileName: true, contentType: true, sizeBytes: true } } },
        });
        await transaction.timeEntryAudit.create({
            data: {
                userId: req.user.id,
                timeEntryId: createdEntry.id,
                action: 'CREATED',
                reason: normalizedReason,
                afterData: snapshot(createdEntry),
            },
        });
        return createdEntry;
    });
    return res.status(201).json({ message: 'Ponto registrado com sucesso!', entry });
});
router.patch('/:id', authMiddleware_1.ensureAuthenticated, imageUpload_1.optionalImageUpload, async (req, res) => {
    const { type, timestamp, reason } = req.body ?? {};
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
    const entryDate = new Date(timestamp);
    if (!isClockType(type) || Number.isNaN(entryDate.getTime())) {
        return res.status(400).json({ message: 'Tipo de marcação e data/hora válidos são obrigatórios.' });
    }
    if (normalizedReason.length < 3 || normalizedReason.length > 500) {
        return res.status(400).json({ message: 'Informe uma justificativa de 3 a 500 caracteres.' });
    }
    const entryId = String(req.params.id);
    try {
        const images = (0, imageUpload_1.uploadedImages)(req);
        const entry = await prisma_1.prisma.$transaction(async (transaction) => {
            const previousEntry = await transaction.timeEntry.findFirst({
                where: { id: entryId, userId: req.user.id },
            });
            if (!previousEntry)
                throw new Error('ENTRY_NOT_FOUND');
            const updatedEntry = await transaction.timeEntry.update({
                where: { id: previousEntry.id },
                data: {
                    type,
                    timestamp: entryDate,
                    isManual: true,
                    notes: normalizedReason,
                    ...(images.length ? { images: { create: images } } : {}),
                },
                include: { images: { select: { id: true, fileName: true, contentType: true, sizeBytes: true } } },
            });
            await transaction.timeEntryAudit.create({
                data: {
                    userId: req.user.id,
                    timeEntryId: updatedEntry.id,
                    action: 'UPDATED',
                    reason: normalizedReason,
                    beforeData: snapshot(previousEntry),
                    afterData: snapshot(updatedEntry),
                },
            });
            return updatedEntry;
        });
        return res.json({ message: 'Marcação atualizada com sucesso.', entry });
    }
    catch (error) {
        if (error instanceof Error && error.message === 'ENTRY_NOT_FOUND') {
            return res.status(404).json({ message: 'Marcação não encontrada.' });
        }
        throw error;
    }
});
router.delete('/:id', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 500) {
        return res.status(400).json({ message: 'Informe uma justificativa de 3 a 500 caracteres.' });
    }
    const entryId = String(req.params.id);
    try {
        await prisma_1.prisma.$transaction(async (transaction) => {
            const entry = await transaction.timeEntry.findFirst({
                where: { id: entryId, userId: req.user.id },
            });
            if (!entry)
                throw new Error('ENTRY_NOT_FOUND');
            await transaction.timeEntryAudit.create({
                data: {
                    userId: req.user.id,
                    action: 'DELETED',
                    reason,
                    beforeData: snapshot(entry),
                },
            });
            await transaction.timeEntry.delete({ where: { id: entry.id } });
        });
        return res.json({ message: 'Marcação excluída e alteração auditada.' });
    }
    catch (error) {
        if (error instanceof Error && error.message === 'ENTRY_NOT_FOUND') {
            return res.status(404).json({ message: 'Marcação não encontrada.' });
        }
        throw error;
    }
});
router.get('/audit', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const audit = await prisma_1.prisma.timeEntryAudit.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
    });
    return res.json({ audit });
});
exports.default = router;
