"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const swagger_1 = require("./config/swagger");
const authRoutes = require('./modules/auth/authRoutes').default;
const scheduleRoutes = require('./modules/schedule/scheduleRoutes').default;
const dashboardRoutes = require('./modules/dashboard/dashboardRoutes').default;
const timeEntryRoutes = require('./modules/timeEntries/timeEntryRoutes').default;
const occurrenceRoutes = require('./modules/occurrences/occurrenceRoutes').default;
const overtimeRoutes = require('./modules/overtime/overtimeRoutes').default;
const auditRoutes = require('./modules/audit/auditRoutes').default;
const notificationRoutes = require('./modules/notifications/notificationRoutes').default;
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use((0, cors_1.default)());
app.use('/api-docs', swagger_1.swaggerUiServe, swagger_1.swaggerUiHandler);
app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    return res.send(swagger_1.swaggerSpec);
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
app.get('/health', async (req, res) => {
    return res.status(200).json({
        status: 'ONLINE',
        timestamp: new Date().toISOString(),
        service: 'Sistema de Controle de Ponto API',
    });
});
exports.default = app;
