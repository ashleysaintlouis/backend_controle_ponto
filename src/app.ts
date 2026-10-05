import dotenv from 'dotenv';

dotenv.config();

import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import { swaggerSpec, swaggerUiHandler, swaggerUiServe } from './config/swagger';

const authRoutes = require('./modules/auth/authRoutes').default as any;
const scheduleRoutes = require('./modules/schedule/scheduleRoutes').default as any;
const dashboardRoutes = require('./modules/dashboard/dashboardRoutes').default as any;
const timeEntryRoutes = require('./modules/timeEntries/timeEntryRoutes').default as any;
const occurrenceRoutes = require('./modules/occurrences/occurrenceRoutes').default as any;
const overtimeRoutes = require('./modules/overtime/overtimeRoutes').default as any;
const auditRoutes = require('./modules/audit/auditRoutes').default as any;
const notificationRoutes = require('./modules/notifications/notificationRoutes').default as any;

const app: Application = express();

app.use(express.json());
app.use(cors());

app.use('/api-docs', swaggerUiServe, swaggerUiHandler);
app.get('/api-docs.json', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  return res.send(swaggerSpec);
});

app.use('/api/auth', authRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/time-entries', timeEntryRoutes);
app.use('/api/occurrences', occurrenceRoutes);
app.use('/api/overtime', overtimeRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/notifications', notificationRoutes);

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check da API
 *     tags: [Sistema]
 *     responses:
 *       200:
 *         description: API online
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                 service:
 *                   type: string
 */
app.get('/health', async (req: Request, res: Response) => {
  return res.status(200).json({
    status: 'ONLINE',
    timestamp: new Date().toISOString(),
    service: 'Sistema de Controle de Ponto API',
  });
});

export default app;