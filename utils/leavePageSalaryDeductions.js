import { isHourLossWaived, explicitAuthorizedHourShare, isDeductionWaived } from './deductionWaive.js';
import { flexibleExactLossHours, requiredHoursForDate } from './flexibleAttendance.js';
import { missedPunchDeduction } from './lateDeductionPolicy.js';
import { punchAttendanceKind } from './partialLeaveWindow.js';
import { addDays } from './salaryHistoricalCalculations.js';
import {
    WEEKDAY_KEYS,
    clockTimeToMinutes,
    getScheduledPunchMinutes,
    isFlexibleTiming,
} from './workingTimeHelpers.js';

const LEAVE_STATUS = new Set([
    'authorized_leave',
    'unauthorized_leave',
    'on_leave',
    'sick_leave',
    'compoff_leave',
]);

const SANDWICH_LEAVE_KEYS = new Set([
    'on_leave',
    'sick_leave',
    'authorized_leave',
    'unauthorized_leave',
    'compoff_leave',
]);

function n(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function money2(value) {
    return Math.round((n(value)) * 100) / 100;
}

function dateKeyOf(value) {
    const raw = String(value || '').trim();
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    return iso ? iso[1] : '';
}

function monthEndKey(monthKey) {
    const match = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return '';
    const last = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
    return `${match[1]}-${match[2]}-${String(last).padStart(2, '0')}`;
}

/**
 * Same counted dates as the employee Leave page salary table.
 * A past month is the full month. The current month stops at yesterday.
 */
export function leaveDeductionCountWindow({ monthKey, joinKey = '', processingStart = '', todayKey = '' } = {}) {
    const monthFrom = /^\d{4}-\d{2}$/.test(String(monthKey || '')) ? `${monthKey}-01` : '';
    const monthTo = monthEndKey(monthKey);
    if (!monthFrom || !monthTo) return { from: '', to: '' };
    const join = dateKeyOf(joinKey);
    const start = dateKeyOf(processingStart);
    let from = monthFrom;
    if (join && start && start.slice(0, 7) === join.slice(0, 7) && start >= join && start.startsWith(monthKey) && start > monthFrom) {
        from = start;
    } else if (join.startsWith(monthKey) && join > monthFrom) {
        from = join;
    }
    const today = dateKeyOf(todayKey);
    let to = monthTo;
    if (!today) to = monthTo;
    else if (monthKey < today.slice(0, 7)) to = monthTo;
    else if (monthKey > today.slice(0, 7)) to = '';
    else {
        const yesterday = addDays(today, -1);
        if (!yesterday || yesterday < monthFrom) to = '';
        else to = yesterday < monthTo ? yesterday : monthTo;
    }
    if (to && from > to) return { from, to: '' };
    return { from, to };
}

function deductionKind(row) {
    const status = String(row?.statusKey || '');
    if (LEAVE_STATUS.has(status)) return status;
    if (String(row?.hourAdjustStatus || '') === 'approved' && row?.hourAdjustKind) {
        return String(row.hourAdjustKind);
    }
    return punchAttendanceKind(row) || status;
}

/** Same type the Leave page salary deduction table uses for one attendance day. */
export function shownDeductionKind(row) {
    const status = String(row?.statusKey || '');
    if (status === 'sandwich') return 'sandwich';
    const approved = String(row?.leaveRequestStatus || '').toLowerCase() === 'approved';
    const requested = String(row?.requestedStatusKey || '').trim();
    const requestKind = String(row?.leaveRequestKind || '').trim();
    if (status === 'on_leave' || (approved && (requested === 'on_leave' || requestKind === 'future_annual'))) {
        return 'on_leave';
    }
    if (approved && requested === 'sick_leave') return 'sick_leave';
    if (approved && requested === 'compoff_leave') return 'compoff_leave';
    return deductionKind(row);
}

function leaveDayWeight(row, authorized) {
    const part = String(row?.leaveRequestDayPart || '');
    const fraction = part === 'half' ? 0.5 : part === 'quarter' ? 0.25 : 1;
    const doubled = authorized && n(row?.leaveDeductionTimes) === 2 ? 2 : 1;
    return fraction * doubled;
}

function weekdayKey(date) {
    return WEEKDAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()] || '';
}

function leaveKeyOf(row) {
    const key = String(row?.statusKey || '');
    if (SANDWICH_LEAVE_KEYS.has(key)) return key;
    const requested = String(row?.requestedStatusKey || '');
    const approved = String(row?.leaveRequestStatus || '').toLowerCase() === 'approved';
    if (approved && SANDWICH_LEAVE_KEYS.has(requested)) return requested;
    return '';
}

function dateKeysBetween(from, to) {
    const dates = [];
    let cursor = from;
    while (cursor && cursor <= to && dates.length < 400) {
        dates.push(cursor);
        cursor = addDays(cursor, 1);
    }
    return dates;
}

