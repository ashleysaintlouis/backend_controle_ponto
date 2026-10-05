import { Request, Response, Router } from 'express';
import { ensureAuthenticated, type AuthenticatedRequest } from '../auth/authMiddleware';
import { prisma } from '../../lib/prisma';

const router = Router();

router.get('/security', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const requestedLimit = Number(req.query.limit ?? 100);
  const take = Number.isInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
  const events = await prisma.securityEvent.findMany({
    where: {
      OR: [
        { userId: req.user!.id },
        { email: req.user!.email },
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

export default router;
