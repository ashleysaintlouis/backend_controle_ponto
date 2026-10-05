"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authMiddleware_1 = require("../auth/authMiddleware");
const scheduleDefaults_1 = require("./scheduleDefaults");
const prisma_1 = require("../../lib/prisma");
const router = (0, express_1.Router)();
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const toMinutes = (time) => {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
};
const getPeriods = (day) => Array.isArray(day.periods) && day.periods.length
    ? day.periods
    : [{ order: 0, startTime: day.startTime, endTime: day.endTime }];
router.get('/settings', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const policy = await (0, scheduleDefaults_1.getSchedulePolicy)(req.user.id);
    return res.json({ policy });
});
router.put('/settings', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const values = req.body ?? {};
    const fields = [
        'defaultDailyWorkMinutes',
        'entryToleranceMinutes',
        'exitToleranceMinutes',
        'breakStartToleranceMinutes',
        'breakEndToleranceMinutes',
    ];
    if (fields.some((field) => !Number.isInteger(values[field]))) {
        return res.status(400).json({ message: 'Informe carga horária e tolerâncias gerais em minutos inteiros.' });
    }
    if (values.defaultDailyWorkMinutes < 1 || values.defaultDailyWorkMinutes > 1440 ||
        fields.slice(1).some((field) => values[field] < 0 || values[field] > 120)) {
        return res.status(400).json({ message: 'Carga diária deve ser até 24 horas e tolerâncias entre 0 e 120 minutos.' });
    }
    const previousPolicy = await (0, scheduleDefaults_1.getSchedulePolicy)(req.user.id);
    const policy = await prisma_1.prisma.schedulePolicy.update({ where: { userId: req.user.id }, data: values });
    await Promise.all([
        prisma_1.prisma.weeklySchedule.updateMany({ where: { userId: req.user.id, dailyWorkMinutes: previousPolicy.defaultDailyWorkMinutes }, data: { dailyWorkMinutes: policy.defaultDailyWorkMinutes } }),
        prisma_1.prisma.weeklySchedule.updateMany({ where: { userId: req.user.id, entryToleranceMinutes: previousPolicy.entryToleranceMinutes }, data: { entryToleranceMinutes: policy.entryToleranceMinutes } }),
        prisma_1.prisma.weeklySchedule.updateMany({ where: { userId: req.user.id, exitToleranceMinutes: previousPolicy.exitToleranceMinutes }, data: { exitToleranceMinutes: policy.exitToleranceMinutes } }),
        prisma_1.prisma.weeklySchedule.updateMany({ where: { userId: req.user.id, breakStartToleranceMinutes: previousPolicy.breakStartToleranceMinutes }, data: { breakStartToleranceMinutes: policy.breakStartToleranceMinutes } }),
        prisma_1.prisma.weeklySchedule.updateMany({ where: { userId: req.user.id, breakEndToleranceMinutes: previousPolicy.breakEndToleranceMinutes }, data: { breakEndToleranceMinutes: policy.breakEndToleranceMinutes } }),
    ]);
    return res.json({ policy });
});
router.get('/', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const days = await (0, scheduleDefaults_1.getWeeklySchedule)(req.user.id);
    return res.json({ days });
});
router.put('/', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const days = req.body?.days;
    if (!Array.isArray(days) || days.length !== 7) {
        return res.status(400).json({ message: 'Informe a configuração dos sete dias da semana.' });
    }
    const seenDays = new Set();
    for (const day of days) {
        const validDayNumber = Number.isInteger(day.dayOfWeek) && day.dayOfWeek >= 0 && day.dayOfWeek <= 6;
        const periods = getPeriods(day).slice().sort((left, right) => left.order - right.order);
        const validPeriods = periods.length > 0 && periods.every((period, index) => period.order === index &&
            timePattern.test(period.startTime) &&
            timePattern.test(period.endTime) &&
            toMinutes(period.endTime) > toMinutes(period.startTime) &&
            (index === 0 || toMinutes(period.startTime) >= toMinutes(periods[index - 1].endTime)));
        const firstPeriod = periods[0];
        const lastPeriod = periods[periods.length - 1];
        const hasBreak = Boolean(day.breakStart) || Boolean(day.breakEnd);
        const validBreak = !hasBreak || (typeof day.breakStart === 'string' &&
            typeof day.breakEnd === 'string' &&
            timePattern.test(day.breakStart) &&
            timePattern.test(day.breakEnd) &&
            toMinutes(day.breakStart) >= toMinutes(firstPeriod.startTime) &&
            toMinutes(day.breakEnd) > toMinutes(day.breakStart) &&
            toMinutes(day.breakEnd) <= toMinutes(lastPeriod.endTime));
        const validTolerances = [
            day.entryToleranceMinutes,
            day.exitToleranceMinutes,
            day.breakStartToleranceMinutes ?? 10,
            day.breakEndToleranceMinutes ?? 10,
        ]
            .every((value) => Number.isInteger(value) && value >= 0 && value <= 120);
        if (!validDayNumber || seenDays.has(day.dayOfWeek) || typeof day.isWorkday !== 'boolean' ||
            !validPeriods || !validBreak || !validTolerances) {
            return res.status(400).json({ message: 'Confira horários, dias e tolerâncias da jornada.' });
        }
        seenDays.add(day.dayOfWeek);
    }
    const savedDays = await Promise.all(days.map(async (day) => {
        const periods = getPeriods(day).slice().sort((left, right) => left.order - right.order);
        const firstPeriod = periods[0];
        const lastPeriod = periods[periods.length - 1];
        const savedDay = await prisma_1.prisma.weeklySchedule.upsert({
            where: { userId_dayOfWeek: { userId: req.user.id, dayOfWeek: day.dayOfWeek } },
            create: {
                userId: req.user.id,
                dayOfWeek: day.dayOfWeek,
                isWorkday: day.isWorkday,
                dailyWorkMinutes: day.dailyWorkMinutes ?? (await (0, scheduleDefaults_1.getSchedulePolicy)(req.user.id)).defaultDailyWorkMinutes,
                startTime: firstPeriod.startTime,
                endTime: lastPeriod.endTime,
                breakStart: day.breakStart || null,
                breakEnd: day.breakEnd || null,
                entryToleranceMinutes: day.entryToleranceMinutes,
                exitToleranceMinutes: day.exitToleranceMinutes,
                breakStartToleranceMinutes: day.breakStartToleranceMinutes ?? 10,
                breakEndToleranceMinutes: day.breakEndToleranceMinutes ?? 10,
            },
            update: {
                isWorkday: day.isWorkday,
                dailyWorkMinutes: day.dailyWorkMinutes ?? undefined,
                startTime: firstPeriod.startTime,
                endTime: lastPeriod.endTime,
                breakStart: day.breakStart || null,
                breakEnd: day.breakEnd || null,
                entryToleranceMinutes: day.entryToleranceMinutes,
                exitToleranceMinutes: day.exitToleranceMinutes,
                breakStartToleranceMinutes: day.breakStartToleranceMinutes ?? 10,
                breakEndToleranceMinutes: day.breakEndToleranceMinutes ?? 10,
            },
        });
        await prisma_1.prisma.$transaction([
            prisma_1.prisma.weeklySchedulePeriod.deleteMany({ where: { weeklyScheduleId: savedDay.id } }),
            ...(day.isWorkday ? [prisma_1.prisma.weeklySchedulePeriod.createMany({
                    data: periods.map((period) => ({ ...period, weeklyScheduleId: savedDay.id })),
                })] : []),
        ]);
        return savedDay;
    }));
    const savedWithPeriods = await prisma_1.prisma.weeklySchedule.findMany({
        where: { userId: req.user.id },
        include: { periods: { orderBy: { order: 'asc' } } },
        orderBy: { dayOfWeek: 'asc' },
    });
    return res.json({ days: savedWithPeriods });
});
const exceptionTypes = ['HOLIDAY', 'DAY_OFF', 'WORKDAY_OVERRIDE'];
router.get('/exceptions', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ message: 'Informe o mês no formato AAAA-MM.' });
    }
    const startDate = new Date(`${month}-01T00:00:00.000Z`);
    const endDate = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1));
    const exceptions = await prisma_1.prisma.scheduleException.findMany({
        where: { userId: req.user.id, date: { gte: startDate, lt: endDate } },
        orderBy: { date: 'asc' },
    });
    return res.json({ exceptions });
});
router.post('/exceptions', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const { date, type, note, startTime, endTime } = req.body ?? {};
    const dayDate = new Date(`${date}T00:00:00.000Z`);
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(dayDate.getTime())) {
        return res.status(400).json({ message: 'Data da exceção inválida.' });
    }
    if (!exceptionTypes.includes(type)) {
        return res.status(400).json({ message: 'Tipo de exceção inválido.' });
    }
    if (note && (typeof note !== 'string' || note.trim().length > 300)) {
        return res.status(400).json({ message: 'A descrição deve ter até 300 caracteres.' });
    }
    if (type === 'WORKDAY_OVERRIDE' && (typeof startTime !== 'string' || typeof endTime !== 'string' ||
        !timePattern.test(startTime) || !timePattern.test(endTime) ||
        toMinutes(endTime) <= toMinutes(startTime))) {
        return res.status(400).json({ message: 'Informe entrada e saída válidas para a jornada excepcional.' });
    }
    const exception = await prisma_1.prisma.scheduleException.upsert({
        where: { userId_date: { userId: req.user.id, date: dayDate } },
        create: {
            userId: req.user.id,
            date: dayDate,
            type,
            note: typeof note === 'string' ? note.trim() || null : null,
            startTime: type === 'WORKDAY_OVERRIDE' ? startTime : null,
            endTime: type === 'WORKDAY_OVERRIDE' ? endTime : null,
        },
        update: {
            type,
            note: typeof note === 'string' ? note.trim() || null : null,
            startTime: type === 'WORKDAY_OVERRIDE' ? startTime : null,
            endTime: type === 'WORKDAY_OVERRIDE' ? endTime : null,
        },
    });
    return res.status(201).json({ exception });
});
router.delete('/exceptions/:id', authMiddleware_1.ensureAuthenticated, async (req, res) => {
    const deleted = await prisma_1.prisma.scheduleException.deleteMany({
        where: { id: String(req.params.id), userId: req.user.id },
    });
    if (!deleted.count)
        return res.status(404).json({ message: 'Exceção não encontrada.' });
    return res.json({ message: 'Exceção removida.' });
});
exports.default = router;
