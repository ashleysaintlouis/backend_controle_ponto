"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOverlapMinutes = exports.getIntervalMinutes = exports.mergeTimeIntervals = exports.applyScheduleTolerance = exports.getZonedDateTime = exports.getDateKey = void 0;
const getDateKey = (date, timeZone) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
};
exports.getDateKey = getDateKey;
const getZonedDateTime = (dateKey, time, timeZone) => {
    const [year, month, day] = dateKey.split('-').map(Number);
    const [hours, minutes] = time.split(':').map(Number);
    const targetAsUtc = Date.UTC(year, month - 1, day, hours, minutes);
    let result = new Date(targetAsUtc);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(result);
        const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
        const displayedAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute));
        result = new Date(result.getTime() + targetAsUtc - displayedAsUtc);
    }
    return result;
};
exports.getZonedDateTime = getZonedDateTime;
const applyScheduleTolerance = (type, timestamp, dateKey, timeZone, schedule) => {
    const lastPeriod = schedule.periods.at(-1);
    const boundaries = {
        CLOCK_IN: { time: schedule.periods[0]?.startTime, tolerance: schedule.entryToleranceMinutes },
        CLOCK_OUT: { time: lastPeriod?.endTime, tolerance: schedule.exitToleranceMinutes },
        BREAK_START: { time: schedule.breakStart ?? undefined, tolerance: schedule.breakStartToleranceMinutes },
        BREAK_END: { time: schedule.breakEnd ?? undefined, tolerance: schedule.breakEndToleranceMinutes },
    };
    const boundary = boundaries[type];
    if (!boundary?.time)
        return timestamp;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(timestamp);
    const values = Object.fromEntries(parts.map(({ type: partType, value }) => [partType, value]));
    const actualMinutes = Number(values.hour) * 60 + Number(values.minute);
    const expectedMinutes = Number(boundary.time.slice(0, 2)) * 60 + Number(boundary.time.slice(3));
    return Math.abs(actualMinutes - expectedMinutes) <= boundary.tolerance
        ? (0, exports.getZonedDateTime)(dateKey, boundary.time, timeZone)
        : timestamp;
};
exports.applyScheduleTolerance = applyScheduleTolerance;
const mergeTimeIntervals = (intervals) => {
    const sorted = intervals
        .filter(({ start, end }) => end > start)
        .sort((left, right) => left.start.getTime() - right.start.getTime());
    const merged = [];
    for (const interval of sorted) {
        const previous = merged.at(-1);
        if (!previous || interval.start > previous.end) {
            merged.push({ ...interval });
        }
        else if (interval.end > previous.end) {
            previous.end = interval.end;
        }
    }
    return merged;
};
exports.mergeTimeIntervals = mergeTimeIntervals;
const getIntervalMinutes = ({ start, end }) => Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
exports.getIntervalMinutes = getIntervalMinutes;
const getOverlapMinutes = (interval, intervals) => intervals.reduce((total, item) => {
    const start = Math.max(interval.start.getTime(), item.start.getTime());
    const end = Math.min(interval.end.getTime(), item.end.getTime());
    return total + Math.max(0, Math.floor((end - start) / 60000));
}, 0);
exports.getOverlapMinutes = getOverlapMinutes;
