"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authMiddleware_1 = require("../auth/authMiddleware");
const auth_1 = require("../../config/auth");
const prisma_1 = require("../../lib/prisma");
const localDate_1 = require("../shared/localDate");
const imageUpload_1 = require("../shared/imageUpload");
const router = (0, express_1.Router)();
const occurrenceTypes = ['PERSONAL_WITH_RETURN', 'PERSONAL_WITHOUT_RETURN', 'COMPANY_ACTIVITY'];
const isOccurrenceType = (value) => typeof value === 'string' && occurrenceTypes.includes(value);
const parseOccurrence = (body) => {
    const type = body?.type;
    const startAt = new Date(body?.startAt);
    const endAt = body?.endAt ? new Date(body.endAt) : null;
    const notes = typeof body?.notes === 'string' ? body.notes.trim() : '';
    if (!isOccurrenceType(type) || Number.isNaN(startAt.getTime())) {
        return { error: 'Tipo e horário de início válidos são obrigatórios.' };
    }
    if (notes.length < 3 || notes.length > 500) {
        return { error: 'Descreva a ocorrência em 3 a 500 caracteres.' };
    }
    if (type === 'PERSONAL_WITHOUT_RETURN' && endAt) {
        return { error: 'Atividade pessoal sem retorno não deve informar horário de retorno.' };
    }
    if (type !== 'PERSONAL_WITHOUT_RETURN' && (!endAt || Number.isNaN(endAt.getTime()))) {
        return { error: 'Informe o horário de retorno ou término da atividade.' };
    }
    if (endAt && endAt < startAt) {
        return { error: 'O horário de retorno não pode ser anterior ao horário de saída da atividade.' };
    }
    return { value: { type, startAt, endAt, notes } };
};
const getTimezone = async (userId) => {
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: userId },
        include: { preference: true },
    });
    return user?.preference?.timezone || auth_1.DEFAULT_TIMEZONE;
};
router.get('/images/:imageId', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const image = await prisma_1.prisma.imageAttachment.findFirst({
        where: {
            id: String(req.params.imageId),
            occurrence: { is: { userId: req.user.id } },
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
    const date = typeof req.query.date === 'string' ? req.query.date : (0, localDate_1.getDateKey)(new Date(), timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ message: 'Data inválida. Use AAAA-MM-DD.' });
    }
    const occurrences = await prisma_1.prisma.occurrence.findMany({
        where: {
            userId: req.user.id,
            startAt: { gte: new Date(Date.now() - 370 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { startAt: 'asc' },
        take: 1000,
        include: { images: { select: { id: true, fileName: true, contentType: true, sizeBytes: true } } },
    });
    return res.json({ occurrences: occurrences.filter((item) => (0, localDate_1.getDateKey)(item.startAt, timeZone) === date) });
});
router.post('/', authMiddleware_1.ensureAuthenticated, imageUpload_1.optionalImageUpload, async (req, res) => {
    const parsed = parseOccurrence(req.body);
    if ('error' in parsed)
        return res.status(400).json({ message: parsed.error });
    const images = (0, imageUpload_1.uploadedImages)(req);
    const occurrence = await prisma_1.prisma.occurrence.create({
        data: {
            ...parsed.value,
            userId: req.user.id,
            ...(images.length ? { images: { create: images } } : {}),
        },
        include: { images: { select: { id: true, fileName: true, contentType: true, sizeBytes: true } } },
    });
    return res.status(201).json({ message: 'Ocorrência registrada com sucesso.', occurrence });
});
router.patch('/:id', authMiddleware_1.ensureAuthenticated, imageUpload_1.optionalImageUpload, async (req, res) => {
    const parsed = parseOccurrence(req.body);
    if ('error' in parsed)
        return res.status(400).json({ message: parsed.error });
    const occurrenceId = String(req.params.id);
    const existing = await prisma_1.prisma.occurrence.findFirst({
        where: { id: occurrenceId, userId: req.user.id },
    });
    if (!existing)
        return res.status(404).json({ message: 'Ocorrência não encontrada.' });
    const images = (0, imageUpload_1.uploadedImages)(req);
    const occurrence = await prisma_1.prisma.occurrence.update({
        where: { id: existing.id },
        data: {
            ...parsed.value,
            ...(images.length ? { images: { create: images } } : {}),
        },
        include: { images: { select: { id: true, fileName: true, contentType: true, sizeBytes: true } } },
    });
    return res.json({ message: 'Ocorrência atualizada com sucesso.', occurrence });
});
router.delete('/:id', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const occurrenceId = String(req.params.id);
    const result = await prisma_1.prisma.occurrence.deleteMany({
        where: { id: occurrenceId, userId: req.user.id },
    });
    if (result.count === 0)
        return res.status(404).json({ message: 'Ocorrência não encontrada.' });
    return res.json({ message: 'Ocorrência excluída.' });
});
exports.default = router;