/** Weekly off or holiday with leave on the working day before it and the working day after it. */
export function sandwichDates({ records, holidayDates, offWeekdays, from, to } = {}) {
    const map = new Map();
    if (!from || !to) return map;
    const start = addDays(from, -14) || from;
    const end = addDays(to, 14) || to;
    const leaveByDate = new Map();
    const offSet = new Set();
    for (const row of records || []) {
        const date = dateKeyOf(row?.date);
        if (!date || date < start || date > end) continue;
        const key = leaveKeyOf(row);
        if (key) leaveByDate.set(date, key);
        const status = String(row?.statusKey || '');
        if (status === 'holiday' || status === 'weekly_off') offSet.add(date);
    }
    for (const date of dateKeysBetween(start, end)) {
        if (holidayDates?.has(date) || offWeekdays?.has(weekdayKey(date))) offSet.add(date);
    }
    const nearest = (date, direction) => {
        let cursor = addDays(date, direction);
        while (cursor && cursor >= start && cursor <= end) {
            if (!offSet.has(cursor)) return cursor;
            cursor = addDays(cursor, direction);
        }
        return '';
    };
    for (const date of dateKeysBetween(from, to)) {
        if (!offSet.has(date) || leaveByDate.has(date)) continue;
        const prev = leaveByDate.get(nearest(date, -1));
        const next = leaveByDate.get(nearest(date, 1));
        if (!prev || !next) continue;
        map.set(date, 'sandwich');
    }
    return map;
}

function dayHoursOf(week, dateKey) {
    const scheduled = getScheduledPunchMinutes(week, dateKey);
    if (scheduled && !scheduled.flexible && !scheduled.isOffDay && scheduled.endMinutes != null && scheduled.startMinutes != null) {
        const minutes = scheduled.endMinutes - scheduled.startMinutes;
        if (minutes > 0) return minutes / 60;
    }
    return 8;
}

function scheduledGapHours(row, week) {
    const scheduled = getScheduledPunchMinutes(week, row?.date);
    if (!scheduled || scheduled.flexible || scheduled.isOffDay) return null;
    if (scheduled.startMinutes == null || scheduled.endMinutes == null) return null;
    const inn = clockTimeToMinutes(row?.timeIn);
    const out = clockTimeToMinutes(row?.timeOut);
    return {
        late: inn == null ? 0 : Math.max(0, inn - scheduled.startMinutes) / 60,
        early: out == null ? 0 : Math.max(0, scheduled.endMinutes - out) / 60,
    };
}

function hourDeductionAmount(row, week, daily, kind, unauthTimes) {
    const approved = String(row?.hourAdjustStatus || '') === 'approved';
    const flexiblePunch = isFlexibleTiming(week) && (kind === 'early_go' || kind === 'late_arrived');
    const dayHours = flexiblePunch
        ? (requiredHoursForDate(week, row?.date) || 8)
        : ((approved ? requiredHoursForDate(week, row?.date) : 0) || dayHoursOf(week, row?.date) || 8);
    const gaps = scheduledGapHours(row, week);
    const missedHours = flexiblePunch
        ? (approved ? n(row.hoursApproved) : flexibleExactLossHours(row, week))
        : (approved ? n(row.hoursApproved) : (gaps ? gaps.late + gaps.early : dayHoursOf(week, row?.date)));
    const hours = approved ? missedHours : missedHours * unauthTimes;
    if (!(hours > 0) || !(daily > 0) || !(dayHours > 0)) return 0;
    return money2((hours / dayHours) * daily);
}

function rowDeductionAmount(row, week, daily, policy, mispunchAmounts, authTimes, unauthTimes) {
    if (isDeductionWaived(row)) return 0;
    const key = deductionKind(row);
    if (key === 'mispunch') {
        const hoursWaived = String(row?.hourAdjustStatus || '') === 'approved' && !(n(row?.hoursApproved) > 0);
        if (hoursWaived) return 0;
        return money2(mispunchAmounts?.get(dateKeyOf(row?.date)) || 0);
    }
    if (key === 'early_go' || key === 'late_arrived') {
        return hourDeductionAmount(row, week, daily, key, unauthTimes);
    }
    if (key === 'on_leave') return money2(daily);
    if (key === 'authorized_leave') {
        const share = explicitAuthorizedHourShare(row);
        if (share != null) return money2(share * n(daily));
    }
    if (key === 'unauthorized_leave' && String(row?.hourAdjustStatus || '') === 'approved') {
        return hourDeductionAmount(row, week, daily, key, 1);
    }
    if (key === 'authorized_leave' || key === 'unauthorized_leave') {
        const times = key === 'authorized_leave' ? authTimes : unauthTimes;
        return money2(leaveDayWeight(row, key === 'authorized_leave') * times * n(daily));
    }
    const unmarked = key === 'not_marked' || key === 'absent' || key === '';
    const punched = Boolean(String(row?.timeIn || '').trim() || String(row?.timeOut || '').trim());
    if (unmarked && row?.date && !punched) return money2(unauthTimes * n(daily));
    return 0;
}

function chargeableMispunch(row) {
    if (!row || isDeductionWaived(row)) return false;
    return !(String(row.hourAdjustStatus || '') === 'approved' && !(n(row.hoursApproved) > 0));
}

