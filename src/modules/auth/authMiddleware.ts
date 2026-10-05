import jwt from 'jsonwebtoken';
import { NextFunction, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { JWT_SECRET } from '../../config/auth';

export type AuthenticatedRequest = Request & {
  user?: {
    id: string;
    email: string;
  };
};

export const ensureAuthenticated = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  const authorizationHeader = req.headers.authorization;

  if (!authorizationHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token de autenticação ausente.' });
  }

  try {
    const payload = jwt.verify(authorizationHeader.slice(7), JWT_SECRET) as { sub: string };
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });

    if (!user) {
      return res.status(401).json({ message: 'Usuário não encontrado.' });
    }

    req.user = { id: user.id, email: user.email };
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Token inválido ou expirado.' });
  }
};