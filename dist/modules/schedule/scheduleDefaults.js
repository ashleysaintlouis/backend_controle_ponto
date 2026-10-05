"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSchedulePolicy = void 0;
exports.getWeeklySchedule = getWeeklySchedule;
const prisma_1 = require("../../lib/prisma");
const getSchedulePolicy = (userId) => prisma_1.prisma.schedulePolicy.upsert({
    where: { userId },
    create: { userId },
    update: {},
});
exports.getSchedulePolicy = getSchedulePolicy;
async function getWeeklySchedule(userId) {
    const policy = await (0, exports.getSchedulePolicy)(userId);
    const savedDays = await prisma_1.prisma.weeklySchedule.findMany({
        where: { userId },
        select: { dayOfWeek: true },
    });
    const savedDayNumbers = new Set(savedDays.map(({ dayOfWeek }) => dayOfWeek));
    const defaultDays = Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        isWorkday: dayOfWeek >= 1 && dayOfWeek <= 5,
        dailyWorkMinutes: policy.defaultDailyWorkMinutes,
        startTime: '09:00',
        endTime: '18:00',
        breakStart: dayOfWeek >= 1 && dayOfWeek <= 5 ? '12:00' : null,
        breakEnd: dayOfWeek >= 1 && dayOfWeek <= 5 ? '13:00' : null,
        entryToleranceMinutes: policy.entryToleranceMinutes,
        exitToleranceMinutes: policy.exitToleranceMinutes,
        breakStartToleranceMinutes: policy.breakStartToleranceMinutes,
        breakEndToleranceMinutes: policy.breakEndToleranceMinutes,
    }));
    const missingDays = defaultDays
        .filter(({ dayOfWeek }) => !savedDayNumbers.has(dayOfWeek))
        .map((day) => ({ ...day, userId }));
    if (missingDays.length > 0) {
        await prisma_1.prisma.weeklySchedule.createMany({ data: missingDays, skipDuplicates: true });
    }
    const days = await prisma_1.prisma.weeklySchedule.findMany({
        where: { userId },
        include: { periods: { orderBy: { order: 'asc' } } },
        orderBy: { dayOfWeek: 'asc' },
    });
    await Promise.all(days.filter(({ isWorkday, periods }) => isWorkday && !periods.length).map((day) => prisma_1.prisma.weeklySchedulePeriod.create({
        data: {
            weeklyScheduleId: day.id,
            order: 0,
            startTime: day.startTime,
            endTime: day.endTime,
        },
    })));
    return prisma_1.prisma.weeklySchedule.findMany({
        where: { userId },
        include: { periods: { orderBy: { order: 'asc' } } },
        orderBy: { dayOfWeek: 'asc' },
    });
}
