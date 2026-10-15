import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Holiday from '../models/Holiday.js';
import { nonWorkingAttendanceMark, nonWorkingFromContext } from './attendanceNonWorkingDay.js';
import {
    getWeekForStaffType,
    isFlexibleTiming,
    loadWorkingTimeDoc,
    normalizeStaffType,
} from './workingTimeHelpers.js';
import {
    flexibleOtFieldsFromDuration,
    manualTimeOutDate,
    mergeFlexibleOtState,
    requiredHoursForDate,
} from './flexibleAttendance.js';

function hoursDiffer(left, right) {
    return Math.abs((Number(left) || 0) - (Number(right) || 0)) >= 0.001;
}

function writeFromMerged(merged) {
    const write = {
        flexibleWorkedHours: merged.flexibleWorkedHours,
        flexibleRequiredHours: merged.flexibleRequiredHours,
        flexibleOtHours: merged.flexibleOtHours,
    };
    if (merged.changed) {
        write.flexibleOtStatus = '';
        write.flexibleOtApprovedHours = 0;
        write.flexibleOtReason = '';
        write.flexibleOtNextDayDate = '';
    }
    return write;
}

function rowNeedsOtWrite(row, write, changed) {
    if (hoursDiffer(row?.flexibleOtHours, write.flexibleOtHours)) return true;
    if (hoursDiffer(row?.flexibleWorkedHours, write.flexibleWorkedHours)) return true;
    if (hoursDiffer(row?.flexibleRequiredHours, write.flexibleRequiredHours)) return true;
    if (!changed) return false;
    return Boolean(
        String(row?.flexibleOtStatus || '').trim() ||
            Number(row?.flexibleOtApprovedHours) ||
            String(row?.flexibleOtReason || '').trim() ||
            String(row?.flexibleOtNextDayDate || '').trim(),
    );
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

/** A mapped day keeps the copied punches. Remove a next-day overtime present created from this day. */
export async function dropMappedOvertime(employeeMongoId, date) {
    const id = String(employeeMongoId || '').trim();
    const day = String(date || '').trim();
    if (!id || !day) return;
    const existing = await Attendance.findOne({ date: day, employeeMongoId: id })
        .select('flexibleOtStatus flexibleOtNextDayDate')
        .lean();
    if (String(existing?.flexibleOtStatus || '') !== 'approved') return;
    await revertSyntheticOtDay(id, String(existing.flexibleOtNextDayDate || '').trim(), day);
}

/**
 * Recalculate flexible overtime from the punches stored on these rows.
 * A shorter day with no overtime clears the request button and any old request.
 */
export async function refreshFlexibleOtRecords(records) {
    const list = (records || []).filter((row) => row && row._id);
    if (!list.length) return;

    const workingTime = await loadWorkingTimeDoc();
    const dates = [...new Set(list.map((row) => String(row.date || '').trim()).filter(Boolean))];
    const holidayRows = dates.length
        ? await Holiday.find({ date: { $in: dates } }).select('date name appliesTo').lean()
        : [];
    const holidayByDate = new Map((holidayRows || []).map((row) => [String(row.date), row]));
    const ids = [
        ...new Set(
            list
                .map((row) => String(row.employeeMongoId || '').trim())
                .filter((id) => mongoose.Types.ObjectId.isValid(id)),
        ),
    ];
    const employees = ids.length
        ? await EmployeeBasic.find({ _id: { $in: ids } }).select('_id staffType').lean()
        : [];
    const staffById = new Map((employees || []).map((row) => [String(row._id), row.staffType]));
    const writes = [];

    for (const row of list) {
        if (String(row?.punchMappedFromEmployeeMongoId || '').trim()) {
            const staffType = normalizeStaffType(staffById.get(String(row.employeeMongoId)) || 'office');
            const week = getWeekForStaffType(workingTime, staffType);
            const flexible = isFlexibleTiming(week);
            const nonWorking = Boolean(
                nonWorkingFromContext({
                    holiday: holidayByDate.get(String(row.date || '')),
                    week,
                    staffType,
                    date: row.date,
                }),
            );
            const fields = flexibleOtFieldsFromDuration({
                isFlexible: flexible,
                nonWorking,
                date: row.date,
                timeIn: row.timeIn,
                timeOut: row.timeOut,
                timeOutDate: row.timeOutDate,
                requiredHours: flexible ? requiredHoursForDate(week, row.date) : 0,
                statusKey: row.statusKey,
            });
            const write = {
                flexibleWorkedHours: fields.flexibleWorkedHours,
                flexibleRequiredHours: fields.flexibleRequiredHours,
                flexibleOtHours: 0,
                flexibleOtStatus: '',
                flexibleOtApprovedHours: 0,
                flexibleOtReason: '',
                flexibleOtNextDayDate: '',
                flexibleFromOtDate: '',
            };
            const hasOvertime = Boolean(
                hoursDiffer(row.flexibleOtHours, 0) ||
                    String(row.flexibleOtStatus || '').trim() ||
                    Number(row.flexibleOtApprovedHours) ||
                    String(row.flexibleOtReason || '').trim() ||
                    String(row.flexibleOtNextDayDate || '').trim() ||
                    String(row.flexibleFromOtDate || '').trim(),
            );
            const workedChanged =
                hoursDiffer(row.flexibleWorkedHours, write.flexibleWorkedHours) ||
                hoursDiffer(row.flexibleRequiredHours, write.flexibleRequiredHours);
            if (!hasOvertime && !workedChanged) continue;
            const revert =
                String(row.flexibleOtStatus || '') === 'approved'
                    ? String(row.flexibleOtNextDayDate || '').trim()
                    : '';
            Object.assign(row, write);
            if (revert) await revertSyntheticOtDay(row.employeeMongoId, revert, row.date);
            writes.push({
                updateOne: {
                    filter: { _id: row._id },
                    update: { $set: write },
                },
            });
            continue;
        }
        const punchIn = String(row?.timeIn || '').trim();
        const punchOut = String(row?.timeOut || '').trim();
        if (punchIn === 'OT' || punchOut === 'OT' || String(row?.flexibleFromOtDate || '').trim()) continue;
        const staffType = normalizeStaffType(staffById.get(String(row.employeeMongoId)) || 'office');
        const week = getWeekForStaffType(workingTime, staffType);
        const flexible = isFlexibleTiming(week);
        const nonWorking = Boolean(
            nonWorkingFromContext({
                holiday: holidayByDate.get(String(row.date || '')),
                week,
                staffType,
                date: row.date,
            }),
        );
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: flexible,
            nonWorking,
            date: row.date,
            timeIn: row.timeIn,
            timeOut: row.timeOut,
            timeOutDate: row.timeOutDate,
            requiredHours: flexible ? requiredHoursForDate(week, row.date) : 0,
            statusKey: row.statusKey,
        });
        const merged = mergeFlexibleOtState(row, fields);
        const write = writeFromMerged(merged);
        if (!rowNeedsOtWrite(row, write, merged.changed)) continue;
        Object.assign(row, write);
        if (merged.revertNextDayDate) {
            await revertSyntheticOtDay(row.employeeMongoId, merged.revertNextDayDate, row.date);
        }
        writes.push({
            updateOne: {
                filter: { _id: row._id },
                update: { $set: write },
            },
        });
    }

    if (writes.length) await Attendance.bulkWrite(writes);
}

