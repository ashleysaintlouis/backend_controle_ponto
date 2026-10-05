import { Request, Response, Router } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { ensureAuthenticated, type AuthenticatedRequest } from '../auth/authMiddleware';
import { DEFAULT_TIMEZONE } from '../../config/auth';
import { prisma } from '../../lib/prisma';
import {
  applyScheduleTolerance,
  getDateKey,
  getIntervalMinutes,
  getOverlapMinutes,
  getZonedDateTime,
  mergeTimeIntervals,
} from '../shared/localDate';
import { getWeeklySchedule } from '../schedule/scheduleDefaults';

const router = Router();
const movementTypes = ['CREDIT', 'DEBIT', 'ADJUSTMENT'] as const;
const enabledByDefault = (value: string | undefined) => value !== 'false';
const minutesBetween = (start: string, end: string) => {
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  return Math.max(0, endHour * 60 + endMinute - startHour * 60 - startMinute);
};
const formatMinutes = (minutes: number) => {
  const sign = minutes < 0 ? '-' : '';
  const absolute = Math.abs(minutes);
  return `${sign}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, '0')}`;
};
const parseMonth = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return null;
  const [year, month] = value.split('-').map(Number);
  if (month < 1 || month > 12) return null;
  return { year, month, key: value };
};
const getDayNumber = (date: string) => new Date(`${date}T12:00:00.000Z`).getUTCDay();

const ensureSettings = (userId: string) => prisma.overtimeSettings.upsert({
  where: { userId },
  create: {
    userId,
    enabled: enabledByDefault(process.env.ENABLE_OVERTIME_MODULE),
    timeBankEnabled: enabledByDefault(process.env.ENABLE_TIME_BANK),
  },
  update: {},
});

