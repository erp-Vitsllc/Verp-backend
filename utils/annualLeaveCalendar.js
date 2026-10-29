import { addDays, isDateKey } from './salaryHistoricalCalculations.js';
import { annualLeaveRequestBlock } from './annualLeaveAllowance.js';

export const ANNUAL_LEAVE_MINIMUM_DAYS = 5;
export const ANNUAL_LEAVE_BUFFER_DAYS = 2;

const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];

export function formatLeaveDate(key) {
    if (!isDateKey(key)) return '';
    const [year, month, day] = key.split('-').map(Number);
    return `${day} ${MONTHS[month - 1]} ${year}`;
}

function dayWord(count) {
    const total = Math.max(0, Number(count) || 0);
    return `${total} day${total === 1 ? '' : 's'}`;
}

function mergeSpans(spans) {
    const sorted = (spans || [])
        .filter((span) => isDateKey(span?.from) && isDateKey(span?.to) && span.to >= span.from)
        .map((span) => ({
            from: span.from,
            to: span.to,
            remainingDays: Math.max(0, Number(span.remainingDays) || 0),
        }))
        .sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
    const merged = [];
    for (const span of sorted) {
        const last = merged[merged.length - 1];
        if (last && span.from <= addDays(last.to, 1)) {
            if (span.to > last.to) last.to = span.to;
            last.remainingDays = Math.max(last.remainingDays, span.remainingDays);
            continue;
        }
        merged.push({ ...span });
    }
    return merged;
}

/**
 * Days the employee may apply for annual leave.
 * A period opens on the working day the 300-day count is reached, and only
 * when at least 5 days of the 30-day allowance are still left.
 */
export function buildOpenAnnualLeaveSpans(windows, { minimumDays = ANNUAL_LEAVE_MINIMUM_DAYS, allowedDays = 30 } = {}) {
    const spans = [];
    for (const row of windows || []) {
        const from = String(row?.eligibleOn || '').trim();
        const to = String(row?.takeUntil || row?.endDate || '').trim();
        if (!isDateKey(from) || !isDateKey(to) || to < from) continue;
        let remaining = 0;
        if (row.status === 'Active') remaining = Math.max(0, Number(row.remainingDays) || 0);
        else if (row.status === 'Inactive') {
            const taken = Math.max(0, Number(row.takenDays) || 0);
            remaining = Math.max(0, (Number(allowedDays) || 0) - taken);
        }
        if (remaining < minimumDays) continue;
        spans.push({ from, to, remainingDays: remaining });
    }
    return mergeSpans(spans);
}

export function buildAnnualLeaveCalendar({
    windows = [],
    allowedDays = 30,
    cycleDays = 300,
    today = '',
    remainingDays = 0,
    minimumDays = ANNUAL_LEAVE_MINIMUM_DAYS,
} = {}) {
    const openSpans = buildOpenAnnualLeaveSpans(windows, { minimumDays, allowedDays });
    const first = openSpans[0] || null;
    const left = Math.max(0, Number(remainingDays) || 0);
    const minimum = Math.max(1, Number(minimumDays) || ANNUAL_LEAVE_MINIMUM_DAYS);
    const allowed = Math.max(0, Number(allowedDays) || 30);
    const cycle = Math.max(1, Number(cycleDays) || 300);
    let notice = '';
    if (!first) {
        if (left > 0 && left < minimum) {
            notice = `You have ${dayWord(left)} of annual leave left. You need at least ${minimum} days remaining to apply. A new ${allowed}-day period opens after ${cycle} counted working days. Holidays and weekly offs are not counted.`;
        } else if (left === 0 && (windows || []).some((row) => row.status === 'Active' || row.status === 'Lapsed')) {
            notice = `You have no annual leave days left. A new ${allowed}-day period opens after ${cycle} counted working days. You need at least ${minimum} days remaining to apply. Holidays and weekly offs are not counted.`;
        } else {
            notice = `Annual leave is not open yet. It opens after ${cycle} counted working days, with ${allowed} days. You need at least ${minimum} days remaining to apply. Holidays and weekly offs are not counted.`;
        }
    } else if (isDateKey(today) && first.from > today) {
        const short = left > 0 && left < minimum
            ? ` You have ${dayWord(left)} left, which is below the minimum of ${minimum} days.`
            : '';
        notice = `Annual leave opens on ${formatLeaveDate(first.from)}. Days before that stay closed.${short} It opens after ${cycle} counted working days and gives ${allowed} days. You need at least ${minimum} days remaining to apply. Holidays and weekly offs are not counted.`;
    }
    return {
        minimumDays: minimum,
        allowedDays: allowed,
        cycleDays: cycle,
        eligibleOn: first?.from || '',
        remainingDays: left,
        openSpans,
        notice,
    };
}

function contiguousRanges(dates) {
    const sorted = [...new Set(dates)].filter((date) => isDateKey(date)).sort();
    const ranges = [];
    for (const date of sorted) {
        const last = ranges[ranges.length - 1];
        if (last && addDays(last.to, 1) === date) last.to = date;
        else ranges.push({ from: date, to: date });
    }
    return ranges;
}

