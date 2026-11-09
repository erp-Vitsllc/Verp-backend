/**
 * Salary slips use this copy so overtime matches the Leave page when the frontend
 * tree is not deployed beside the API. Keep it aligned with
 * VERP_frontend/src/app/HRM/Leave/utils/weeklySalaryAddition.js.
 *
 * Weekly salary addition.
 * A report week is Monday–Saturday, clipped to the month. A month that starts
 * on Thursday begins Thursday–Saturday, and a month that ends mid-week stops
 * on that last day. Sunday is the week off. It stays out of the Monday–Saturday
 * label and is kept with the week it opens, so hours on that Sunday are still counted.
 *
 * Approved hours that stay as overtime stay on the overtime row.
 * Approved hours used as another day's attendance count as one comp-off day.
 * Hours left after that day are not overtime until HR approves a request for that day.
 * A comp-off settlement still takes its hours from the earliest overtime.
 */

import { punchAttendanceKind } from './punchAttendanceKind.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WORKED_STATUS_KEYS = new Set(['on_office', 'work_from_home', 'late_arrived', 'early_go']);
const COMP_OFF_DAY_HOURS = 10;
/** A working day never counts as more than 10 hours, even when the group day is longer. */
const DAY_HOUR_CAP = 10;

function roundHours(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function money2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function shiftDateKey(dateKey, days) {
    const [year, month, day] = String(dateKey || '').split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + Number(days || 0)));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function monthEndKey(monthKey) {
    const [year, month] = String(monthKey || '').split('-').map(Number);
    if (!year || !month) return '';
    return `${monthKey}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
}

function eachDate(from, to) {
    const dates = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return dates;
    let cursor = from;
    while (cursor <= to && dates.length < 40) {
        dates.push(cursor);
        cursor = shiftDateKey(cursor, 1);
    }
    return dates;
}

function weekdayIndex(dateKey) {
    return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

export function formatAdditionDay(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return '—';
    const [year, month, day] = dateKey.split('-').map(Number);
    return `${String(day).padStart(2, '0')}-${MONTHS[month - 1]}-${year}`;
}

/** 1.75 hours is 1 hour 45 minutes, not a decimal hour. */
export function formatHourMeasure(hours) {
    const value = Number(hours) || 0;
    const negative = value < -1e-9;
    const totalMinutes = Math.round(Math.abs(value) * 60);
    const whole = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const sign = negative ? '-' : '';
    if (mins === 0) return `${sign}${whole} ${whole === 1 ? 'Hour' : 'Hours'}`;
    if (whole === 0) return `${sign}${mins} ${mins === 1 ? 'Minute' : 'Minutes'}`;
    return `${sign}${whole} ${whole === 1 ? 'Hour' : 'Hours'} ${mins} ${mins === 1 ? 'Minute' : 'Minutes'}`;
}

/** The hours that count for one required day. Short days keep the hours worked. Longer days stop at the group day, and that day stops at 10 hours. */
export function creditedDayHours(workedHours, scheduledHours) {
    const scheduled = roundHours(scheduledHours);
    const cap = scheduled > DAY_HOUR_CAP ? DAY_HOUR_CAP : scheduled;
    if (!(cap > 0)) return 0;
    const worked = Math.max(0, roundHours(workedHours));
    return roundHours(Math.min(worked, cap));
}

function hourPhrase(hours) {
    return formatHourMeasure(hours);
}

function aedText(value) {
    const amount = money2(value);
    return `AED ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Same split as overtime approval: one working day becomes the next day, leftover hours stay as overtime. */
function splitNextDayHours(approvedHours, dayHours) {
    const approved = roundHours(approvedHours);
    let day = roundHours(dayHours);
    if (!(day > 0)) {
        if (!(approved > 10)) return { dayHours: 0, remainderHours: approved };
        day = 10;
    }
    if (approved + 1e-9 < day) return { dayHours: 0, remainderHours: approved };
    return {
        dayHours: day,
        remainderHours: Math.max(0, Math.floor(approved - day + 1e-9)),
    };
}

export function buildMonthWorkWeeks(monthKey) {
    const end = monthEndKey(monthKey);
    if (!end) return [];
    const weeks = [];
    let bucket = [];
    let opening = [];
    let carry = [];
    const flush = () => {
        if (!bucket.length) return;
        weeks.push({
            id: `${bucket[0]}_${bucket[bucket.length - 1]}`,
            index: weeks.length + 1,
            from: bucket[0],
            to: bucket[bucket.length - 1],
            dates: [...bucket],
            extraDates: [...opening],
        });
        bucket = [];
        opening = [];
    };
    eachDate(`${monthKey}-01`, end).forEach((date) => {
        if (weekdayIndex(date) === 0) {
            carry.push(date);
            return;
        }
        if (!bucket.length && carry.length) {
            opening = carry;
            carry = [];
        }
        bucket.push(date);
        if (weekdayIndex(date) === 6) flush();
    });
    flush();
    if (carry.length && weeks.length) weeks[weeks.length - 1].extraDates.push(...carry);
    return weeks;
}

/**
 * All is the current month from the 1st through yesterday.
 * A finished month is the 1st through its last day. Weeks stay underneath it.
 */
export function buildMonthAdditionChoices(monthKey, todayKey) {
    const weeks = buildMonthWorkWeeks(monthKey);
    const start = `${monthKey}-01`;
    const monthEnd = monthEndKey(monthKey);
    const today = String(todayKey || '');
    const yesterday = shiftDateKey(today, -1);
    let to = monthEnd;
    if (today.startsWith(String(monthKey || ''))) {
        to = yesterday >= start && yesterday <= monthEnd ? yesterday : '';
    } else if (today && String(monthKey || '') > today.slice(0, 7)) {
        to = '';
    }
    const span = to ? eachDate(start, to) : [];
    return [
        {
            id: 'all',
            index: 0,
            from: start,
            to: to || start,
            dates: span.filter((date) => weekdayIndex(date) !== 0),
            extraDates: span.filter((date) => weekdayIndex(date) === 0),
            empty: !to,
        },
        ...weeks,
    ];
}

/** The week before the one that contains today. On a Sunday, the week that just ended. */
export function defaultWorkWeekIndex(weeks, todayKey) {
    if (!weeks.length) return 0;
    const today = String(todayKey || '');
    const current = weeks.findIndex((week) => today >= week.from && today <= week.to);
    if (current > 0) return current - 1;
    if (current === 0) return 0;
    let previous = -1;
    weeks.forEach((week, index) => {
        if (week.to < today) previous = index;
    });
    return previous >= 0 ? previous : 0;
}

function blankDay(date) {
    return {
        date,
        statusKey: '',
        synthetic: false,
        fromDay: '',
        workedHours: 0,
        payable: 0,
        moved: 0,
        consumed: 0,
        incoming: 0,
        covered: false,
        coverSource: '',
        attendanceId: '',
        nextDayDate: '',
        nextDayHours: 0,
        nextDayCount: 0,
        compOffDays: 0,
        compOffDaysAdjusted: 0,
        compOffAdjusted: 0,
        otLinks: [],
        coverLinks: [],
        compOffLinks: [],
    };
}

function addLink(list, text) {
    const line = String(text || '').trim();
    if (!line || list.includes(line)) return;
    list.push(line);
}

function clockToMinutes(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Work on a week off or holiday is settled once overtime or comp off is approved.
 * It is not a normal worked day. Approved overtime still keeps the off-day pay.
 */
function settleOffDayWork(day, date, info) {
    if (!day || !(day.workedHours > 0)) return false;
    if (!info?.holiday && !info?.weeklyOff) return false;
    if (day.nextDayCount > 0 || day.compOffDays > 0) return true;
    if (day.payable > 0) return true;
    return false;
}

/** Paid overtime hours. HR approval is required. Hours already used as another day's present are not paid again. */
function hrApprovedOtHours(row, usedOnAnotherDay) {
    if (String(row?.flexibleOtStatus || '') !== 'approved') return 0;
    if (String(row?.flexibleOtNextDayDate || '').trim() || usedOnAnotherDay) return 0;
    return roundHours(row?.flexibleOtApprovedHours);
}

function grantedOtHours(row) {
    if (String(row?.flexibleOtStatus || '') !== 'approved') return 0;
    return roundHours(row?.flexibleOtApprovedHours);
}

function isOtPunchPlaceholder(row) {
    const inn = String(row?.timeIn || '').trim();
    const out = String(row?.timeOut || '').trim();
    return inn === 'OT' || out === 'OT';
}

/** The employee punched a holiday or weekly off. */
export function workedOffDay(record) {
    if (!record || isOtPunchPlaceholder(record)) return false;
    return Boolean(String(record.timeIn || '').trim() || String(record.timeOut || '').trim());
}

/**
 * A week off or holiday keeps its day amount.
 * A punch, pending overtime, approved overtime, or comp off does not remove it.
 * Sandwich leave is excluded by the caller.
 * Approved overtime is extra pay on top, and hours used as comp off are not paid again as overtime.
 */
export function earnsOffDayPay() {
    return true;
}

function isSyntheticOtDay(row) {
    return isOtPunchPlaceholder(row) || Boolean(String(row?.flexibleFromOtDate || '').trim());
}

/** Check-in to check-out. A next-day row has no punches, so it adds nothing. */
function measuredHours(row) {
    if (!row || isOtPunchPlaceholder(row)) return 0;
    const start = clockToMinutes(row.timeIn);
    const end = clockToMinutes(row.timeOut);
    if (start != null && end != null) {
        const date = String(row.date || '').trim();
        const outDate = String(row.timeOutDate || '').trim();
        if (outDate && date && outDate > date) {
            const from = new Date(`${date}T12:00:00.000Z`);
            const to = new Date(`${outDate}T12:00:00.000Z`);
            const days = Math.round((to.getTime() - from.getTime()) / 86400000);
            if (days > 0) return roundHours((end - start + days * 24 * 60) / 60);
        }
        let diff = end - start;
        if (diff <= 0) diff += 24 * 60;
        return roundHours(diff / 60);
    }
    const stored = Number(row.flexibleWorkedHours) || 0;
    return stored > 0 ? roundHours(stored) : 0;
}

function preferRow(current, next) {
    if (!current) return next;
    const currentPunch = String(current.timeIn || '').trim();
    const nextPunch = String(next.timeIn || '').trim();
    if ((!currentPunch || currentPunch === 'OT') && nextPunch && nextPunch !== 'OT') return next;
    return current;
}

function emptyInfo() {
    return { required: false, scheduledHours: 0, weeklyOff: false, holiday: false };
}

/**
 * Chosen hours on an authorized leave, as a share of one day.
 * 0 means the day is paid. Null means the leave still uses the policy.
 */
export function explicitAuthorizedHourShare(row) {
    if (!row || String(row.statusKey || '') !== 'authorized_leave') return null;
    const mode = String(row.hourAdjustMode || '').trim();
    if (mode !== 'authorized' && mode !== 'custom') return null;
    if (String(row.hourAdjustStatus || '') !== 'approved') return null;
    const approved = Number(row.hoursApproved);
    const taken = Number(row.hoursTaken);
    const hours = Number.isFinite(approved) && approved > 0 ? approved : 0;
    const dayHours = Number.isFinite(taken) && taken > 0 ? taken : 0;
    if (!(hours > 0)) return 0;
    if (!(dayHours > 0)) return 1;
    return hours / dayHours;
}

/**
 * A zero-hour approval restores a late, early, or missed punch.
 * Authorized leave stays unpaid unless the chosen hours are 0.
 * An explicit deduction waive pays the day, including authorized leave.
 */
export function hourApprovalRestoresPay(row) {
    if (!row) return false;
    if (row.deductionWaived === true) return true;
    if (String(row.statusKey || '') === 'authorized_leave') return explicitAuthorizedHourShare(row) === 0;
    return String(row.hourAdjustStatus || '') === 'approved' && !(Number(row.hoursApproved) > 0);
}

/** Waive, or an approval that clears the deduction, restores the day. */
function deductionForgiven(row) {
    return hourApprovalRestoresPay(row);
}

/**
 * A green present day, including one whose deduction was waived.
 * It is not a short day, so the missing hours are not deducted.
 * Authorized leave is paid only when that deduction was waived.
 */
function isPaidPresentDay(day) {
    if (!day || day.synthetic) return false;
    if (day.forgiven) return true;
    if (String(day.statusKey || '') === 'authorized_leave') return false;
    const key = String(day.statusKey || '');
    return key === 'on_office' || key === 'work_from_home';
}

/** The hours that count for the day. A green day gets the full day, and that day stops at 10 hours. */
function countedDayHours(day, scheduledHours) {
    if (isPaidPresentDay(day)) return dayCapHours({ scheduledHours });
    return creditedDayHours(day?.workedHours, scheduledHours);
}

/** Present, late arrival, early go, and work from home. A real attendance day still counts when it is also a comp-off adjustment. */
function countsAsWorked(day) {
    if (!day || day.synthetic) return false;
    const key = String(day.statusKey || '');
    if (key === 'authorized_leave' || key === 'unauthorized_leave' || key === 'on_leave' || key === 'sick_leave' || key === 'compoff_leave') return false;
    return WORKED_STATUS_KEYS.has(key);
}

function isCompOffRemainder(day) {
    if (!day) return false;
    return day.statusKey === 'compoff_leave' || day.synthetic || day.covered;
}

function emptyBalancePay() {
    return {
        requiredDays: 0,
        requiredHours: 0,
        workedDays: 0,
        workedHours: 0,
        compOffDays: 0,
        compOffHours: 0,
        otHours: 0,
        creditedHours: 0,
        gapHours: 0,
        hourly: 0,
        unitHours: 0,
        monthWorkingDays: 0,
        monthlySalary: 0,
        amount: 0,
        requiredRows: [],
        workedRows: [],
        compOffRows: [],
        otRows: [],
        calculation: [],
    };
}

export function emptyWeeklySalaryAddition() {
    return {
        overtime: { approved: 0, adjusted: 0, balance: 0, title: '', views: [] },
        compOff: { approved: 0, adjusted: 0, balance: 0, title: '', views: [] },
        workingDay: { required: 0, worked: 0, adjusted: 0, balance: 0, title: '', compOffDays: 0, compOffTitle: '' },
        workingHours: { required: 0, worked: 0, adjusted: 0, balance: 0, title: '' },
        total: 0,
        details: [],
        balancePay: emptyBalancePay(),
        calendar: {},
    };
}

export function buildWeeklySalaryAddition({
    monthKey,
    countTo = '',
    joinKey = '',
    records = [],
    daily = 0,
    flexible = false,
    weekDates = [],
    extraDates = [],
    dayInfo = () => emptyInfo(),
    monthlySalary = 0,
    monthWorkingDays = 0,
} = {}) {
    const month = String(monthKey || '');
    const weekSet = new Set([...(weekDates || []), ...(extraDates || [])]);
    if (!/^\d{4}-\d{2}$/.test(month) || !weekSet.size) return emptyWeeklySalaryAddition();

    const inCount = (date) => {
        if (!date.startsWith(month)) return false;
        if (joinKey && date < joinKey) return false;
        if (!countTo || date > countTo) return false;
        return true;
    };
    const infoOf = (date) => {
        const info = dayInfo(date) || emptyInfo();
        return {
            required: Boolean(info.required) && inCount(date),
            scheduledHours: Math.max(0, Number(info.scheduledHours) || 0),
            weeklyOff: Boolean(info.weeklyOff),
            holiday: Boolean(info.holiday),
        };
    };

    const byDate = new Map();
    (records || []).forEach((row) => {
        const date = String(row?.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !inCount(date)) return;
        byDate.set(date, preferRow(byDate.get(date), row));
    });
    const coveredSourceDates = new Set();
    byDate.forEach((row) => {
        const source = String(row?.flexibleFromOtDate || '').trim();
        if (source) coveredSourceDates.add(source);
    });

    const ledger = new Map();
    const ensure = (date) => {
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        if (!ledger.has(date)) ledger.set(date, blankDay(date));
        return ledger.get(date);
    };
    const compOffs = [];

    const markOverDay = (target, source, hours) => {
        // Covering an authorized leave is an adjustment. It is not extra pay.
        if (!target || !String(target).startsWith(month)) return;
        const covered = ensure(target);
        if (!covered) return;
        covered.covered = true;
        covered.coverSource = source;
        covered.incoming = roundHours(covered.incoming + hours);
        addLink(covered.coverLinks, `${formatAdditionDay(target)} adjusted with ${formatAdditionDay(source)}`);
    };

    byDate.forEach((row, date) => {
        const day = ensure(date);
        const status = String(row?.statusKey || '');
        const granted = grantedOtHours(row);
        const approved = hrApprovedOtHours(row, coveredSourceDates.has(date));
        const requiredField = Number(row?.flexibleRequiredHours) || 0;
        const nextDay = String(row?.flexibleOtNextDayDate || '').trim();
        const fromDay = String(row?.flexibleFromOtDate || '').trim();
        const synthetic = isOtPunchPlaceholder(row);
        const legacyDay = granted > 10 && !requiredField;
        const punchKind = punchAttendanceKind(row);
        day.statusKey = punchKind || status;
        day.synthetic = synthetic;
        day.fromDay = fromDay;
        day.attendanceId = String(row?._id || row?.id || row?.attendanceId || '');
        day.workedHours = measuredHours(row);
        day.forgiven = !synthetic && deductionForgiven(row);

        if (status === 'compoff_leave') {
            const charge = String(row?.compOff?.chargeMonth || '').trim() || date.slice(0, 7);
            if (charge === month) {
                const state = String(row?.compOff?.state || '');
                day.compOffDays += 1;
                if (state === 'adjusted') {
                    day.compOffDaysAdjusted += 1;
                    const hours = roundHours(row?.compOff?.otHoursDeducted) || COMP_OFF_DAY_HOURS;
                    compOffs.push({ date, hours, covered: 0, sources: [], day });
                }
            }
            return;
        }

        if (flexible) {
            if (nextDay && granted > 0) {
                const required = Number(row?.flexibleRequiredHours) || infoOf(date).scheduledHours || 0;
                const split = splitNextDayHours(granted, required);
                const coveredHours = split.dayHours > 0 ? split.dayHours : granted;
                day.nextDayDate = nextDay;
                day.nextDayHours = roundHours(day.nextDayHours + coveredHours);
                day.nextDayCount += 1;
                addLink(day.compOffLinks, `${formatAdditionDay(nextDay)} adjusted with ${formatAdditionDay(date)}`);
                markOverDay(nextDay, date, coveredHours);
            } else if (fromDay && approved > 0) {
                day.payable = roundHours(day.payable + approved);
            } else if (legacyDay) {
                const split = splitNextDayHours(granted, requiredField || 0);
                const coveredHours = split.dayHours > 0 ? split.dayHours : granted;
                day.nextDayHours = roundHours(day.nextDayHours + coveredHours);
                day.nextDayCount += 1;
                addLink(day.compOffLinks, `${formatAdditionDay(date)} adjusted as comp off`);
                if (synthetic) markOverDay(date, date, coveredHours);
            } else if (approved > 0) {
                day.payable = roundHours(day.payable + approved);
            }
            if (fromDay) {
                day.covered = true;
                day.coverSource = fromDay;
                addLink(day.coverLinks, `${formatAdditionDay(date)} adjusted with ${formatAdditionDay(fromDay)}`);
            }
            settleOffDayWork(day, date, infoOf(date));
            return;
        }

        const info = infoOf(date);
        if (nextDay && granted > 0) {
            const required = Number(row?.flexibleRequiredHours) || info.scheduledHours || 0;
            const split = splitNextDayHours(granted, required);
            const coveredHours = split.dayHours > 0 ? split.dayHours : granted;
            day.nextDayDate = nextDay;
            day.nextDayHours = roundHours(day.nextDayHours + coveredHours);
            day.nextDayCount += 1;
            addLink(day.compOffLinks, `${formatAdditionDay(nextDay)} adjusted with ${formatAdditionDay(date)}`);
            markOverDay(nextDay, date, coveredHours);
            return;
        }
        if (approved > 0) day.payable = roundHours(day.payable + approved);
        if (settleOffDayWork(day, date, info)) return;
    });

    const pool = [...ledger.values()]
        .filter((day) => day.payable > 0)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((day) => ({ day, left: day.payable }));
    compOffs.sort((a, b) => a.date.localeCompare(b.date));
    compOffs.forEach((comp) => {
        let need = comp.hours;
        pool.forEach((entry) => {
            if (!(need > 0) || !(entry.left > 0)) return;
            const used = roundHours(Math.min(entry.left, need));
            entry.left = roundHours(entry.left - used);
            entry.day.consumed = roundHours(entry.day.consumed + used);
            need = roundHours(need - used);
            comp.covered = roundHours(comp.covered + used);
            comp.sources.push({ date: entry.day.date, hours: used });
            addLink(
                entry.day.otLinks,
                `${formatAdditionDay(entry.day.date)} adjusted with comp off on ${formatAdditionDay(comp.date)} (${hourPhrase(used)})`,
            );
        });
        comp.day.compOffAdjusted = comp.covered;
        if (comp.sources.length) {
            const bits = comp.sources.map((source) => `${formatAdditionDay(source.date)} (${hourPhrase(source.hours)})`);
            const joined = bits.length === 1
                ? bits[0]
                : `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`;
            addLink(comp.day.compOffLinks, `${formatAdditionDay(comp.date)} adjusted from overtime on ${joined}`);
        }
    });

    ledger.forEach((day) => {
        if (!day.covered || day.incoming > 0) return;
        const scheduled = infoOf(day.date).scheduledHours;
        if (scheduled > 0) day.incoming = scheduled;
    });

    const titles = (days, key) => {
        const lines = [];
        days.forEach((day) => day[key].forEach((line) => addLink(lines, line)));
        return lines.join('\n');
    };
    const inWeek = (day) => weekSet.has(day.date);

    let otApproved = 0;
    let otAdjusted = 0;
    let otBalance = 0;
    let compApproved = 0;
    let compAdjusted = 0;
    let requiredDays = 0;
    let workedDays = 0;
    let compOffRemaining = 0;
    const compOffLines = [];
    let requiredHours = 0;
    let workedHours = 0;
    let adjustedHours = 0;
    const weekDays = [...ledger.values()].filter(inWeek);
    weekDays.forEach((day) => {
        otApproved = roundHours(otApproved + day.payable + day.moved);
        otAdjusted = roundHours(otAdjusted + day.moved + day.consumed);
        otBalance = roundHours(otBalance + Math.max(0, day.payable - day.consumed));
        compApproved += day.compOffDays;
        compAdjusted += day.compOffDaysAdjusted;
        const source = day.coverSource ? ledger.get(day.coverSource) : null;
        const sourceOwnsCompOff = Boolean(source && source.nextDayCount > 0);
        if (day.nextDayCount > 0) {
            compApproved += day.nextDayCount;
            compAdjusted += day.nextDayCount;
        } else if (!sourceOwnsCompOff && day.covered) {
            compApproved += 1;
            compAdjusted += 1;
            day.coverLinks.forEach((line) => addLink(day.compOffLinks, line));
        }
    });

    weekSet.forEach((date) => {
        const info = infoOf(date);
        if (!info.required) return;
        requiredDays += 1;
        const dayCap = info.scheduledHours > DAY_HOUR_CAP ? DAY_HOUR_CAP : roundHours(info.scheduledHours);
        requiredHours = roundHours(requiredHours + dayCap);
        const day = ledger.get(date);
        if (isCompOffRemainder(day) && !day?.forgiven) {
            compOffRemaining += 1;
            adjustedHours = roundHours(adjustedHours + dayCap);
            const lines = [...(day.compOffLinks || []), ...(day.coverLinks || [])];
            if (lines.length) lines.forEach((line) => addLink(compOffLines, line));
            else addLink(compOffLines, `${formatAdditionDay(date)} is comp off`);
        } else if (isPaidPresentDay(day) || countsAsWorked(day)) {
            workedDays += 1;
            workedHours = roundHours(workedHours + countedDayHours(day, info.scheduledHours));
        }
    });

    const dayRate = Number(daily) || 0;
    const hourRate = dayRate / 10;
    const detailDates = [...(weekDates || [])];
    (extraDates || []).forEach((date) => {
        if (!detailDates.includes(date)) detailDates.push(date);
    });
    detailDates.sort();
    const details = [];
    detailDates.forEach((date) => {
        const day = ledger.get(date) || blankDay(date);
        const netHours = Math.max(0, roundHours(day.payable - day.consumed));
        const amount = money2(hourRate * netHours);
        const adjustedDays = day.covered ? (day.nextDayCount > 0 ? day.nextDayCount : 1) : 0;
        const adjustedHours = roundHours(day.moved + day.consumed + day.compOffAdjusted);
        const approvedOt = day.payable > 0 || day.nextDayCount > 0 || netHours > 0;
        const approvedCompOff = day.compOffDays > 0 || day.covered || day.compOffAdjusted > 0 || adjustedDays > 0;
        if (!approvedOt && !approvedCompOff && amount === 0) return;
        const linkLines = [];
        [...day.otLinks, ...day.coverLinks, ...day.compOffLinks].forEach((line) => addLink(linkLines, line));
        const calculation = [];
        if (netHours > 0) calculation.push(`${formatHourMeasure(netHours)} × ${aedText(dayRate)} ÷ 10 Hours`);
        details.push({
            date,
            label: formatAdditionDay(date),
            workedHours: roundHours(day.workedHours),
            adjustedHours,
            adjustedDays,
            title: linkLines.join('\n'),
            amount,
            calculation: calculation.join(' + '),
        });
    });

    const overDays = weekDays.filter((day) => day.nextDayCount > 0 && !day.nextDayDate && (infoOf(day.date).holiday || infoOf(day.date).weeklyOff)).length;
    const total = money2(details.reduce((sum, row) => sum + row.amount, 0));
    const balanceHours = roundHours(Math.max(0, otBalance));
    const pushView = (list, day) => {
        const date = String(day?.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || list.some((item) => item.date === date)) return;
        list.push({
            date,
            attendanceId: String(day?.attendanceId || ''),
        });
    };
    const otViews = [];
    const compViews = [];
    weekDays.forEach((day) => {
        if (day.payable > 0) pushView(otViews, day);
        if (day.compOffDays > 0) pushView(compViews, day);
        const source = day.coverSource ? ledger.get(day.coverSource) : null;
        const sourceOwnsCompOff = Boolean(source && source.nextDayCount > 0);
        if (day.covered && !sourceOwnsCompOff && !(day.nextDayCount > 0)) pushView(compViews, day);
        if (!(day.nextDayCount > 0)) return;
        if (!day.nextDayDate) {
            pushView(compViews, day);
            return;
        }
        pushView(compViews, ledger.get(day.nextDayDate) || { date: day.nextDayDate });
    });
    otViews.sort((a, b) => a.date.localeCompare(b.date));
    compViews.sort((a, b) => a.date.localeCompare(b.date));

    return {
        overtime: {
            approved: otApproved,
            adjusted: otAdjusted,
            balance: balanceHours,
            title: titles(weekDays, 'otLinks'),
            views: otViews,
        },
        compOff: {
            approved: compApproved,
            adjusted: compAdjusted,
            balance: roundHours(Math.max(0, compApproved - compAdjusted)),
            title: titles(weekDays, 'compOffLinks'),
            views: compViews,
        },
        workingDay: {
            required: requiredDays,
            worked: workedDays,
            adjusted: compOffRemaining,
            balance: requiredDays - workedDays - compOffRemaining,
            title: '',
            compOffDays: compOffRemaining,
            compOffTitle: compOffLines.join('\n'),
        },
        workingHours: {
            required: requiredHours,
            worked: workedHours,
            adjusted: adjustedHours,
            balance: roundHours(requiredHours - workedHours - adjustedHours),
            title: compOffLines.join('\n') || titles(weekDays, 'otLinks'),
        },
        overDays,
        total,
        details,
        balancePay: buildBalancePay({
            weekSet,
            ledger,
            weekDays,
            infoOf,
            requiredDays,
            requiredHours,
            workedDays,
            workedHours,
            otHours: balanceHours,
            monthlySalary,
            monthWorkingDays,
        }),
        calendar: buildCalendarNotes(weekDays, ledger),
    };
}

function dayCapHours(info) {
    const scheduled = roundHours(info?.scheduledHours);
    if (!(scheduled > 0)) return DAY_HOUR_CAP;
    return scheduled > DAY_HOUR_CAP ? DAY_HOUR_CAP : scheduled;
}

function buildCalendarNotes(weekDays, ledger) {
    const calendar = {};
    const write = (date, patch) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return;
        const current = calendar[date] || { otHours: 0, givenTo: '', takenFrom: '' };
        calendar[date] = {
            otHours: patch.otHours > 0 ? roundHours(patch.otHours) : current.otHours,
            givenTo: patch.givenTo || current.givenTo,
            takenFrom: patch.takenFrom || current.takenFrom,
        };
    };
    approvedPlacements(weekDays).forEach((row) => {
        write(row.source, { givenTo: row.target });
        write(row.target, { takenFrom: row.source });
    });
    weekDays.forEach((day) => {
        const hours = roundHours(Math.max(0, day.payable - day.consumed));
        if (hours > 0 && !(day.nextDayCount > 0)) write(day.date, { otHours: hours });
    });
    ledger.forEach((day) => {
        if (!calendar[day.date]) return;
        if (!calendar[day.date].takenFrom && day.fromDay) {
            calendar[day.date].takenFrom = day.fromDay;
        }
    });
    return calendar;
}

/** Approved next-day present days. Each placement is counted once. */
function approvedPlacements(weekDays) {
    const seen = new Set();
    const rows = [];
    const add = (source, target, hours) => {
        const key = `${source}|${target}`;
        if (!target || seen.has(key)) return;
        seen.add(key);
        rows.push({
            source: String(source || ''),
            target,
            hours: roundHours(hours),
        });
    };
    weekDays.forEach((day) => {
        if (day.nextDayCount > 0 && day.nextDayDate) add(day.date, day.nextDayDate, day.nextDayHours);
    });
    weekDays.forEach((day) => {
        if (day.statusKey === 'compoff_leave') return;
        if (!day.covered || !day.coverSource || day.coverSource === day.date) return;
        add(day.coverSource, day.date, day.incoming || day.nextDayHours);
    });
    return rows;
}

function buildBalancePay({
    weekSet,
    ledger,
    weekDays,
    infoOf,
    requiredDays,
    requiredHours,
    workedDays,
    workedHours,
    otHours,
    monthlySalary,
    monthWorkingDays,
}) {
    const capOf = (date) => dayCapHours(infoOf(date));
    const placements = approvedPlacements(weekDays).map((row) => ({
        ...row,
        hours: row.hours > 0 ? row.hours : capOf(row.target),
    }));
    const compOffHours = roundHours(placements.reduce((sum, row) => sum + row.hours, 0));
    const creditedHours = roundHours(workedHours + otHours + compOffHours);
    const gapHours = roundHours(requiredHours - creditedHours);
    const salary = Math.max(0, Number(monthlySalary) || 0);
    const monthDays = Math.max(0, Number(monthWorkingDays) || 0);
    const unit = requiredDays > 0 && requiredHours > 0
        ? roundHours(requiredHours / requiredDays)
        : DAY_HOUR_CAP;
    const hourly = monthDays > 0 && salary > 0 && unit > 0 ? salary / monthDays / unit : 0;
    const amount = money2(-gapHours * hourly);
    const requiredRows = [];
    const workedRows = [];
    [...weekSet].sort().forEach((date) => {
        const info = infoOf(date);
        if (!info.required) return;
        const day = ledger.get(date);
        requiredRows.push({
            date,
            label: formatAdditionDay(date),
            hours: capOf(date),
            attendanceId: day?.attendanceId || '',
        });
        if (!isPaidPresentDay(day) && !countsAsWorked(day)) return;
        workedRows.push({
            date,
            label: formatAdditionDay(date),
            hours: countedDayHours(day, info.scheduledHours),
            attendanceId: day?.attendanceId || '',
        });
    });
    const otRows = [];
    weekDays.forEach((day) => {
        const hours = roundHours(Math.max(0, day.payable - day.consumed));
        if (!(hours > 0) || day.nextDayCount > 0) return;
        otRows.push({
            date: day.date,
            label: formatAdditionDay(day.date),
            hours,
            attendanceId: day.attendanceId || '',
        });
    });
    otRows.sort((a, b) => a.date.localeCompare(b.date));
    const compOffRows = [];
    placements.forEach((row) => {
        compOffRows.push({
            date: row.target,
            label: formatAdditionDay(row.target),
            hours: row.hours,
            text: row.source ? `Comp off taken from ${formatAdditionDay(row.source)}` : 'Comp off taken',
            attendanceId: ledger.get(row.target)?.attendanceId || '',
        });
        if (!row.source) return;
        compOffRows.push({
            date: row.source,
            label: formatAdditionDay(row.source),
            hours: row.hours,
            text: `Comp off given to ${formatAdditionDay(row.target)}`,
            attendanceId: ledger.get(row.source)?.attendanceId || '',
        });
    });
    const gapText = gapHours > 1e-9
        ? `Short ${formatHourMeasure(gapHours)}`
        : gapHours < -1e-9
            ? `Extra ${formatHourMeasure(Math.abs(gapHours))}`
            : 'No hour difference';
    return {
        requiredDays,
        requiredHours,
        workedDays,
        workedHours,
        compOffDays: placements.length,
        compOffHours,
        otHours,
        creditedHours,
        gapHours,
        hourly,
        unitHours: unit,
        monthWorkingDays: monthDays,
        monthlySalary: salary,
        amount,
        requiredRows,
        workedRows,
        compOffRows,
        otRows,
        calculation: [
            `Monthly salary ${aedText(salary)}`,
            `Working days, holidays removed ${monthDays}`,
            `One day ${formatHourMeasure(unit)}`,
            `Hourly rate ${aedText(hourly)}`,
            `Required ${formatHourMeasure(requiredHours)}`,
            `Actual worked ${formatHourMeasure(workedHours)}`,
            `Approved overtime ${formatHourMeasure(otHours)}`,
            `Approved comp off ${placements.length} days, ${formatHourMeasure(compOffHours)}`,
            `Credited ${formatHourMeasure(workedHours)} + ${formatHourMeasure(otHours)} + ${formatHourMeasure(compOffHours)} = ${formatHourMeasure(creditedHours)}`,
            `${gapText}. Required ${formatHourMeasure(requiredHours)} − credited ${formatHourMeasure(creditedHours)}`,
            `Amount ${gapHours > 1e-9 ? '−' : gapHours < -1e-9 ? '+' : ''}${aedText(Math.abs(amount))}`,
        ],
    };
}

/**
 * The approval was used to mark the next day present.
 * Those hours are comp off. A settlement that still names an hour amount stays overtime.
 */
export function approvalPlacedAsNextDay(row, uses = []) {
    if (String(row?.flexibleOtNextDayDate || '').trim()) return true;
    return (uses || []).some((use) => {
        const leaveDate = String(use?.date || '').trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(leaveDate) && !(Number(use?.hours) > 0);
    });
}

/**
 * Leave day an approved overtime was taken for.
 * A direct placement uses the chosen leave day. A comp-off settlement takes the earliest overtime.
 * hours 0 means the whole approval belongs on that leave day.
 */
export function leaveDatesTakenByOvertime(records = [], monthKey = '') {
    const prefix = String(monthKey || '');
    const inMonth = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && (!prefix || date.startsWith(prefix));
    const direct = new Map();
    const sources = [];
    const leaves = [];
    const seenSource = new Set();
    const seenLeave = new Set();

    for (const row of records || []) {
        const date = String(row?.date || '').trim();
        if (!inMonth(date)) continue;
        const nextDay = String(row?.flexibleOtNextDayDate || '').trim();
        const fromDay = String(row?.flexibleFromOtDate || '').trim();
        if (nextDay && /^\d{4}-\d{2}-\d{2}$/.test(nextDay)) direct.set(date, nextDay);
        if (fromDay && /^\d{4}-\d{2}-\d{2}$/.test(fromDay)) direct.set(fromDay, date);

        if (String(row?.statusKey || '') === 'compoff_leave' && !seenLeave.has(date)) {
            const charge = String(row?.compOff?.chargeMonth || '').trim() || date.slice(0, 7);
            if ((!prefix || charge === prefix) && String(row?.compOff?.state || '') === 'adjusted') {
                seenLeave.add(date);
                leaves.push({
                    date,
                    hours: roundHours(row?.compOff?.otHoursDeducted) || COMP_OFF_DAY_HOURS,
                });
            }
        }

        if (seenSource.has(date)) continue;
        if (String(row?.flexibleOtStatus || '') !== 'approved') continue;
        if (nextDay || fromDay) continue;
        const inn = String(row?.timeIn || '').trim();
        const out = String(row?.timeOut || '').trim();
        if (inn === 'OT' || out === 'OT') continue;
        const hours = roundHours(row?.flexibleOtApprovedHours);
        if (!(hours > 0)) continue;
        seenSource.add(date);
        sources.push({ date, hours });
    }

    sources.sort((left, right) => left.date.localeCompare(right.date));
    leaves.sort((left, right) => left.date.localeCompare(right.date));
    const pool = sources.map((row) => ({ ...row, left: row.hours }));
    const taken = new Map();
    const push = (source, leaveDate, hours) => {
        const list = taken.get(source) || [];
        list.push({ date: leaveDate, hours: roundHours(hours) });
        taken.set(source, list);
    };
    for (const leave of leaves) {
        let need = leave.hours;
        for (const source of pool) {
            if (!(need > 0) || !(source.left > 0) || direct.has(source.date)) continue;
            const used = roundHours(Math.min(source.left, need));
            source.left = roundHours(source.left - used);
            need = roundHours(need - used);
            push(source.date, leave.date, used);
        }
    }
    for (const [source, leaveDate] of direct) {
        if (!taken.has(source)) taken.set(source, [{ date: leaveDate, hours: 0 }]);
    }
    return taken;
}

function preferClockRow(current, next) {
    if (!current) return next;
    const clock = (row) => {
        const inn = String(row?.timeIn || '').trim();
        return Boolean(inn) && inn !== 'OT';
    };
    if (!clock(current) && clock(next)) return next;
    return current;
}

/**
 * Comp off days for one month.
 * Date is the comp off day. sourceDates are the overtime days that were approved for it.
 */
export function compOffReferenceLinks(records = [], monthKey = '') {
    const prefix = String(monthKey || '');
    const inMonth = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && (!prefix || date.startsWith(prefix));
    const taken = leaveDatesTakenByOvertime(records, monthKey);
    const sourcesByLeave = new Map();
    for (const [source, uses] of taken) {
        for (const use of uses || []) {
            const leaveDate = String(use?.date || '').trim();
            if (!inMonth(leaveDate)) continue;
            const list = sourcesByLeave.get(leaveDate) || [];
            if (source && !list.includes(source)) list.push(source);
            sourcesByLeave.set(leaveDate, list);
        }
    }

    const best = new Map();
    for (const row of records || []) {
        const date = String(row?.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        best.set(date, preferClockRow(best.get(date), row));
    }

    const days = new Map();
    const remember = (date, sourceDates, description) => {
        if (!inMonth(date) || days.has(date)) return;
        const unique = [];
        (sourceDates || []).forEach((source) => {
            const key = String(source || '').trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(key) && !unique.includes(key)) unique.push(key);
        });
        unique.sort();
        days.set(date, {
            date,
            sourceDates: unique,
            description: String(description || '').trim(),
        });
    };

    for (const row of best.values()) {
        const date = String(row?.date || '').trim();
        const compOff = String(row?.statusKey || '') === 'compoff_leave';
        const fromDay = String(row?.flexibleFromOtDate || '').trim();
        const placeholder = Boolean(fromDay)
            || (String(row?.timeIn || '').trim() === 'OT' && String(row?.timeOut || '').trim() === 'OT');
        if (!compOff && !placeholder) continue;
        if (compOff) {
            const charge = String(row?.compOff?.chargeMonth || '').trim();
            if (charge ? charge !== prefix : !inMonth(date)) continue;
        } else if (!inMonth(date)) continue;
        const linked = sourcesByLeave.get(date) || [];
        const source = [fromDay, ...linked].map((key) => best.get(key)).find((item) => item);
        remember(date, [fromDay, ...linked], source?.flexibleOtReason || row?.reason || row?.leaveRequestReason);
    }
    for (const [leaveDate, sourceDates] of sourcesByLeave) {
        if (days.has(leaveDate)) continue;
        const source = sourceDates.map((key) => best.get(key)).find((item) => item);
        remember(leaveDate, sourceDates, source?.flexibleOtReason || '');
    }

    return [...days.values()].sort((left, right) => right.date.localeCompare(left.date));
}

function qtyText(value) {
    const rounded = roundHours(value);
    if (Number.isInteger(rounded)) return String(rounded);
    return rounded.toFixed(2);
}

function rateText(value) {
    return money2(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Salary statement for the amount-to-pay window.
 * Worked days, comp off, and week offs or holidays pay the day rate.
 * Overtime pays the hour rate. Cancelled loss hours are shown and left out of the deduction.
 */
export function buildAmountToPayStatement({
    monthlySalary = 0,
    calendarDays = 0,
    workedDays = 0,
    compOffDays = 0,
    otHours = 0,
    offDays = 0,
    lossHours = 0,
    cancelledLossHours = 0,
    authorizedHours = 0,
    unauthorizedHours = 0,
    unauthorizedTimes = 2,
} = {}) {
    const salary = Math.max(0, Number(monthlySalary) || 0);
    const days = Math.max(0, Number(calendarDays) || 0);
    const perDay = days > 0 ? money2(salary / days) : 0;
    const perHour = money2(perDay / 10);
    const times = Number(unauthorizedTimes) > 0 ? Number(unauthorizedTimes) : 2;
    const line = (description, count, rate, amount, calculation) => ({
        description,
        calculation: calculation || '',
        amount: money2(amount),
        count: roundHours(count),
        rate: money2(rate),
    });
    const worked = line('Worked Days', workedDays, perDay, workedDays * perDay, `${qtyText(workedDays)} × ${rateText(perDay)}`);
    const compOff = line('Comp Off', compOffDays, perDay, compOffDays * perDay, `${qtyText(compOffDays)} × ${rateText(perDay)}`);
    const overtime = line('Overtime (OT)', otHours, perHour, (Number(otHours) || 0) * perDay / 10, `${formatHourMeasure(otHours)} × ${rateText(perHour)}`);
    const off = line('Holiday / Weekly Off', offDays, perDay, offDays * perDay, `${qtyText(offDays)} × ${rateText(perDay)}`);
    const earnings = [worked, compOff, overtime, off];
    const totalSalary = money2(earnings.reduce((sum, row) => sum + row.amount, 0));
    const loss = line('Loss Hours', lossHours, perHour, (Number(lossHours) || 0) * perDay / 10, `${qtyText(lossHours)} × ${rateText(perHour)}`);
    const cancelled = line('Loss Hours (Cancelled)', cancelledLossHours, perHour, (Number(cancelledLossHours) || 0) * perDay / 10, `${qtyText(cancelledLossHours)} × ${rateText(perHour)}`);
    const authorized = line('Authorized', authorizedHours, perHour, (Number(authorizedHours) || 0) * perDay / 10, `${qtyText(authorizedHours)} × ${rateText(perHour)}`);
    const unauthorizedAmount = (Number(unauthorizedHours) || 0) * perDay / 10 * times;
    const unauthorized = line(
        'Unauthorized',
        unauthorizedHours,
        perHour,
        unauthorizedAmount,
        `${qtyText(unauthorizedHours)} × (${rateText(perHour)} × ${qtyText(times)})`,
    );
    const deductions = [loss, cancelled, authorized, unauthorized].filter((row) => row.count > 0 || row.amount > 0);
    const totalDeduction = money2(loss.amount + authorized.amount + unauthorized.amount);
    const actual = money2(totalSalary - totalDeduction);
    return {
        perDay,
        perHour,
        monthlySalary: money2(salary),
        earnings,
        totalSalary,
        deductions,
        totalDeduction,
        actual,
    };
}