const getMonthSummary = async (userId: string, monthKey: string) => {
  const month = parseMonth(monthKey)!;
  const startDate = new Date(Date.UTC(month.year, month.month - 1, 1));
  const endDate = new Date(Date.UTC(month.year, month.month, 1));
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { preference: true },
  });
  if (!user) throw new Error('USER_NOT_FOUND');
  const timeZone = user.preference?.timezone || DEFAULT_TIMEZONE;
  const calculationStart = new Date(Date.UTC(user.createdAt.getUTCFullYear(), user.createdAt.getUTCMonth(), 1));
  const schedules = await getWeeklySchedule(userId);
  const [exceptions, entries, occurrences, manualOvertime, settings, bankMovements] = await Promise.all([
    prisma.scheduleException.findMany({ where: { userId, date: { gte: calculationStart, lt: endDate } } }),
    prisma.timeEntry.findMany({
      where: { userId, timestamp: { gte: new Date(calculationStart.getTime() - 36 * 60 * 60 * 1000), lt: new Date(endDate.getTime() + 36 * 60 * 60 * 1000) } },
      orderBy: { timestamp: 'asc' },
    }),
    prisma.occurrence.findMany({
      where: { userId, startAt: { gte: new Date(calculationStart.getTime() - 36 * 60 * 60 * 1000), lt: new Date(endDate.getTime() + 36 * 60 * 60 * 1000) } },
      orderBy: { startAt: 'asc' },
    }),
    prisma.overtimeEntry.findMany({ where: { userId, date: { gte: calculationStart, lt: endDate } } }),
    ensureSettings(userId),
    prisma.timeBankMovement.findMany({ where: { userId, date: { lt: endDate } } }),
  ]);

  const exceptionByDate = new Map(exceptions.map((item) => [item.date.toISOString().slice(0, 10), item]));
  const overtimeByDate = new Map<string, typeof manualOvertime>();
  for (const item of manualOvertime) {
    const dateKey = item.date.toISOString().slice(0, 10);
    overtimeByDate.set(dateKey, [...(overtimeByDate.get(dateKey) ?? []), item]);
  }
  const entriesByDate = new Map<string, typeof entries>();
  for (const entry of entries) {
    const dateKey = getDateKey(entry.timestamp, timeZone);
    entriesByDate.set(dateKey, [...(entriesByDate.get(dateKey) ?? []), entry]);
  }
  const occurrencesByDate = new Map<string, typeof occurrences>();
  for (const occurrence of occurrences) {
    const dateKey = getDateKey(occurrence.startAt, timeZone);
    occurrencesByDate.set(dateKey, [...(occurrencesByDate.get(dateKey) ?? []), occurrence]);
  }
  const days = [];
  const overtimeByMonth = new Map<string, number>();
  let cumulativeOvertimeMinutes = 0;
  const now = new Date();

  for (const dateCursor = new Date(calculationStart); dateCursor < endDate; dateCursor.setUTCDate(dateCursor.getUTCDate() + 1)) {
    const date = dateCursor.toISOString().slice(0, 10);
    const exception = exceptionByDate.get(date);
    const schedule = schedules.find((item) => item.dayOfWeek === getDayNumber(date))!;
    const daySchedule = exception?.type === 'WORKDAY_OVERRIDE'
      ? [{ startTime: exception.startTime!, endTime: exception.endTime! }]
      : schedule.periods.length
        ? schedule.periods
        : [{ startTime: schedule.startTime, endTime: schedule.endTime }];
    const isWorkday = exception?.type === 'WORKDAY_OVERRIDE'
      ? true
      : exception?.type === 'HOLIDAY' || exception?.type === 'DAY_OFF'
        ? false
        : schedule.isWorkday;
    const breakMinutes = schedule.breakStart && schedule.breakEnd
      ? minutesBetween(schedule.breakStart, schedule.breakEnd)
      : 0;
    const plannedMinutes = isWorkday
      ? schedule.dailyWorkMinutes ?? Math.max(0, daySchedule.reduce((total, period) => total + minutesBetween(period.startTime, period.endTime), 0) - breakMinutes)
      : 0;
    const dailyEntries = entriesByDate.get(date) ?? [];
    const dailyOccurrences = (occurrencesByDate.get(date) ?? []).filter((occurrence) => occurrence.startAt <= now);
    const effectiveSchedule = exception?.type === 'WORKDAY_OVERRIDE'
      ? {
        ...schedule,
        periods: daySchedule,
        startTime: exception.startTime!,
        endTime: exception.endTime!,
      }
      : schedule;
    let openPeriod: Date | null = null;
    const workIntervals: Array<{ start: Date; end: Date }> = [];
    for (const entry of dailyEntries) {
      const punchTime = applyScheduleTolerance(entry.type, entry.timestamp, date, timeZone, effectiveSchedule);
      if (entry.type === 'CLOCK_IN' || entry.type === 'BREAK_END') {
        openPeriod = punchTime;
      } else if ((entry.type === 'BREAK_START' || entry.type === 'CLOCK_OUT') && openPeriod) {
        workIntervals.push({ start: openPeriod, end: punchTime });
        openPeriod = null;
      }
    }
    if (openPeriod && date === getDateKey(new Date(), timeZone)) {
      workIntervals.push({ start: openPeriod, end: now });
    }
    const scheduledEndTime = exception?.type === 'WORKDAY_OVERRIDE' && exception.endTime
      ? exception.endTime
      : schedule.periods.at(-1)?.endTime ?? schedule.endTime;
    const companyIntervals = dailyOccurrences
      .filter((occurrence) => occurrence.type === 'COMPANY_ACTIVITY' && occurrence.endAt)
      .map((occurrence) => ({ start: occurrence.startAt, end: occurrence.endAt! }));
    const mergedWorkIntervals = mergeTimeIntervals([...workIntervals, ...companyIntervals]);
    const personalIntervals = mergeTimeIntervals(dailyOccurrences
      .filter((occurrence) => occurrence.type.startsWith('PERSONAL'))
      .map((occurrence) => ({
        start: occurrence.startAt,
        end: occurrence.endAt
          ? occurrence.endAt > now ? now : occurrence.endAt
          : getZonedDateTime(date, scheduledEndTime, timeZone),
      })));
    const grossWorkedMinutes = mergedWorkIntervals.reduce((total, interval) => total + getIntervalMinutes(interval), 0);
    const personalAbsenceMinutes = personalIntervals.reduce(
      (total, interval) => total + getOverlapMinutes(interval, mergedWorkIntervals),
      0,
    );
    const companyActivityMinutes = Math.max(0,
      mergedWorkIntervals.reduce((total, interval) => total + getIntervalMinutes(interval), 0) -
      workIntervals.reduce((total, interval) => total + getIntervalMinutes(interval), 0));
    const workedMinutes = Math.max(0, grossWorkedMinutes - personalAbsenceMinutes);
    const automaticOvertimeMinutes = Math.max(0, workedMinutes - plannedMinutes);
    const savedOvertime = overtimeByDate.get(date) ?? [];
    const manualOvertimeMinutes = savedOvertime.reduce((total, item) =>
      total + ((item.includeInMonth ?? settings.enabled) ? item.minutes : 0), 0);
    const candidateOvertimeMinutes =
      (settings.enabled ? automaticOvertimeMinutes : 0) + manualOvertimeMinutes;
    const dateMonth = date.slice(0, 7);
    const overtimeIncludedThisMonth = overtimeByMonth.get(dateMonth) ?? 0;
    const remainingMonthlyLimit = settings.monthlyLimitMinutes == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, settings.monthlyLimitMinutes - overtimeIncludedThisMonth);
    const overtimeMinutes = Math.min(candidateOvertimeMinutes, remainingMonthlyLimit);
    overtimeByMonth.set(dateMonth, overtimeIncludedThisMonth + overtimeMinutes);
    if (settings.timeBankEnabled) cumulativeOvertimeMinutes += overtimeMinutes;
    const hasAnyData = dailyEntries.length > 0 || dailyOccurrences.length > 0 || Boolean(exception);
    if (dateCursor >= startDate) days.push({
      date,
      isWorkday,
      exception: exception ? { type: exception.type, note: exception.note } : null,
      plannedMinutes,
      workedMinutes,
      personalAbsenceMinutes,
      companyActivityMinutes,
      overtimeMinutes,
      bankMinutes: settings.timeBankEnabled ? overtimeMinutes : 0,
      timeEntryCount: dailyEntries.length,
      occurrenceCount: dailyOccurrences.length,
      hasAnyData,
    });
  }

  const totalOvertimeMinutes = days.reduce((total, day) => total + day.overtimeMinutes, 0);
  const monthMovements = bankMovements.reduce((total, movement) => {
    if (movement.type === 'CREDIT') return total + Math.abs(movement.minutes);
    if (movement.type === 'DEBIT') return total - Math.abs(movement.minutes);
    return total + movement.minutes;
  }, 0);
  const balanceMinutes = settings.timeBankEnabled ? monthMovements + cumulativeOvertimeMinutes : 0;
  return {
    month: month.key,
    settings,
    totals: {
      plannedMinutes: days.reduce((total, day) => total + day.plannedMinutes, 0),
      workedMinutes: days.reduce((total, day) => total + day.workedMinutes, 0),
      overtimeMinutes: totalOvertimeMinutes,
      bankBalanceMinutes: balanceMinutes,
      daysWorked: days.filter((day) => day.timeEntryCount > 0).length,
    },
    days,
  };
};

