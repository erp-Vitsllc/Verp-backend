import SalaryEnrollment from '../models/SalaryEnrollment.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH = /^\d{4}-\d{2}$/;

export function isDateKey(value) {
    return ISO_DATE.test(String(value || '').trim());
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

/**
 * Live salary processing start date.
 * Prefers a stored ISO date; otherwise salary start month + processing day (1–28).
 */
export function processingStartFromEnrollment(enrollment) {
    if (!enrollment) return '';
    const salaryDate = String(enrollment.salaryDate || enrollment.processDate || '').trim();
    if (ISO_DATE.test(salaryDate)) return salaryDate;
    const fromMonth = String(enrollment.fromMonth || '').trim();
    if (!YEAR_MONTH.test(fromMonth)) return '';
    const dayNum = Number(salaryDate);
    const day = Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 28 ? dayNum : 1;
    return `${fromMonth}-${pad2(day)}`;
}

export function resolveSalaryProcessingStartDate({ verpStartDate, enrollment } = {}) {
    const verp = String(verpStartDate || '').trim();
    if (ISO_DATE.test(verp)) return verp;
    return processingStartFromEnrollment(enrollment);
}

export function processingMonthFromStart(value) {
    const raw = String(value || '').trim();
    if (ISO_DATE.test(raw) || YEAR_MONTH.test(raw)) return raw.slice(0, 7);
    return String(value?.fromMonth || '').trim();
}

export function formatProcessingMonthLabel(monthKey) {
    const key = processingMonthFromStart(monthKey);
    if (!YEAR_MONTH.test(key)) return '';
    const [year, month] = key.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function formatProcessingDateLabel(value) {
    const raw = String(value || '').trim();
    if (ISO_DATE.test(raw)) {
        const [year, month, day] = raw.split('-').map(Number);
        return new Intl.DateTimeFormat('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(new Date(Date.UTC(year, month - 1, day)));
    }
    return formatProcessingMonthLabel(raw);
}

export function salaryOpensFromMessage(monthKey) {
    const label = formatProcessingDateLabel(monthKey);
    return label ? `This will unlock after ${label}` : '';
}

export function isSalaryMonthOpen(compareMonth, processingMonth) {
    const current = processingMonthFromStart(compareMonth);
    const start = processingMonthFromStart(processingMonth);
    if (!YEAR_MONTH.test(start)) return true;
    if (!YEAR_MONTH.test(current)) return false;
    return current >= start;
}

/** Live leave days before the salary processing start date stay hidden. */
export function isLeaveDateVisible(dateKey, processingStartDate) {
    if (!isDateKey(dateKey) || !isDateKey(processingStartDate)) return false;
    return dateKey >= processingStartDate;
}

export function leaveRangeTouchesVisiblePeriod(fromKey, toKey, processingStartDate) {
    const start = isDateKey(fromKey) ? fromKey : '';
    const end = isDateKey(toKey) ? toKey : start;
    if (!start || !isDateKey(processingStartDate)) return false;
    return end >= processingStartDate;
}

export function isEmployeeLeaveDateVisible(employeeMongoId, dateKey, visibilityByMongoId) {
    const start = visibilityByMongoId?.get(String(employeeMongoId || ''));
    if (start === undefined) return false;
    return isLeaveDateVisible(dateKey, start);
}

export function isEmployeeLeaveRangeVisible(employeeMongoId, fromKey, toKey, visibilityByMongoId) {
    const start = visibilityByMongoId?.get(String(employeeMongoId || ''));
    if (start === undefined) return false;
    return leaveRangeTouchesVisiblePeriod(fromKey, toKey, start);
}

export function leaveVisibilityByEmployeeId(employees, visibilityByMongoId) {
    const byCode = new Map();
    for (const emp of employees || []) {
        const start = visibilityByMongoId?.get(String(emp?._id || ''));
        if (start === undefined) continue;
        const code = String(emp?.employeeId || '').trim();
        if (code) byCode.set(code, start);
    }
    return byCode;
}

export function resolveLeaveVisibilityStart(entry, byMongoId, byEmployeeId) {
    const mongoId = String(entry?.employeeMongoId || '').trim();
    const code = String(entry?.employeeId || '').trim();
    if (mongoId && byMongoId?.has(mongoId)) return byMongoId.get(mongoId);
    if (code && byEmployeeId?.has(code)) return byEmployeeId.get(code);
    return undefined;
}

export function isLeaveEntryVisible(entry, byMongoId, byEmployeeId) {
    const start = resolveLeaveVisibilityStart(entry, byMongoId, byEmployeeId);
    if (start === undefined) return false;
    return isLeaveDateVisible(entry?.date, start);
}

export function isLeaveRangeEntryVisible(entry, fromKey, toKey, byMongoId, byEmployeeId) {
    const start = resolveLeaveVisibilityStart(entry, byMongoId, byEmployeeId);
    if (start === undefined) return false;
    return leaveRangeTouchesVisiblePeriod(fromKey, toKey, start);
}

/**
 * Enrolled employees only. Map key is EmployeeBasic mongo id; value is salary processing start (yyyy-MM-dd).
 */
export async function loadEnrolledLeaveVisibilityByMongoId(employees) {
    const list = Array.isArray(employees) ? employees : [];
    const codes = [
        ...new Set(list.map((emp) => String(emp?.employeeId || '').trim()).filter(Boolean)),
    ];
    if (!codes.length) return new Map();

    const [enrollments, profiles] = await Promise.all([
        SalaryEnrollment.find({ employeeId: { $in: codes } })
            .select('employeeId fromMonth salaryDate processDate')
            .lean()
            .maxTimeMS(12000),
        SalaryHistoricalProfile.find({ employeeId: { $in: codes } })
            .select('employeeId verpStartDate')
            .lean()
            .maxTimeMS(12000),
    ]);

    const enrollmentByCode = new Map(
        (enrollments || []).map((row) => [String(row.employeeId || '').trim(), row]),
    );
    const verpByCode = new Map(
        (profiles || []).map((row) => [
            String(row.employeeId || '').trim(),
            String(row.verpStartDate || '').trim(),
        ]),
    );

    const visible = new Map();
    for (const emp of list) {
        const code = String(emp?.employeeId || '').trim();
        const mongoId = String(emp?._id || '');
        if (!code || !mongoId) continue;
        const enrollment = enrollmentByCode.get(code);
        if (!enrollment) continue;
        const start = resolveSalaryProcessingStartDate({
            verpStartDate: verpByCode.get(code),
            enrollment,
        });
        if (!isDateKey(start)) continue;
        visible.set(mongoId, start);
    }
    return visible;
}
