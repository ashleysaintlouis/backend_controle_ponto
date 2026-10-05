import { Request } from 'express';
import { SecurityEventType } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export async function recordSecurityEvent(
  req: Request,
  email: string,
  type: SecurityEventType,
  userId?: string,
): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        email: email.trim().toLowerCase().slice(0, 255),
        type,
        userId,
        ipAddress: req.ip?.slice(0, 64),
        userAgent: req.get('user-agent')?.slice(0, 500),
      },
    });
  } catch (error) {
    console.error('[audit] Não foi possível gravar evento de segurança.');
  }
}