router.get('/settings', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const settings = await ensureSettings(req.user!.id);
  return res.json({
    ...settings,
    enabled: settings.enabled && enabledByDefault(process.env.ENABLE_OVERTIME_MODULE),
    timeBankEnabled: settings.timeBankEnabled && enabledByDefault(process.env.ENABLE_TIME_BANK),
  });
});

router.put('/settings', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const { enabled, timeBankEnabled, monthlyLimitMinutes } = req.body ?? {};
  if (typeof enabled !== 'boolean' || typeof timeBankEnabled !== 'boolean') {
    return res.status(400).json({ message: 'Informe se horas extras e banco de horas estão ativos.' });
  }
  if (monthlyLimitMinutes != null && (!Number.isInteger(monthlyLimitMinutes) || monthlyLimitMinutes < 0 || monthlyLimitMinutes > 100000)) {
    return res.status(400).json({ message: 'Limite mensal inválido.' });
  }
  const settings = await prisma.overtimeSettings.upsert({
    where: { userId: req.user!.id },
    create: {
      userId: req.user!.id,
      enabled: enabled && enabledByDefault(process.env.ENABLE_OVERTIME_MODULE),
      timeBankEnabled: timeBankEnabled && enabledByDefault(process.env.ENABLE_TIME_BANK),
      monthlyLimitMinutes,
    },
    update: {
      enabled: enabled && enabledByDefault(process.env.ENABLE_OVERTIME_MODULE),
      timeBankEnabled: timeBankEnabled && enabledByDefault(process.env.ENABLE_TIME_BANK),
      monthlyLimitMinutes,
    },
  });
  return res.json({ settings });
});

