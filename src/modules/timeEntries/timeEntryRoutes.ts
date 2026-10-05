import { Request, Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { ensureAuthenticated, type AuthenticatedRequest } from '../auth/authMiddleware';
import { DEFAULT_TIMEZONE } from '../../config/auth';
import { prisma } from '../../lib/prisma';
import { getDateKey } from '../shared/localDate';
import { optionalImageUpload, uploadedImages } from '../shared/imageUpload';

const router = Router();
const clockTypes = ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'] as const;
type ClockType = (typeof clockTypes)[number];
const isClockType = (value: unknown): value is ClockType =>
  typeof value === 'string' && clockTypes.includes(value as ClockType);

const getEntriesForDate = async (userId: string, timeZone: string, dateKey: string) => {
  const now = new Date();
  const todayKey = getDateKey(now, timeZone);
  const dateStart = new Date(`${dateKey}T00:00:00.000Z`);
  const rangeStart = dateKey === todayKey
    ? new Date(now.getTime() - 48 * 60 * 60 * 1000)
    : new Date(dateStart.getTime() - 36 * 60 * 60 * 1000);
  const rangeEnd = dateKey === todayKey
    ? now
    : new Date(dateStart.getTime() + 60 * 60 * 60 * 1000);
  const entries = await prisma.timeEntry.findMany({
    where: {
      userId,
      timestamp: { gte: rangeStart, lt: rangeEnd },
    },
    orderBy: { timestamp: 'asc' },
    take: 200,
  });
  return entries.filter((entry) => getDateKey(entry.timestamp, timeZone) === dateKey);
};

const getTodayEntries = async (userId: string, timeZone: string) =>
  getEntriesForDate(userId, timeZone, getDateKey(new Date(), timeZone));

const getTimezone = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { preference: true },
  });
  return user?.preference?.timezone || DEFAULT_TIMEZONE;
};

const nextTypes: Record<string, ClockType[]> = {
  NONE: ['CLOCK_IN'],
  CLOCK_IN: ['BREAK_START', 'CLOCK_OUT'],
  BREAK_START: ['BREAK_END'],
  BREAK_END: ['BREAK_START', 'CLOCK_OUT'],
  CLOCK_OUT: [],
};

const snapshot = (entry: {
  id: string;
  type: string;
  timestamp: Date;
  isManual: boolean;
  notes: string | null;
}) => ({
  id: entry.id,
  type: entry.type,
  timestamp: entry.timestamp.toISOString(),
  isManual: entry.isManual,
  notes: entry.notes,
});

router.get('/images/:imageId', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const image = await prisma.imageAttachment.findFirst({
    where: {
      id: String(req.params.imageId),
      timeEntry: { is: { userId: req.user!.id } },
    },
    select: { data: true, contentType: true, fileName: true, sizeBytes: true },
  });
  if (!image) return res.status(404).json({ message: 'Imagem não encontrada.' });
  res.setHeader('Content-Type', image.contentType);
  res.setHeader('Content-Length', image.sizeBytes);
  res.setHeader('Content-Disposition', `inline; filename="${image.fileName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(Buffer.from(image.data));
});

router.get('/', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const timeZone = await getTimezone(req.user!.id);
  const dateKey = typeof req.query.date === 'string'
    ? req.query.date
    : getDateKey(new Date(), timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || Number.isNaN(new Date(`${dateKey}T00:00:00Z`).getTime())) {
    return res.status(400).json({ message: 'Data inválida. Use AAAA-MM-DD.' });
  }
  const entries = await getEntriesForDate(req.user!.id, timeZone, dateKey);
  const entryIds = entries.map(({ id }) => id);
  const images = entryIds.length ? await prisma.imageAttachment.findMany({
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

router.get('/next', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const timeZone = await getTimezone(req.user!.id);
  const entries = await getTodayEntries(req.user!.id, timeZone);
  const lastType = entries.at(-1)?.type ?? 'NONE';
  return res.json({ allowedTypes: nextTypes[lastType] ?? [], lastType });
});

router.post('/clock', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const { type } = req.body ?? {};
  if (!isClockType(type)) {
    return res.status(400).json({ message: 'Tipo de marcação inválido.' });
  }

  const timeZone = await getTimezone(req.user!.id);
  const entries = await getTodayEntries(req.user!.id, timeZone);
  const lastType = entries.at(-1)?.type ?? 'NONE';
  if (!nextTypes[lastType]?.includes(type)) {
    return res.status(409).json({ message: 'Esta marcação não corresponde à próxima etapa da jornada.' });
  }

  const entry = await prisma.timeEntry.create({
    data: { userId: req.user!.id, type, timestamp: new Date(), isManual: false },
  });
  return res.status(201).json({ message: 'Ponto registrado com sucesso!', entry });
});

router.post('/', ensureAuthenticated, optionalImageUpload, async (req: AuthenticatedRequest, res: Response) => {
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

  const entry = await prisma.$transaction(async (transaction) => {
    const images = uploadedImages(req);
    const createdEntry = await transaction.timeEntry.create({
      data: {
        userId: req.user!.id,
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
        userId: req.user!.id,
        timeEntryId: createdEntry.id,
        action: 'CREATED',
        reason: normalizedReason,
        afterData: snapshot(createdEntry) as Prisma.InputJsonValue,
      },
    });
    return createdEntry;
  });

  return res.status(201).json({ message: 'Ponto registrado com sucesso!', entry });
});

router.patch('/:id', ensureAuthenticated, optionalImageUpload, async (req: AuthenticatedRequest, res: Response) => {
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
    const images = uploadedImages(req);
    const entry = await prisma.$transaction(async (transaction) => {
      const previousEntry = await transaction.timeEntry.findFirst({
        where: { id: entryId, userId: req.user!.id },
      });
      if (!previousEntry) throw new Error('ENTRY_NOT_FOUND');
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
          userId: req.user!.id,
          timeEntryId: updatedEntry.id,
          action: 'UPDATED',
          reason: normalizedReason,
          beforeData: snapshot(previousEntry) as Prisma.InputJsonValue,
          afterData: snapshot(updatedEntry) as Prisma.InputJsonValue,
        },
      });
      return updatedEntry;
    });
    return res.json({ message: 'Marcação atualizada com sucesso.', entry });
  } catch (error) {
    if (error instanceof Error && error.message === 'ENTRY_NOT_FOUND') {
      return res.status(404).json({ message: 'Marcação não encontrada.' });
    }
    throw error;
  }
});

router.delete('/:id', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 500) {
    return res.status(400).json({ message: 'Informe uma justificativa de 3 a 500 caracteres.' });
  }
  const entryId = String(req.params.id);

  try {
    await prisma.$transaction(async (transaction) => {
      const entry = await transaction.timeEntry.findFirst({
        where: { id: entryId, userId: req.user!.id },
      });
      if (!entry) throw new Error('ENTRY_NOT_FOUND');
      await transaction.timeEntryAudit.create({
        data: {
          userId: req.user!.id,
          action: 'DELETED',
          reason,
          beforeData: snapshot(entry) as Prisma.InputJsonValue,
        },
      });
      await transaction.timeEntry.delete({ where: { id: entry.id } });
    });
    return res.json({ message: 'Marcação excluída e alteração auditada.' });
  } catch (error) {
    if (error instanceof Error && error.message === 'ENTRY_NOT_FOUND') {
      return res.status(404).json({ message: 'Marcação não encontrada.' });
    }
    throw error;
  }
});

router.get('/audit', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const audit = await prisma.timeEntryAudit.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return res.json({ audit });
});

export default router;