/** Yellow band: 2 calendar days before each leave, through 2 calendar days after it. */
export function markGroupLeaveDays(rows, { applicantId = '', maxAllowed = null } = {}) {
    const byPerson = new Map();
    const capByDate = new Map();
    const own = new Set();
    const applicant = String(applicantId || '');
    for (const row of rows || []) {
        const id = String(row?.employeeMongoId || '').trim();
        const date = String(row?.date || '').trim();
        if (!id || !isDateKey(date)) continue;
        if (!byPerson.has(id)) byPerson.set(id, []);
        byPerson.get(id).push(date);
        if (applicant && id === applicant) own.add(date);
        if (row?.countsTowardCap === false) continue;
        if (!capByDate.has(date)) capByDate.set(date, new Set());
        capByDate.get(date).add(id);
    }
    const ranges = [];
    for (const dates of byPerson.values()) ranges.push(...contiguousRanges(dates));
    const yellowSpans = mergeSpans(
        ranges.map((range) => ({
            from: addDays(range.from, -ANNUAL_LEAVE_BUFFER_DAYS),
            to: addDays(range.to, ANNUAL_LEAVE_BUFFER_DAYS),
        })),
    ).map(({ from, to }) => ({ from, to }));
    const cappedDates = [];
    for (const [date, ids] of capByDate) {
        const others = [...ids].filter((id) => id !== applicant).length;
        if (maxAllowed != null && others >= maxAllowed) cappedDates.push(date);
    }
    const ownLeaveDates = [...own];
    ownLeaveDates.sort();
    cappedDates.sort();
    return { yellowSpans, cappedDates, ownLeaveDates };
}

function nextOpenFrom(spans, key) {
    const sorted = [...(spans || [])]
        .filter((span) => isDateKey(span?.from) && isDateKey(span?.to) && span.to >= key)
        .sort((a, b) => (a.from === b.from ? 0 : a.from < b.from ? -1 : 1));
    const upcoming = sorted.find((span) => span.from > key);
    return (upcoming || sorted[0])?.from || '';
}

export function describeAnnualLeaveRange({ calendar, from, to, processingStart = '' } = {}) {
    if (!calendar || !isDateKey(from) || !isDateKey(to) || to < from) return '';
    const spans = calendar.openSpans || [];
    const own = new Set(calendar.ownLeaveDates || []);
    const capped = new Set(calendar.cappedDates || []);
    const minimumDays = calendar.minimumDays || ANNUAL_LEAVE_MINIMUM_DAYS;
    const remainingDays = Math.max(0, Number(calendar.remainingDays) || 0);
    let cursor = from;
    let steps = 0;
    while (cursor && cursor <= to && steps < 400) {
        if (isDateKey(processingStart) && cursor < processingStart) {
            return `Leave cannot start before this employee's salary processing date (${formatLeaveDate(processingStart)}).`;
        }
        const open = spans.some((span) => cursor >= span.from && cursor <= span.to);
        if (!open) {
            const openOn = nextOpenFrom(spans, cursor);
            if (!openOn && remainingDays > 0 && remainingDays < minimumDays) {
                return `You have ${dayWord(remainingDays)} of annual leave left. You need at least ${minimumDays} days remaining to apply.`;
            }
            if (openOn) {
                return `${formatLeaveDate(cursor)} is closed. Choose a date on or after ${formatLeaveDate(openOn)}.`;
            }
            return `${formatLeaveDate(cursor)} is closed for annual leave.`;
        }
        if (own.has(cursor)) {
            return `You already have leave on ${formatLeaveDate(cursor)}. Choose another day.`;
        }
        if (capped.has(cursor)) {
            const max = calendar.maxAllowed;
            const group = calendar.groupLabel || 'this group';
            const pct = calendar.maxPercent;
            const limit =
                max == null
                    ? ''
                    : ` Only ${max} ${max === 1 ? 'employee' : 'employees'}${pct == null ? '' : ` (${pct}%)`} in ${group} can be on annual leave that day.`;
            return `${formatLeaveDate(cursor)} is already at the group limit.${limit}`;
        }
        cursor = addDays(cursor, 1);
        steps += 1;
    }
    if (steps >= 400 && cursor && cursor <= to) {
        return 'Choose a shorter annual leave range.';
    }
    return '';
}

export function buildAnnualLeaveSelectionMessage({
    calendar,
    allowance,
    groupCap,
    from = '',
    to = '',
    requestedDates = [],
    processingStart = '',
} = {}) {
    const rangeMessage = describeAnnualLeaveRange({ calendar, from, to, processingStart });
    if (rangeMessage) return rangeMessage;
    if (!isDateKey(from) || !isDateKey(to)) return '';
    const allowanceHit = annualLeaveRequestBlock(allowance, { from, to, requestedDates });
    if (!allowanceHit.ok && allowanceHit.message) return allowanceHit.message;
    if (groupCap?.over && groupCap.message) return groupCap.message;
    return '';
}