router.get('/summary', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const month = parseMonth(req.query.month);
  if (!month) return res.status(400).json({ message: 'Mês inválido. Use AAAA-MM.' });
  const summary = await getMonthSummary(req.user!.id, month.key);
  return res.json(summary);
});

router.get('/entries', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const month = parseMonth(req.query.month);
  if (!month) return res.status(400).json({ message: 'Mês inválido. Use AAAA-MM.' });
  const start = new Date(Date.UTC(month.year, month.month - 1, 1));
  const end = new Date(Date.UTC(month.year, month.month, 1));
  const entries = await prisma.overtimeEntry.findMany({
    where: { userId: req.user!.id, date: { gte: start, lt: end } },
    orderBy: { date: 'asc' },
  });
  return res.json({ entries });
});

router.post('/entries', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const { date, minutes, includeInMonth, reason } = req.body ?? {};
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime())) {
    return res.status(400).json({ message: 'Data inválida.' });
  }
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) {
    return res.status(400).json({ message: 'Informe uma duração positiva de até 24 horas.' });
  }
  if (includeInMonth !== null && typeof includeInMonth !== 'boolean') {
    return res.status(400).json({ message: 'A regra mensal deve ser verdadeira, falsa ou herdada.' });
  }
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
    return res.status(400).json({ message: 'Informe a justificativa em até 500 caracteres.' });
  }
  const entry = await prisma.overtimeEntry.create({
    data: { userId: req.user!.id, date: parsedDate, minutes, includeInMonth, reason: reason.trim() },
  });
  return res.status(201).json({ entry });
});

router.patch('/entries/:id', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const { minutes, includeInMonth, reason } = req.body ?? {};
  if (minutes != null && (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440)) {
    return res.status(400).json({ message: 'Duração inválida.' });
  }
  if (includeInMonth !== undefined && includeInMonth !== null && typeof includeInMonth !== 'boolean') {
    return res.status(400).json({ message: 'A regra mensal deve ser verdadeira, falsa ou herdada.' });
  }
  if (reason != null && (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500)) {
    return res.status(400).json({ message: 'Justificativa inválida.' });
  }
  const result = await prisma.overtimeEntry.updateMany({
    where: { id: String(req.params.id), userId: req.user!.id },
    data: {
      minutes,
      includeInMonth,
      reason: typeof reason === 'string' ? reason.trim() : undefined,
    },
  });
  if (!result.count) return res.status(404).json({ message: 'Lançamento de hora extra não encontrado.' });
  const entry = await prisma.overtimeEntry.findUnique({ where: { id: String(req.params.id) } });
  return res.json({ entry });
});

router.delete('/entries/:id', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const result = await prisma.overtimeEntry.deleteMany({
    where: { id: String(req.params.id), userId: req.user!.id },
  });
  if (!result.count) return res.status(404).json({ message: 'Lançamento não encontrado.' });
  return res.json({ message: 'Lançamento excluído.' });
});

router.get('/bank', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const settings = await ensureSettings(req.user!.id);
  if (!settings.timeBankEnabled || !enabledByDefault(process.env.ENABLE_TIME_BANK)) {
    return res.status(403).json({ message: 'Banco de horas desativado.' });
  }
  const movements = await prisma.timeBankMovement.findMany({
    where: { userId: req.user!.id },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });
  const month = typeof req.query.month === 'string' ? parseMonth(req.query.month) : null;
  const start = month ? new Date(Date.UTC(month.year, month.month - 1, 1)) : null;
  const end = month ? new Date(Date.UTC(month.year, month.month, 1)) : null;
  const filtered = month
    ? movements.filter(({ date }) => date >= start! && date < end!)
    : movements;
  const summary = await getMonthSummary(req.user!.id, month?.key ?? new Date().toISOString().slice(0, 7));
  return res.json({ balanceMinutes: summary.totals.bankBalanceMinutes, movements: filtered });
});

