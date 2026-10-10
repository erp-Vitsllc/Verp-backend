import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import SalaryMonthPayment from '../models/SalaryMonthPayment.js';
import SalarySlipMonth from '../models/SalarySlipMonth.js';
import { summarizeApprovedFlexibleOvertime } from './flexibleAttendance.js';
import {
    getWeekForStaffType,
    isFlexibleTiming,
    loadWorkingTimeDoc,
    normalizeStaffType,
    OVERTIME_HOURS_PER_DAY,
    overtimeHoursFromPunch,
} from './workingTimeHelpers.js';

export const COMP_OFF_DAY_HOURS = OVERTIME_HOURS_PER_DAY;

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_KEY = /^\d{4}-\d{2}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function monthKeyFromDate(dateKey) {
    const date = String(dateKey || '').trim();
    return DATE_KEY.test(date) ? date.slice(0, 7) : '';
}

export function isMonthKey(value) {
    return MONTH_KEY.test(String(value || '').trim());
}

export function nextMonthKey(monthKey) {
    const raw = String(monthKey || '').trim();
    if (!MONTH_KEY.test(raw)) return '';
    const year = Number(raw.slice(0, 4));
    const month = Number(raw.slice(5, 7));
    const next = new Date(Date.UTC(year, month, 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthName(monthKey) {
    const raw = String(monthKey || '').trim();
    if (!MONTH_KEY.test(raw)) return '';
    return MONTH_NAMES[Number(raw.slice(5, 7)) - 1] || '';
}

export function roundHours(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

export function canAdjustFromOvertime(hours) {
    return roundHours(hours) + 1e-9 >= COMP_OFF_DAY_HOURS;
}

export function compOffState(row) {
    const state = String(row?.compOff?.state || '').trim();
    if (state === 'adjusted' || state === 'jumped' || state === 'open') return state;
    return 'open';
}

export function effectiveChargeMonth(row) {
    const stored = String(row?.compOff?.chargeMonth || '').trim();
    if (MONTH_KEY.test(stored)) return stored;
    return monthKeyFromDate(row?.date);
}

export function isUnsettledCompOff(row) {
    if (String(row?.statusKey || '').trim() !== 'compoff_leave') return false;
    return compOffState(row) !== 'adjusted';
}

export function compOffDisplayLabel(row) {
    const jumped = Number(row?.compOff?.jumpCount) > 0 || compOffState(row) === 'jumped';
    if (!jumped) return 'Comp Off Leave';
    const name = monthName(effectiveChargeMonth(row));
    return name ? `Comp Off (${name})` : 'Comp Off Leave';
}

export function compOffActions(row) {
    const state = compOffState(row);
    const jumped = Number(row?.compOff?.jumpCount) > 0 || state === 'jumped';
    if (state === 'adjusted') {
        return { canAdjust: false, canJump: false, canAuthorize: false };
    }
    if (jumped) {
        return { canAdjust: true, canJump: false, canAuthorize: true };
    }
    return { canAdjust: true, canJump: false, canAuthorize: false };
}

/** Weekday extra hours, or flexible overtime after the full present day is removed. Off-day overtime is a present day and is not included. */
export function adjustableOvertimeHoursFromRows(rows = [], week) {
    if (isFlexibleTiming(week)) {
        return roundHours(summarizeApprovedFlexibleOvertime(rows).hours);
    }
    const seen = new Set();
    let hours = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        const date = String(row?.date || '').trim();
        if (!date || seen.has(date)) continue;
        seen.add(date);
        const ot = overtimeHoursFromPunch({
            timeIn: row?.timeIn,
            timeOut: row?.timeOut,
            date,
            week,
        });
        if (!ot.hours || ot.isOffDay) continue;
        hours += ot.hours;
    }
    return roundHours(hours);
}

export function deductedCompOffHours(rows = [], monthKey = '') {
    let hours = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        if (compOffState(row) !== 'adjusted') continue;
        if (monthKey && effectiveChargeMonth(row) !== monthKey) continue;
        hours += Number(row?.compOff?.otHoursDeducted) || COMP_OFF_DAY_HOURS;
    }
    return roundHours(hours);
}

function monthBounds(monthKey) {
    const year = Number(monthKey.slice(0, 4));
    const month = Number(monthKey.slice(5, 7));
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
        from: `${monthKey}-01`,
        to: `${monthKey}-${String(last).padStart(2, '0')}`,
    };
}

function personName(employee, fallback = '') {
    const name = [employee?.firstName, employee?.lastName].filter(Boolean).join(' ').trim();
    return name || String(fallback || '').trim() || 'Employee';
}

async function employeesByCodes(employeeCodes) {
    const codes = [...new Set((employeeCodes || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!codes.length) return [];
    return EmployeeBasic.find({ employeeId: { $in: codes } })
        .select('_id employeeId firstName lastName staffType')
        .lean();
}

export async function compOffRowsForEmployees(mongoIds) {
    const ids = [...new Set((mongoIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return [];
    return Attendance.find({
        employeeMongoId: { $in: ids },
        statusKey: 'compoff_leave',
    })
        .select('date employeeMongoId employeeId employeeName statusKey compOff')
        .lean();
}

export async function unsettledCompOffMessage(employeeCodes, monthKey = '') {
    const employees = await employeesByCodes(employeeCodes);
    if (!employees.length) return '';
    const byMongo = new Map(employees.map((row) => [String(row._id), row]));
    const rows = await compOffRowsForEmployees([...byMongo.keys()]);
    const open = rows.filter((row) => {
        if (!isUnsettledCompOff(row)) return false;
        if (monthKey && effectiveChargeMonth(row) !== monthKey) return false;
        return true;
    });
    if (!open.length) return '';
    const bits = open.slice(0, 8).map((row) => {
        const employee = byMongo.get(String(row.employeeMongoId));
        const name = personName(employee, row.employeeName);
        const when = monthName(effectiveChargeMonth(row));
        return when ? `${name} on ${row.date} (${when})` : `${name} on ${row.date}`;
    });
    const more = open.length > bits.length ? ` and ${open.length - bits.length} more` : '';
    return `Comp-off is not settled for ${bits.join(', ')}${more}. Settle it before salary enroll, the salary slip, or payment.`;
}

export async function compOffMonthLocked(employeeCode, monthKey) {
    const code = String(employeeCode || '').trim();
    const month = String(monthKey || '').trim();
    if (!code || !MONTH_KEY.test(month)) return false;
    const [slip, payment] = await Promise.all([
        SalarySlipMonth.findOne({ employeeId: code, monthKey: month }).select('_id').lean(),
        SalaryMonthPayment.findOne({ monthKey: month, employeeIds: code }).select('_id').lean(),
    ]);
    if (slip) return 'The salary slip for this month is already entered.';
    if (payment) return 'Salary payment for this month is already entered.';
    return '';
}

export async function adjustableOvertimeForMonth(employee, monthKey) {
    const month = String(monthKey || '').trim();
    if (!employee?._id || !MONTH_KEY.test(month)) {
        return { hours: 0, deducted: 0, available: 0 };
    }
    const { from, to } = monthBounds(month);
    const workingTime = await loadWorkingTimeDoc();
    const week = getWeekForStaffType(workingTime, normalizeStaffType(employee.staffType));
    const punches = await Attendance.find({
        employeeMongoId: String(employee._id),
        date: { $gte: from, $lte: to },
    })
        .select('date timeIn timeOut flexibleOtStatus flexibleOtApprovedHours flexibleOtNextDayDate')
        .lean();
    const gross = adjustableOvertimeHoursFromRows(punches, week);
    const compOffs = await Attendance.find({
        employeeMongoId: String(employee._id),
        statusKey: 'compoff_leave',
    })
        .select('date statusKey compOff')
        .lean();
    const deducted = deductedCompOffHours(compOffs, month);
    return {
        hours: gross,
        deducted,
        available: roundHours(Math.max(0, gross - deducted)),
    };
}

function calculationOf(row) {
    if (compOffState(row) !== 'adjusted') return null;
    return {
        before: roundHours(row?.compOff?.otHoursBefore),
        deducted: roundHours(row?.compOff?.otHoursDeducted) || COMP_OFF_DAY_HOURS,
        after: roundHours(row?.compOff?.otHoursAfter),
    };
}

export async function loadCompOffMonth({ employeeMongoId, date }) {
    const mongoId = String(employeeMongoId || '').trim();
    const dateKey = String(date || '').trim();
    if (!mongoId || !DATE_KEY.test(dateKey)) {
        return { error: 'Employee and date are required.', status: 400 };
    }
    const employee = await EmployeeBasic.findById(mongoId)
        .select('_id employeeId firstName lastName staffType')
        .lean();
    if (!employee) return { error: 'Employee not found.', status: 404 };

    const selected = await Attendance.findOne({
        employeeMongoId: mongoId,
        date: dateKey,
        statusKey: 'compoff_leave',
    }).lean();
    if (!selected) {
        return { error: 'This day is not a comp-off leave.', status: 404 };
    }

    const chargeMonth = effectiveChargeMonth(selected);
    const overtime = await adjustableOvertimeForMonth(employee, chargeMonth);
    const rows = await Attendance.find({
        employeeMongoId: mongoId,
        statusKey: 'compoff_leave',
    })
        .select('date statusKey statusLabel compOff')
        .lean();
    const monthRows = rows
        .filter((row) => effectiveChargeMonth(row) === chargeMonth)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const lockedReason = await compOffMonthLocked(employee.employeeId, chargeMonth);
    const actions = compOffActions(selected);
    const canAdjust = Boolean(actions.canAdjust) && !lockedReason && canAdjustFromOvertime(overtime.available);

    return {
        data: {
            employeeMongoId: mongoId,
            employeeId: employee.employeeId || '',
            employeeName: personName(employee, selected.employeeName),
            date: dateKey,
            chargeMonth,
            chargeMonthName: monthName(chargeMonth),
            label: compOffDisplayLabel(selected),
            state: compOffState(selected),
            jumpCount: Number(selected?.compOff?.jumpCount) || 0,
            locked: Boolean(lockedReason),
            lockReason: lockedReason || '',
            overtimeHours: overtime.available,
            overtimeGrossHours: overtime.hours,
            overtimeDeductedHours: overtime.deducted,
            dayHours: COMP_OFF_DAY_HOURS,
            compOffCount: monthRows.length,
            compOffs: monthRows.map((row) => ({
                date: row.date,
                label: compOffDisplayLabel(row),
                state: compOffState(row),
                selected: row.date === dateKey,
                calculation: calculationOf(row),
            })),
            calculation: calculationOf(selected),
            canAdjust,
            canJump: Boolean(actions.canJump) && !lockedReason,
            canAuthorize: Boolean(actions.canAuthorize) && !lockedReason,
            adjustShortfall: canAdjustFromOvertime(overtime.available)
                ? 0
                : roundHours(COMP_OFF_DAY_HOURS - overtime.available),
        },
    };
}

async function selectedCompOff(employeeMongoId, date) {
    return Attendance.findOne({
        employeeMongoId: String(employeeMongoId || '').trim(),
        date: String(date || '').trim(),
        statusKey: 'compoff_leave',
    });
}

export async function settleCompOffDay({ employeeMongoId, date, action }) {
    const choice = String(action || '').trim();
    if (choice === 'jump') {
        return { error: 'Jump to next month is not available.', status: 400 };
    }
    if (!['adjust', 'authorize'].includes(choice)) {
        return { error: 'Choose adjust or authorize.', status: 400 };
    }
    const row = await selectedCompOff(employeeMongoId, date);
    if (!row) return { error: 'This day is not a comp-off leave.', status: 404 };

    const employee = await EmployeeBasic.findById(row.employeeMongoId)
        .select('_id employeeId firstName lastName staffType')
        .lean();
    if (!employee) return { error: 'Employee not found.', status: 404 };

    const chargeMonth = effectiveChargeMonth(row);
    const lockedReason = await compOffMonthLocked(employee.employeeId, chargeMonth);
    if (lockedReason) return { error: lockedReason, status: 409 };

    const actions = compOffActions(row);
    if (choice === 'adjust') {
        if (!actions.canAdjust) {
            return { error: 'This comp-off is already settled.', status: 400 };
        }
        const overtime = await adjustableOvertimeForMonth(employee, chargeMonth);
        if (!canAdjustFromOvertime(overtime.available)) {
            return {
                error: `Adjust from OT needs ${COMP_OFF_DAY_HOURS} hours. This month has ${roundHours(overtime.available).toFixed(2)} hours.`,
                status: 400,
            };
        }
        const before = overtime.available;
        const after = roundHours(before - COMP_OFF_DAY_HOURS);
        row.compOff = {
            ...(row.compOff?.toObject ? row.compOff.toObject() : row.compOff || {}),
            state: 'adjusted',
            chargeMonth,
            jumpCount: Number(row.compOff?.jumpCount) || 0,
            otHoursBefore: before,
            otHoursDeducted: COMP_OFF_DAY_HOURS,
            otHoursAfter: after,
            adjustedAt: new Date(),
        };
        row.markModified('compOff');
        await row.save();
        return { message: `Comp-off adjusted. Overtime ${before.toFixed(2)} h − ${COMP_OFF_DAY_HOURS} h = ${after.toFixed(2)} h.` };
    }

    if (!actions.canAuthorize) {
        return { error: 'Change to authorized leave is available after the comp-off has jumped once.', status: 400 };
    }
    row.statusKey = 'authorized_leave';
    row.statusLabel = 'Authorized Leave';
    row.leavePayType = 'unpaid';
    row.approvalStatus = 'approved';
    row.compOff = {
        ...(row.compOff?.toObject ? row.compOff.toObject() : row.compOff || {}),
        state: 'jumped',
        chargeMonth,
        jumpCount: Number(row.compOff?.jumpCount) || 1,
    };
    row.markModified('compOff');
    await row.save();
    return { message: 'Comp-off changed to authorized leave.' };
}

export async function compOffAdjustedHours(employeeMongoId, monthKey) {
    const month = String(monthKey || '').trim();
    const mongoId = String(employeeMongoId || '').trim();
    if (!mongoId || !MONTH_KEY.test(month)) return 0;
    const rows = await Attendance.find({
        employeeMongoId: mongoId,
        statusKey: 'compoff_leave',
    })
        .select('date statusKey compOff')
        .lean();
    return deductedCompOffHours(rows, month);
}
