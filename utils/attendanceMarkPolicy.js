import Attendance from '../models/Attendance.js';
import { dayDeductionFraction } from './dayDeductionFraction.js';
import { resolveEmployeePayrollPolicy } from './employeeLeavePolicy.js';
import {
    getScheduledPunchMinutes,
    getWeekForStaffType,
    loadWorkingTimeDoc,
    normalizeStaffType,
} from './workingTimeHelpers.js';

const LEAVE_MARK_KEYS = new Set([
    'sick_leave',
    'authorized_leave',
    'compoff_leave',
    'on_leave',
    'unauthorized_leave',
]);

const YELLOW_MARK_KEYS = new Set(['early_go', 'late_arrived', 'mispunch']);

function roundHours(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    return Math.round(hours * 100) / 100;
}

function clockToMinutes(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

function monthBounds(dateKey) {
    const month = String(dateKey || '').slice(0, 7);
    const [year, monthNum] = month.split('-').map(Number);
    const last = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
    return {
        from: `${month}-01`,
        to: `${month}-${String(last).padStart(2, '0')}`,
    };
}

/**
 * Present, and early go / late arrival / mispunch with no hours and no deduction, save immediately.
 * Leave, overtime, and any non-zero or deduction hours wait for the primary reportee, then HR.
 */
export function attendanceMarkRoute({
    statusKey,
    clockHours = 0,
    deductionHours = 0,
    approvedHours = 0,
} = {}) {
    const key = String(statusKey || '').trim();
    if (LEAVE_MARK_KEYS.has(key)) return 'approve';
    if (!YELLOW_MARK_KEYS.has(key)) return 'direct';
    const requested = roundHours(approvedHours);
    const deducted = roundHours(deductionHours);
    if (key === 'mispunch') return requested > 0 || deducted > 0 ? 'approve' : 'direct';
    return roundHours(clockHours) > 0 || requested > 0 || deducted > 0 ? 'approve' : 'direct';
}

/** Clock hours lost to early go or late arrival. A mispunch has no clock-hour loss by itself. */
export function yellowClockHours(kind, record, week) {
    const key = String(kind || '').trim();
    if (key !== 'early_go' && key !== 'late_arrived') return 0;
    const schedule = getScheduledPunchMinutes(week, record?.date);
    if (!schedule || schedule.isOffDay) return 0;
    if (key === 'early_go' && schedule.endMinutes != null) {
        const out = clockToMinutes(record?.timeOut);
        if (out == null) return 0;
        return roundHours((schedule.endMinutes - out) / 60);
    }
    if (key === 'late_arrived' && schedule.startMinutes != null) {
        const inn = clockToMinutes(record?.timeIn);
        if (inn == null) return 0;
        return roundHours((inn - schedule.startMinutes) / 60);
    }
    return 0;
}

export async function yellowMarkHours(employee, date, payload = {}) {
    const key = String(payload?.statusKey || '').trim();
    if (!YELLOW_MARK_KEYS.has(key)) return { clockHours: 0, deductionHours: 0 };
    const id = String(employee?._id || '').trim();
    const workingTime = await loadWorkingTimeDoc();
    const week = getWeekForStaffType(workingTime, normalizeStaffType(employee?.staffType));
    const clockHours = yellowClockHours(key, { ...payload, date }, week);
    if (!id) return { clockHours, deductionHours: clockHours > 0 ? clockHours : 0 };
    const { from, to } = monthBounds(date);
    const [policy, rows] = await Promise.all([
        resolveEmployeePayrollPolicy(employee),
        Attendance.find({
            employeeMongoId: id,
            date: { $gte: from, $lte: to },
        })
            .select(
                'date statusKey timeIn timeOut timeOutDate reason leaveRequestDayPart leaveDayFraction leaveDeductionTimes deductionWaived hourAdjustKind hourAdjustStatus',
            )
            .lean(),
    ]);
    const deductionHours = dayDeductionFraction(
        {
            date,
            statusKey: key,
            timeIn: payload.timeIn || '',
            timeOut: payload.timeOut || '',
            reason: payload.reason || '',
        },
        rows,
        policy,
        week,
    );
    return { clockHours, deductionHours };
}