/** Fields to store when attendance times are edited by hand. */
export async function flexibleOtManualUpdate({ employee, date, timeIn, timeOut, statusKey }) {
    const employeeMongoId = String(employee?._id || '').trim();
    const existing =
        employeeMongoId && mongoose.Types.ObjectId.isValid(employeeMongoId)
            ? await Attendance.findOne({ date, employeeMongoId })
                  .select(
                      'flexibleOtHours flexibleOtStatus flexibleOtApprovedHours flexibleOtReason flexibleOtNextDayDate',
                  )
                  .lean()
            : null;
    const workingTime = await loadWorkingTimeDoc();
    const staffType = normalizeStaffType(employee?.staffType);
    const week = getWeekForStaffType(workingTime, staffType);
    const flexible = isFlexibleTiming(week);
    const nonWorking = Boolean(await nonWorkingAttendanceMark(employee, date));
    const timeOutDate = manualTimeOutDate(date, timeIn, timeOut);
    const fields = flexibleOtFieldsFromDuration({
        isFlexible: flexible,
        nonWorking,
        date,
        timeIn,
        timeOut,
        timeOutDate,
        requiredHours: flexible ? requiredHoursForDate(week, date) : 0,
        statusKey,
    });
    const merged = mergeFlexibleOtState(existing, fields);
    if (merged.revertNextDayDate) {
        await revertSyntheticOtDay(employeeMongoId, merged.revertNextDayDate, date);
    }
    return { timeOutDate, ...writeFromMerged(merged) };
}
