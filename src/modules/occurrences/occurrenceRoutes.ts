import { Request, Response, Router } from 'express';
import { ensureAuthenticated, type AuthenticatedRequest } from '../auth/authMiddleware';
import { DEFAULT_TIMEZONE } from '../../config/auth';
import { prisma } from '../../lib/prisma';
import { getDateKey } from '../shared/localDate';
import { optionalImageUpload, uploadedImages } from '../shared/imageUpload';

const router = Router();
const occurrenceTypes = ['PERSONAL_WITH_RETURN', 'PERSONAL_WITHOUT_RETURN', 'COMPANY_ACTIVITY'] as const;
type OccurrenceType = (typeof occurrenceTypes)[number];
const isOccurrenceType = (value: unknown): value is OccurrenceType =>
  typeof value === 'string' && occurrenceTypes.includes(value as OccurrenceType);

const parseOccurrence = (body: any) => {
  const type = body?.type;
  const startAt = new Date(body?.startAt);
  const endAt = body?.endAt ? new Date(body.endAt) : null;
  const notes = typeof body?.notes === 'string' ? body.notes.trim() : '';

  if (!isOccurrenceType(type) || Number.isNaN(startAt.getTime())) {
    return { error: 'Tipo e horário de início válidos são obrigatórios.' } as const;
  }
  if (notes.length < 3 || notes.length > 500) {
    return { error: 'Descreva a ocorrência em 3 a 500 caracteres.' } as const;
  }
  if (type === 'PERSONAL_WITHOUT_RETURN' && endAt) {
    return { error: 'Atividade pessoal sem retorno não deve informar horário de retorno.' } as const;
  }
  if (type !== 'PERSONAL_WITHOUT_RETURN' && (!endAt || Number.isNaN(endAt.getTime()))) {
    return { error: 'Informe o horário de retorno ou término da atividade.' } as const;
  }
  if (endAt && endAt < startAt) {
    return { error: 'O horário de retorno não pode ser anterior ao horário de saída da atividade.' } as const;
  }

  return { value: { type, startAt, endAt, notes } } as const;
};

const getTimezone = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { preference: true },
  });
  return user?.preference?.timezone || DEFAULT_TIMEZONE;
};

router.get('/images/:imageId', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const image = await prisma.imageAttachment.findFirst({
    where: {
      id: String(req.params.imageId),
      occurrence: { is: { userId: req.user!.id } },
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
  const date = typeof req.query.date === 'string' ? req.query.date : getDateKey(new Date(), timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: 'Data inválida. Use AAAA-MM-DD.' });
  }

  const occurrences = await prisma.occurrence.findMany({
    where: {
      userId: req.user!.id,
      startAt: { gte: new Date(Date.now() - 370 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { startAt: 'asc' },
    take: 1000,
    include: { images: { select: { id: true, fileName: true, contentType: true, sizeBytes: true } } },
  });
  return res.json({ occurrences: occurrences.filter((item) => getDateKey(item.startAt, timeZone) === date) });
});

router.post('/', ensureAuthenticated, optionalImageUpload, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = parseOccurrence(req.body);
  if ('error' in parsed) return res.status(400).json({ message: parsed.error });
  const images = uploadedImages(req);

  const occurrence = await prisma.occurrence.create({
    data: {
      ...parsed.value,
      userId: req.user!.id,
      ...(images.length ? { images: { create: images } } : {}),
    },
    include: { images: { select: { id: true, fileName: true, contentType: true, sizeBytes: true } } },
  });
  return res.status(201).json({ message: 'Ocorrência registrada com sucesso.', occurrence });
});

router.patch('/:id', ensureAuthenticated, optionalImageUpload, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = parseOccurrence(req.body);
  if ('error' in parsed) return res.status(400).json({ message: parsed.error });
  const occurrenceId = String(req.params.id);

  const existing = await prisma.occurrence.findFirst({
    where: { id: occurrenceId, userId: req.user!.id },
  });
  if (!existing) return res.status(404).json({ message: 'Ocorrência não encontrada.' });

  const images = uploadedImages(req);
  const occurrence = await prisma.occurrence.update({
    where: { id: existing.id },
    data: {
      ...parsed.value,
      ...(images.length ? { images: { create: images } } : {}),
    },
    include: { images: { select: { id: true, fileName: true, contentType: true, sizeBytes: true } } },
  });
  return res.json({ message: 'Ocorrência atualizada com sucesso.', occurrence });
});

router.delete('/:id', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const occurrenceId = String(req.params.id);
  const result = await prisma.occurrence.deleteMany({
    where: { id: occurrenceId, userId: req.user!.id },
  });
  if (result.count === 0) return res.status(404).json({ message: 'Ocorrência não encontrada.' });
  return res.json({ message: 'Ocorrência excluída.' });
});

export default router;