function mispunchAmountsFor(records, policy, daily) {
    const dates = [];
    const seen = new Set();
    for (const row of records || []) {
        if (deductionKind(row) !== 'mispunch' || !chargeableMispunch(row)) continue;
        const date = dateKeyOf(row?.date);
        if (!date || seen.has(date)) continue;
        seen.add(date);
        dates.push(date);
    }
    dates.sort();
    const amounts = new Map();
    dates.forEach((date, index) => {
        const before = money2(n(daily) * missedPunchDeduction(index, policy).dayFraction);
        const after = money2(n(daily) * missedPunchDeduction(index + 1, policy).dayFraction);
        amounts.set(date, money2(after - before));
    });
    return amounts;
}

function uniqueRows(records, from, to) {
    const byDate = new Map();
    for (const row of records || []) {
        const date = dateKeyOf(row?.date);
        if (!date) continue;
        if (from && date < from) continue;
        if (to && date > to) continue;
        if (!byDate.has(date)) byDate.set(date, row);
    }
    return [...byDate.values()];
}

function punchShare(row, week, kind) {
    if (isDeductionWaived(row) || isHourLossWaived(row)) return 0;
    const key = deductionKind(row);
    if (key !== 'late_arrived' && key !== 'early_go') return 0;
    if (isFlexibleTiming(week)) return key === kind ? 1 : 0;
    const gaps = scheduledGapHours(row, week);
    const total = gaps ? gaps.late + gaps.early : 0;
    if (!(total > 0)) return key === kind ? 1 : 0;
    const hours = kind === 'late_arrived' ? gaps.late : gaps.early;
    return hours > 0 ? hours / total : 0;
}

/**
 * Attendance deductions for one salary month, using the Leave page rules.
 * Sandwich Leave is always returned, with 0 days and 0 amount when there is none.
 */
export function summarizeLeavePageDeductions({
    records,
    policy = {},
    week = null,
    daily = 0,
    holidayDates = new Set(),
    offWeekdays = new Set(),
    from = '',
    to = '',
    authTimes = 1,
    unauthTimes = 2,
} = {}) {
    const empty = {
        lateIn: { count: 0, amount: 0 },
        lateOut: { count: 0, amount: 0 },
        missed: { count: 0, amount: 0 },
        authorized: { days: 0, amount: 0 },
        unauthorized: { days: 0, amount: 0 },
        annual: { days: 0, amount: 0 },
        sandwich: { days: 0, amount: 0 },
    };
    if (!from || !to) return empty;
    const rows = uniqueRows(records, from, to);
    const mispunchAmounts = mispunchAmountsFor(rows, policy, daily);
    const forgiven = (row) => isDeductionWaived(row) || isHourLossWaived(row);

    let authDays = 0;
    let authAmount = 0;
    let unauthDays = 0;
    for (const row of rows) {
        if (forgiven(row)) continue;
        const key = shownDeductionKind(row);
        if (key === 'authorized_leave') {
            const share = explicitAuthorizedHourShare(row);
            const weight = leaveDayWeight(row, true);
            authDays += share != null ? share * weight : weight;
            authAmount += rowDeductionAmount(row, week, daily, policy, mispunchAmounts, authTimes, unauthTimes);
        }
        if (key === 'on_leave' || key === 'sandwich' || key === 'sick_leave') continue;
        if (key === 'unauthorized_leave') {
            unauthDays += leaveDayWeight(row, false);
            continue;
        }
        const punched = Boolean(String(row?.timeIn || '').trim() || String(row?.timeOut || '').trim());
        if ((key === 'not_marked' || key === 'absent' || key === '') && row?.date && !punched) unauthDays += 1;
    }

    const punchAmountOf = (kind) => rows.reduce((sum, row) => {
        const share = punchShare(row, week, kind);
        if (!(share > 0)) return sum;
        return sum + rowDeductionAmount(row, week, daily, policy, mispunchAmounts, authTimes, unauthTimes) * share;
    }, 0);
    const punchCountOf = (kind) => rows.filter((row) => punchShare(row, week, kind) > 0).length;
    const missedRows = rows.filter((row) => deductionKind(row) === 'mispunch' && chargeableMispunch(row));
    const annualDays = rows.filter((row) => shownDeductionKind(row) === 'on_leave').length;
    const sandwich = sandwichDates({ records, holidayDates, offWeekdays, from, to });

    return {
        lateIn: { count: punchCountOf('late_arrived'), amount: money2(punchAmountOf('late_arrived')) },
        lateOut: { count: punchCountOf('early_go'), amount: money2(punchAmountOf('early_go')) },
        missed: {
            count: missedRows.length,
            amount: money2([...mispunchAmounts.values()].reduce((sum, amount) => sum + amount, 0)),
        },
        authorized: { days: money2(authDays), amount: money2(authAmount) },
        unauthorized: { days: money2(unauthDays), amount: money2(unauthDays * unauthTimes * n(daily)) },
        annual: { days: annualDays, amount: money2(annualDays * n(daily)) },
        sandwich: { days: sandwich.size, amount: money2(sandwich.size * n(daily)) },
    };
}
