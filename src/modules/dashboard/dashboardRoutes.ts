import { Request, Response, Router } from 'express';
import { ensureAuthenticated, type AuthenticatedRequest } from '../auth/authMiddleware';
import { DEFAULT_TIMEZONE } from '../../config/auth';
import { prisma } from '../../lib/prisma';
import { getWeeklySchedule } from '../schedule/scheduleDefaults';
import { sendSystemNotificationEmail } from '../../config/mailer';
import {
  applyScheduleTolerance,
  getIntervalMinutes,
  getOverlapMinutes,
  getZonedDateTime,
  mergeTimeIntervals,
} from '../shared/localDate';

const router = Router();
const weekdayNumbers: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const getZonedParts = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
};

router.get('/today', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: { preference: true },
  });

  if (!user) {
    return res.status(404).json({ message: 'Usuário não encontrado.' });
  }

  let timeZone = user.preference?.timezone || DEFAULT_TIMEZONE;
  let parts: Record<string, string>;
  try {
    parts = getZonedParts(new Date(), timeZone);
  } catch (error) {
    timeZone = DEFAULT_TIMEZONE;
    parts = getZonedParts(new Date(), timeZone);
  }

  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const dayName = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date());
  const dayOfWeek = weekdayNumbers[dayName];
  const schedules = await getWeeklySchedule(user.id);
  const baseSchedule = schedules.find((day) => day.dayOfWeek === dayOfWeek)!;
  const dayDate = new Date(`${today}T00:00:00.000Z`);
  const exception = await prisma.scheduleException.findUnique({
    where: { userId_date: { userId: user.id, date: dayDate } },
  });
  const schedule = {
    ...baseSchedule,
    isWorkday: exception?.type === 'WORKDAY_OVERRIDE'
      ? true
      : exception?.type === 'HOLIDAY' || exception?.type === 'DAY_OFF'
        ? false
        : baseSchedule.isWorkday,
    startTime: exception?.type === 'WORKDAY_OVERRIDE' && exception.startTime
      ? exception.startTime
      : baseSchedule.periods[0]?.startTime ?? baseSchedule.startTime,
    endTime: exception?.type === 'WORKDAY_OVERRIDE' && exception.endTime
      ? exception.endTime
      : baseSchedule.periods.at(-1)?.endTime ?? baseSchedule.endTime,
    periods: exception?.type === 'WORKDAY_OVERRIDE' && exception.startTime && exception.endTime
      ? [{ order: 0, startTime: exception.startTime, endTime: exception.endTime }]
      : baseSchedule.periods.length
        ? baseSchedule.periods
        : [{ order: 0, startTime: baseSchedule.startTime, endTime: baseSchedule.endTime }],
  };
  const now = new Date();
  const recentEntries = await prisma.timeEntry.findMany({
    where: {
      userId: user.id,
      timestamp: { gte: new Date(now.getTime() - 36 * 60 * 60 * 1000) },
    },
    orderBy: { timestamp: 'asc' },
    take: 100,
  });
  const entries = recentEntries
    .filter((entry) => {
      const entryParts = getZonedParts(entry.timestamp, timeZone);
      return `${entryParts.year}-${entryParts.month}-${entryParts.day}` === today;
    })
    .map((entry) => {
      const entryParts = getZonedParts(entry.timestamp, timeZone);
      return {
        id: entry.id,
        type: entry.type,
        time: `${entryParts.hour}:${entryParts.minute}`,
        timestamp: entry.timestamp,
        notes: entry.notes,
      };
    });

  const recentOccurrences = await prisma.occurrence.findMany({
    where: {
      userId: user.id,
      startAt: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000) },
    },
    orderBy: { startAt: 'asc' },
    take: 100,
  });
  const occurrences = recentOccurrences
    .filter((occurrence) => {
      const occurrenceParts = getZonedParts(occurrence.startAt, timeZone);
      return `${occurrenceParts.year}-${occurrenceParts.month}-${occurrenceParts.day}` === today;
    })
    .map((occurrence) => ({
      id: occurrence.id,
      type: occurrence.type,
      startAt: occurrence.startAt,
      endAt: occurrence.endAt,
      notes: occurrence.notes,
    }));

  const breakMinutes = schedule.breakStart && schedule.breakEnd
    ? (Number(schedule.breakEnd.slice(0, 2)) * 60 + Number(schedule.breakEnd.slice(3))) -
      (Number(schedule.breakStart.slice(0, 2)) * 60 + Number(schedule.breakStart.slice(3)))
    : 0;
  const plannedMinutes = schedule.isWorkday
    ? schedule.dailyWorkMinutes ?? Math.max(0, schedule.periods.reduce((total, period) => total +
      (Number(period.endTime.slice(0, 2)) * 60 + Number(period.endTime.slice(3))) -
      (Number(period.startTime.slice(0, 2)) * 60 + Number(period.startTime.slice(3))), 0) - breakMinutes)
    : 0;

  let openPeriod: Date | null = null;
  const workIntervals: Array<{ start: Date; end: Date }> = [];
  for (const entry of recentEntries.filter((item) => entries.some(({ id }) => id === item.id))) {
    const punchTime = applyScheduleTolerance(entry.type, entry.timestamp, today, timeZone, schedule);
    if (entry.type === 'CLOCK_IN' || entry.type === 'BREAK_END') {
      openPeriod = punchTime;
    } else if ((entry.type === 'BREAK_START' || entry.type === 'CLOCK_OUT') && openPeriod) {
      workIntervals.push({ start: openPeriod, end: punchTime });
      openPeriod = null;
    }
  }
  if (openPeriod) {
    workIntervals.push({ start: openPeriod, end: now });
  }

  const companyIntervals = occurrences
    .filter((occurrence) => occurrence.type === 'COMPANY_ACTIVITY' && occurrence.endAt)
    .map((occurrence) => ({
      start: occurrence.startAt,
      end: occurrence.endAt! > now ? now : occurrence.endAt!,
    }));
  const mergedWorkIntervals = mergeTimeIntervals([...workIntervals, ...companyIntervals]);
  const personalIntervals = mergeTimeIntervals(occurrences
    .filter((occurrence) => occurrence.type.startsWith('PERSONAL'))
    .map((occurrence) => ({
      start: occurrence.startAt,
      end: occurrence.endAt ?? getZonedDateTime(today, schedule.endTime, timeZone),
    })));
  const grossWorkedMinutes = mergedWorkIntervals.reduce((total, interval) => total + getIntervalMinutes(interval), 0);
  const personalAbsenceMinutes = personalIntervals.reduce(
    (total, interval) => total + getOverlapMinutes(interval, mergedWorkIntervals),
    0,
  );
  const workedMinutes = Math.max(0, grossWorkedMinutes - personalAbsenceMinutes);

  const clockIn = entries.find((entry) => entry.type === 'CLOCK_IN');
  const clockOut = entries.find((entry) => entry.type === 'CLOCK_OUT');
  let status = 'DAY_OFF';
  let statusMessage = 'Sem jornada prevista para hoje.';

  if (schedule.isWorkday) {
    const lastEntry = entries.at(-1);
    if (clockOut) {
      status = 'COMPLETED';
      statusMessage = 'Jornada encerrada.';
    } else if (clockIn) {
      const actualStart = Number(clockIn.time.slice(0, 2)) * 60 + Number(clockIn.time.slice(3));
      const plannedStart = Number(schedule.startTime.slice(0, 2)) * 60 + Number(schedule.startTime.slice(3));
      const lateMinutes = actualStart - plannedStart - schedule.entryToleranceMinutes;
      if (lastEntry?.type === 'BREAK_START') {
        status = 'ON_BREAK';
        statusMessage = 'Intervalo em andamento.';
      } else {
        status = 'IN_PROGRESS';
        statusMessage = lateMinutes > 0
          ? `Jornada iniciada com ${lateMinutes} min de atraso.`
          : 'Jornada iniciada dentro da tolerância.';
      }
    } else {
      const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
      const plannedStart = Number(schedule.startTime.slice(0, 2)) * 60 + Number(schedule.startTime.slice(3));
      status = currentMinutes >= plannedStart ? 'MISSING_CLOCK_IN' : 'UPCOMING';
      statusMessage = status === 'UPCOMING'
        ? `Entrada prevista às ${schedule.startTime}.`
        : `Entrada prevista às ${schedule.startTime} ainda não registrada.`;
    }
  }

  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const expectedEnd = Number(schedule.endTime.slice(0, 2)) * 60 + Number(schedule.endTime.slice(3));
  let notificationType: 'MISSED_CLOCK_IN' | 'CLOCK_OUT_REMINDER' | 'TOLERANCE_EXCEEDED' | null = null;
  let notificationMessage = '';
  if (status === 'MISSING_CLOCK_IN') {
    notificationType = 'MISSED_CLOCK_IN';
    notificationMessage = `A entrada prevista para ${schedule.startTime} ainda não foi registrada.`;
  } else if (status === 'IN_PROGRESS' && statusMessage.includes('atraso')) {
    notificationType = 'TOLERANCE_EXCEEDED';
    notificationMessage = statusMessage;
  } else if (status === 'IN_PROGRESS' && currentMinutes > expectedEnd + schedule.exitToleranceMinutes) {
    notificationType = 'CLOCK_OUT_REMINDER';
    notificationMessage = `O expediente previsto terminou às ${schedule.endTime}. Registre a saída quando concluir.`;
  }

  if (notificationType) {
    const notification = await prisma.notification.upsert({
      where: { dedupeKey: `${user.id}:${today}:${notificationType}` },
      create: {
        userId: user.id,
        type: notificationType,
        status: 'PENDING',
        message: notificationMessage,
        scheduledAt: now,
        dedupeKey: `${user.id}:${today}:${notificationType}`,
      },
      update: {},
    });

    if (notification.status === 'PENDING') {
      const claim = await prisma.notification.updateMany({
        where: { id: notification.id, status: 'PENDING' },
        data: { status: 'SENDING' },
      });
      if (claim.count) {
        try {
          await sendSystemNotificationEmail(user.email, user.name, notification.message);
          await prisma.notification.update({
            where: { id: notification.id },
            data: { status: 'SENT', sentAt: new Date() },
          });
        } catch (error) {
          console.error('[notification] Falha ao enviar alerta operacional.');
          await prisma.notification.update({
            where: { id: notification.id },
            data: { status: 'FAILED' },
          });
        }
      }
    }
  }
  const notifications = await prisma.notification.findMany({
    where: { userId: user.id, scheduledAt: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000) } },
    orderBy: { scheduledAt: 'desc' },
    take: 20,
  });

  return res.json({
    date: today,
    weekday: new Intl.DateTimeFormat('pt-BR', { timeZone, weekday: 'long' }).format(now),
    status,
    statusMessage,
    schedule,
    exception: exception ? { type: exception.type, note: exception.note } : null,
    plannedMinutes,
    workedMinutes,
    entries,
    occurrences,
    notifications,
  });
});

export default router;