router.post('/bank', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const { date, type, minutes, reason } = req.body ?? {};
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime())) {
    return res.status(400).json({ message: 'Data inválida.' });
  }
  if (!movementTypes.includes(type) || !Number.isInteger(minutes) || minutes === 0 || Math.abs(minutes) > 100000) {
    return res.status(400).json({ message: 'Tipo ou quantidade de minutos inválidos.' });
  }
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
    return res.status(400).json({ message: 'Informe o motivo do movimento.' });
  }
  const settings = await ensureSettings(req.user!.id);
  if (!settings.timeBankEnabled || !enabledByDefault(process.env.ENABLE_TIME_BANK)) {
    return res.status(403).json({ message: 'Banco de horas desativado.' });
  }
  const movement = await prisma.timeBankMovement.create({
    data: {
      userId: req.user!.id,
      date: parsedDate,
      type,
      minutes: type === 'ADJUSTMENT' ? minutes : Math.abs(minutes),
      reason: reason.trim(),
    },
  });
  return res.status(201).json({ movement });
});

router.get('/export', ensureAuthenticated, async (req: AuthenticatedRequest, res: Response) => {
  const month = parseMonth(req.query.month);
  const format = req.query.format;
  if (!month) return res.status(400).json({ message: 'Mês inválido. Use AAAA-MM.' });
  if (!['csv', 'xlsx', 'pdf'].includes(String(format))) {
    return res.status(400).json({ message: 'Formato deve ser csv, xlsx ou pdf.' });
  }
  const summary = await getMonthSummary(req.user!.id, month.key);
  const filename = `relatorio-ponto-${month.key}`;
  if (format === 'csv') {
    const rows = [
      ['Data', 'Dia trabalhado', 'Previsto (min)', 'Trabalhado (min)', 'Ausência pessoal (min)', 'Hora extra (min)', 'Banco de horas (min)', 'Ocorrências', 'Marcações'],
      ...summary.days.map((day) => [day.date, day.isWorkday ? 'Sim' : 'Não', day.plannedMinutes, day.workedMinutes, day.personalAbsenceMinutes, day.overtimeMinutes, day.bankMinutes, day.occurrenceCount, day.timeEntryCount]),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\r\n')}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(csv);
  }
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Resumo mensal');
    worksheet.addRow(['Data', 'Jornada ativa', 'Previsto (min)', 'Trabalhado (min)', 'Ausência (min)', 'Hora extra (min)', 'Banco (min)', 'Ocorrências', 'Marcações']);
    summary.days.forEach((day) => worksheet.addRow([day.date, day.isWorkday ? 'Sim' : 'Não', day.plannedMinutes, day.workedMinutes, day.personalAbsenceMinutes, day.overtimeMinutes, day.bankMinutes, day.occurrenceCount, day.timeEntryCount]));
    worksheet.columns.forEach((column) => { column.width = Math.min(28, Math.max(14, ...column.values!.map((value) => String(value ?? '').length + 2))); });
    worksheet.getRow(1).font = { bold: true };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    await workbook.xlsx.write(res);
    return res.end();
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  const document = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  document.pipe(res);
  document.fontSize(18).text(`Relatório de ponto - ${month.key}`);
  document.moveDown(0.5).fontSize(10).text(`Previsto ${formatMinutes(summary.totals.plannedMinutes)} · Trabalhado ${formatMinutes(summary.totals.workedMinutes)} · Horas extras ${formatMinutes(summary.totals.overtimeMinutes)} · Banco ${formatMinutes(summary.totals.bankBalanceMinutes)}`);
  document.moveDown();
  for (const day of summary.days) {
    document.fontSize(8).text(`${day.date} | ${day.isWorkday ? 'Jornada' : 'Folga'} | ${day.plannedMinutes}m previsto | ${day.workedMinutes}m registrado | ${day.overtimeMinutes}m extra | ${day.occurrenceCount} ocorrência(s)`);
    if (document.y > 520) document.addPage();
  }
  document.end();
});

export default router;
