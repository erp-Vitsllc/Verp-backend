import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Holiday from '../models/Holiday.js';
import {
    getWeekForStaffType,
    holidayAppliesToStaff,
    isWeekOffForStaff,
    loadWorkingTimeDoc,
    normalizeStaffType,
} from './workingTimeHelpers.js';

function scheduleLabel(staffType) {
    const key = String(staffType || '').trim();
    if (!key) return 'schedule';
    return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Holiday wins over weekly off. Null on a normal working day. */
export function nonWorkingFromContext({ holiday, week, staffType, date }) {
    const type = normalizeStaffType(staffType);
    if (holiday && holidayAppliesToStaff(holiday, type)) {
        const name = String(holiday.name || '').trim();
        return {
            kind: 'holiday',
            statusKey: 'holiday',
            statusLabel: 'Holiday',
            reason: name || 'Holiday',
        };
    }
    if (isWeekOffForStaff(week, date)) {
        return {
            kind: 'weekly_off',
            statusKey: 'weekly_off',
            statusLabel: 'Off Day',
            reason: `Weekly off — ${scheduleLabel(type)} schedule`,
        };
    }
    return null;
}

export async function nonWorkingAttendanceMark(employee, date) {
    const staffType = normalizeStaffType(employee?.staffType);
    const [holiday, workingTime] = await Promise.all([
        Holiday.findOne({ date }).select('date name appliesTo').lean(),
        loadWorkingTimeDoc(),
    ]);
    const week = getWeekForStaffType(workingTime, staffType);
    return nonWorkingFromContext({ holiday, week, staffType, date });
}

async function revertSyntheticOtDay(employeeMongoId, nextDayDate, sourceDate) {
    if (!employeeMongoId || !nextDayDate || !sourceDate) return;
    await Attendance.deleteOne({
        date: nextDayDate,
        employeeMongoId: String(employeeMongoId),
        timeIn: 'OT',
        timeOut: 'OT',
        flexibleFromOtDate: sourceDate,
    });
}

const BLANK_NON_WORKING_KEYS = new Set(['', 'unauthorized_leave', 'absent', 'not_marked']);

/** Unauthorized / blank rows on a holiday or weekly off go back to that day. */
export async function repairBlankNonWorkingRows(records) {
    const list = (records || []).filter((row) => row && row._id);
    if (!list.length) return;

    const workingTime = await loadWorkingTimeDoc();
    const dates = [...new Set(list.map((row) => String(row.date || '').trim()).filter(Boolean))];
    const holidayRows = dates.length
        ? await Holiday.find({ date: { $in: dates } }).select('date name appliesTo').lean()
        : [];
    const holidayByDate = new Map((holidayRows || []).map((row) => [String(row.date), row]));
    const ids = [
        ...new Set(list.map((row) => String(row.employeeMongoId || '').trim()).filter(Boolean)),
    ];
    const employees = ids.length
        ? await EmployeeBasic.find({ _id: { $in: ids } }).select('_id staffType').lean()
        : [];
    const staffById = new Map((employees || []).map((row) => [String(row._id), row.staffType]));
    const writes = [];

    for (const row of list) {
        if (String(row.timeIn || '').trim() || String(row.timeOut || '').trim()) continue;
        const key = String(row.statusKey || '').trim();
        if (!BLANK_NON_WORKING_KEYS.has(key)) continue;
        const staffType = staffById.get(String(row.employeeMongoId)) || 'office';
        const week = getWeekForStaffType(workingTime, normalizeStaffType(staffType));
        const baseline = nonWorkingFromContext({
            holiday: holidayByDate.get(String(row.date || '')),
            week,
            staffType,
            date: row.date,
        });
        if (!baseline || baseline.statusKey === key) continue;
        const write = {
            statusKey: baseline.statusKey,
            statusLabel: baseline.statusLabel,
            reason: baseline.reason,
            flexibleOtHours: 0,
            flexibleOtStatus: '',
            flexibleOtApprovedHours: 0,
            flexibleOtReason: '',
        };
        Object.assign(row, write);
        writes.push({
            updateOne: {
                filter: { _id: row._id },
                update: { $set: write },
            },
        });
    }

    if (writes.length) await Attendance.bulkWrite(writes);
}

/**
 * Clear a manual mark. On a holiday or weekly off, put that status back
 * instead of leaving the day blank (which shows as unauthorized).
 */
export async function restoreClearedAttendance({ employeeMongoId, date, markedBy }) {
    const id = String(employeeMongoId || '').trim();
    const employee = await EmployeeBasic.findById(id)
        .select('_id employeeId firstName lastName staffType')
        .lean();
    const existing = await Attendance.findOne({ date, employeeMongoId: id })
        .select('flexibleOtStatus flexibleOtNextDayDate')
        .lean();
    if (String(existing?.flexibleOtStatus || '') === 'approved' && existing?.flexibleOtNextDayDate) {
        await revertSyntheticOtDay(id, existing.flexibleOtNextDayDate, date);
    }

    const baseline = employee ? await nonWorkingAttendanceMark(employee, date) : null;
    if (!baseline) {
        await Attendance.deleteOne({ date, employeeMongoId: id });
        return {
            date,
            employeeMongoId: id,
            cleared: true,
            statusKey: '',
            statusLabel: '',
            timeIn: '',
            timeOut: '',
        };
    }

    const employeeName = [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim();
    return Attendance.findOneAndUpdate(
        { date, employeeMongoId: id },
        {
            $set: {
                date,
                employeeMongoId: id,
                employeeId: String(employee.employeeId || ''),
                employeeName,
                statusKey: baseline.statusKey,
                statusLabel: baseline.statusLabel,
                reason: baseline.reason,
                timeIn: '',
                timeOut: '',
                timeOutDate: '',
                flexibleWorkedHours: 0,
                flexibleRequiredHours: 0,
                flexibleOtHours: 0,
                flexibleOtStatus: '',
                flexibleOtApprovedHours: 0,
                flexibleOtReason: '',
                flexibleOtNextDayDate: '',
                punchSource: '',
                checkOutSource: '',
                approvalStatus: '',
                markedBy: markedBy || null,
            },
            $unset: {
                checkInLocation: 1,
                checkOutLocation: 1,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}
