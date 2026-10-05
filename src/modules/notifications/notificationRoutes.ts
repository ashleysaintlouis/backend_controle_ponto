import { Request, Response, Router } from 'express';
import { ensureAuthenticated, type AuthenticatedRequest } from '../auth/authMiddleware';
import { prisma } from '../../lib/prisma';

const router = Router();

router.get('/', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { scheduledAt: 'desc' },
    take: 100,
  });
  return res.json({ notifications });
});

router.patch('/:id/read', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const updated = await prisma.notification.updateMany({
    where: { id: String(req.params.id), userId: req.user!.id },
    data: { status: 'READ', readAt: new Date() },
  });
  if (!updated.count) return res.status(404).json({ message: 'Notificação não encontrada.' });
  return res.json({ message: 'Notificação marcada como lida.' });
});

export default router;
