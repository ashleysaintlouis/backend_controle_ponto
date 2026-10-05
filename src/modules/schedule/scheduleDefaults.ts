import { prisma } from '../../lib/prisma';

export const getSchedulePolicy = (userId: string) => prisma.schedulePolicy.upsert({
  where: { userId },
  create: { userId },
  update: {},
});

export async function getWeeklySchedule(userId: string) {
  const policy = await getSchedulePolicy(userId);
  const savedDays = await prisma.weeklySchedule.findMany({
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
    await prisma.weeklySchedule.createMany({ data: missingDays, skipDuplicates: true });
  }

  const days = await prisma.weeklySchedule.findMany({
    where: { userId },
    include: { periods: { orderBy: { order: 'asc' } } },
    orderBy: { dayOfWeek: 'asc' },
  });

  await Promise.all(days.filter(({ isWorkday, periods }) => isWorkday && !periods.length).map((day) =>
    prisma.weeklySchedulePeriod.create({
      data: {
        weeklyScheduleId: day.id,
        order: 0,
        startTime: day.startTime,
        endTime: day.endTime,
      },
    }),
  ));

  return prisma.weeklySchedule.findMany({
    where: { userId },
    include: { periods: { orderBy: { order: 'asc' } } },
    orderBy: { dayOfWeek: 'asc' },
  });
}