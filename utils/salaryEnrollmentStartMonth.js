import { getScheduledEmailTimeZone, getZonedParts } from './scheduleDailyAtMidnight.js';

const YEAR_MONTH = /^\d{4}-\d{2}$/;

function pad2(n) {
    return String(n).padStart(2, '0');
}

export function salaryYearMonth(value) {
    const raw = String(value || '').trim();
    if (YEAR_MONTH.test(raw)) return raw;
    const iso = raw.match(/^(\d{4}-\d{2})/);
    return iso ? iso[1] : '';
}

export function addSalaryMonths(ym, delta) {
    const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return '';
    const date = new Date(Number(match[1]), Number(match[2]) - 1 + Number(delta || 0), 1);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export function laterSalaryMonth(a, b) {
    if (!a) return b || '';
    if (!b) return a;
    return a >= b ? a : b;
}

export function currentSalaryMonthKey(now = new Date()) {
    const dubai = getZonedParts(now, getScheduledEmailTimeZone());
    return `${dubai.year}-${pad2(dubai.month)}`;
}

/** First slip / payroll month is the 1st of the month after enrollment. */
export function firstSalaryMonthAfterEnrollment(enrollYm, now = new Date()) {
    const month = salaryYearMonth(enrollYm) || currentSalaryMonthKey(now);
    return addSalaryMonths(month, 1);
}

/**
 * New enrollments never start in the current month.
 * A requested/VERP month is kept only when it is after that next month.
 */
export function resolveNewSalaryEnrollmentFromMonth({
    requestedYm = '',
    verpStartYm = '',
    now = new Date(),
} = {}) {
    const floor = firstSalaryMonthAfterEnrollment(currentSalaryMonthKey(now), now);
    const requested = salaryYearMonth(requestedYm) || salaryYearMonth(verpStartYm);
    return laterSalaryMonth(requested, floor) || floor;
}

export function resolveExistingSalaryEnrollmentFromMonth({
    verpStartYm = '',
    currentFromMonth = '',
} = {}) {
    return (
        laterSalaryMonth(salaryYearMonth(verpStartYm), salaryYearMonth(currentFromMonth)) ||
        salaryYearMonth(verpStartYm) ||
        salaryYearMonth(currentFromMonth)
    );
}

export function listSalaryMonthsInclusive(fromYm, toYm) {
    const months = [];
    let cursor = fromYm;
    while (cursor && cursor <= toYm) {
        months.push(cursor);
        const next = addSalaryMonths(cursor, 1);
        if (!next || next === cursor) break;
        cursor = next;
    }
    return months;
}

/**
 * Months shown on an employee's salary-slip list.
 * Unenrolled employees get none. Enrolled employees start at fromMonth,
 * and a future fromMonth stays hidden until that month begins.
 */
export function salarySlipMonthRange({
    enrolled,
    fromMonth = '',
    verpStartYm = '',
    policyStartYm = '',
    now = new Date(),
} = {}) {
    if (!enrolled) return [];
    const currentYm = currentSalaryMonthKey(now);
    const employeeStartYm = salaryYearMonth(fromMonth) || salaryYearMonth(verpStartYm);
    const fromYm = laterSalaryMonth(employeeStartYm, salaryYearMonth(policyStartYm)) || employeeStartYm;
    if (!fromYm || fromYm > currentYm) return [];
    return listSalaryMonthsInclusive(fromYm, currentYm);
}

export function salarySlipMonthAllowed(monthKey, { enrolled, fromMonth = '' } = {}) {
    if (!enrolled) return false;
    const ym = salaryYearMonth(monthKey);
    const start = salaryYearMonth(fromMonth);
    if (!ym) return false;
    if (start && ym < start) return false;
    return true;
}
