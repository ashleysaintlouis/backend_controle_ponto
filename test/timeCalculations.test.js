const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  applyScheduleTolerance,
  getDateKey,
  getIntervalMinutes,
  getOverlapMinutes,
  getZonedDateTime,
  mergeTimeIntervals,
} = require('../src/modules/shared/localDate');

test('local schedule time converts to UTC and back in the selected timezone', () => {
  const scheduledTime = getZonedDateTime('2026-10-02', '09:00', 'America/Sao_Paulo');
  assert.equal(scheduledTime.toISOString(), '2026-10-02T12:00:00.000Z');
  assert.equal(getDateKey(scheduledTime, 'America/Sao_Paulo'), '2026-10-02');
});

test('overlapping work and company intervals merge without double counting', () => {
  const merged = mergeTimeIntervals([
    { start: new Date('2026-10-02T09:00:00Z'), end: new Date('2026-10-02T12:00:00Z') },
    { start: new Date('2026-10-02T11:00:00Z'), end: new Date('2026-10-02T13:00:00Z') },
    { start: new Date('2026-10-02T14:00:00Z'), end: new Date('2026-10-02T15:00:00Z') },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged.reduce((total, interval) => total + getIntervalMinutes(interval), 0), 300);
  assert.equal(getOverlapMinutes(
    { start: new Date('2026-10-02T10:30:00Z'), end: new Date('2026-10-02T11:30:00Z') },
    merged,
  ), 60);
});

test('punches inside tolerance normalize to plan; punches outside retain actual time', () => {
  const schedule = {
    periods: [{ startTime: '09:00', endTime: '12:00' }, { startTime: '13:00', endTime: '17:00' }],
    breakStart: '12:00',
    breakEnd: '13:00',
    entryToleranceMinutes: 10,
    exitToleranceMinutes: 10,
    breakStartToleranceMinutes: 5,
    breakEndToleranceMinutes: 5,
  };

  const withinEntryTolerance = applyScheduleTolerance(
    'CLOCK_IN', new Date('2026-10-02T12:08:00Z'), '2026-10-02', 'America/Sao_Paulo', schedule,
  );
  const outsideEntryTolerance = applyScheduleTolerance(
    'CLOCK_IN', new Date('2026-10-02T12:11:00Z'), '2026-10-02', 'America/Sao_Paulo', schedule,
  );
  const withinBreakTolerance = applyScheduleTolerance(
    'BREAK_START', new Date('2026-10-02T15:04:00Z'), '2026-10-02', 'America/Sao_Paulo', schedule,
  );

  assert.equal(withinEntryTolerance.toISOString(), '2026-10-02T12:00:00.000Z');
  assert.equal(outsideEntryTolerance.toISOString(), '2026-10-02T12:11:00.000Z');
  assert.equal(withinBreakTolerance.toISOString(), '2026-10-02T15:00:00.000Z');
});