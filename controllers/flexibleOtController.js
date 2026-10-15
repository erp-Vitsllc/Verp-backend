import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import AttendanceChangeRequest from '../models/AttendanceChangeRequest.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';
import { hasPermission } from '../services/permissionService.js';
import {
    attendanceChangeQueuedMessage,
    openAttendanceChangeForEmployee,
} from '../utils/attendanceChangeApproval.js';
import {
    isCurrentMonthDate,
    isAuthorizedLeaveStatus,
    requiredHoursForDate,
    splitApprovedOvertime,
} from '../utils/flexibleAttendance.js';
import {
    flexibleHoursPerDay,
    getWeekForStaffType,
    loadWorkingTimeDoc,
    normalizeStaffType,
} from '../utils/workingTimeHelpers.js';
import { refreshFlexibleOtRecords } from '../utils/syncFlexibleOt.js';
import { notifyEmployeeFlexibleOtWhatsApp } from '../utils/sendFlexibleOtWhatsApp.js';
import { sendAttendanceDirectChangeEmail } from '../utils/sendAttendanceLeaveEmails.js';

async function resolveActor(req) {
    const select = '_id employeeId firstName lastName companyEmail';
    if (req.user?.employeeObjectId) {
        const byId = await EmployeeBasic.findById(req.user.employeeObjectId).select(select).lean();
        if (byId) return byId;
    }
    if (req.user?.employeeId) {
        return EmployeeBasic.findOne({ employeeId: req.user.employeeId }).select(select).lean();
    }
    return null;
}

function storedClock(value) {
    const text = String(value || '').trim();
    if (/^\d{1,2}:\d{2}$/.test(text)) {
        const [hour, minute] = text.split(':');
        return `${hour.padStart(2, '0')}:${minute}:00`;
    }
    return text;
}

function roundHours(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours < 0) return 0;
    return Math.round(hours * 100) / 100;
}

async function actorIsFlowchartHr(actor) {
    const hr = await getDepartmentHOD('hr').catch(() => null);
    return Boolean(hr?._id && actor?._id && String(hr._id) === String(actor._id));
}

async function workingDayHours(record) {
    const stored = Number(record?.flexibleRequiredHours) || 0;
    if (stored > 0) return stored;
    const employee = await EmployeeBasic.findById(record.employeeMongoId).select('staffType').lean();
    const workingTime = await loadWorkingTimeDoc();
    const week = getWeekForStaffType(workingTime, normalizeStaffType(employee?.staffType));
    const required = requiredHoursForDate(week, record.date);
    if (required > 0) return required;
    const standard = Number(flexibleHoursPerDay(week)) || 0;
    return standard > 0 ? standard : 0;
}

async function revertSyntheticOtDay(employeeMongoId, nextDayDate, sourceDate) {
    if (!employeeMongoId || !nextDayDate || !sourceDate) return;
    await Attendance.deleteOne({
        date: nextDayDate,
        employeeMongoId,
        timeIn: 'OT',
        timeOut: 'OT',
        flexibleFromOtDate: sourceDate,
    });
}

async function resolveNextDayPlacement(record, { approvedHours, confirmNextDay, targetDate }) {
    const dayHours = await workingDayHours(record);
    const split = splitApprovedOvertime(approvedHours, dayHours);
    if (!confirmNextDay) {
        return { split, placeOnAnotherDay: false, nextDate: '' };
    }
    if (!split.nextDay) {
        return {
            error: {
                status: 400,
                body: { message: 'Approved hours must cover one working day.' },
            },
        };
    }
    const nextDate = String(targetDate || '').trim();
    if (!isCurrentMonthDate(record.date, nextDate)) {
        return {
            error: {
                status: 400,
                body: { message: 'Choose an authorized leave day in this month.' },
            },
        };
    }
    const existingNext = await Attendance.findOne({
        date: nextDate,
        employeeMongoId: record.employeeMongoId,
    }).lean();
    const alreadyFromThis =
        String(existingNext?.flexibleFromOtDate || '') === String(record.date) &&
        String(existingNext?.timeIn || '').trim() === 'OT';
    if (!alreadyFromThis && !isAuthorizedLeaveStatus(existingNext?.statusKey, existingNext?.statusLabel)) {
        return {
            error: {
                status: 400,
                body: { message: 'That day is not authorized leave.' },
            },
        };
    }
    return { split, placeOnAnotherDay: true, nextDate };
}

export async function approveFlexibleOvertimeRecord(record, { approvedHours, reason, confirmNextDay, targetDate, actor }) {
    const approved = roundHours(approvedHours);
    const placement = await resolveNextDayPlacement(record, {
        approvedHours: approved,
        confirmNextDay: confirmNextDay === true,
        targetDate,
    });
    if (placement.error) return placement.error;
    const { split, placeOnAnotherDay, nextDate } = placement;
    const previousNext = String(record.flexibleOtNextDayDate || '').trim();

    record.flexibleOtStatus = 'approved';
    record.flexibleOtApprovedHours = approved;
    if (reason != null) record.flexibleOtReason = reason;

    if (!placeOnAnotherDay) {
        if (previousNext) await revertSyntheticOtDay(record.employeeMongoId, previousNext, record.date);
        record.flexibleOtNextDayDate = '';
        await record.save();
        await notifyEmployeeFlexibleOtWhatsApp({
            record,
            nextDayPresent: false,
            approvedHours: approved,
            actor,
        });
        return {
            status: 200,
            body: { record, displayOtHours: approved, nextDayPresent: false },
        };
    }

    if (previousNext && previousNext !== nextDate) {
        await revertSyntheticOtDay(record.employeeMongoId, previousNext, record.date);
    }

    const employee = await EmployeeBasic.findById(record.employeeMongoId)
        .select('employeeId firstName lastName')
        .lean();
    await Attendance.findOneAndUpdate(
        { date: nextDate, employeeMongoId: record.employeeMongoId },
        {
            $set: {
                date: nextDate,
                employeeMongoId: record.employeeMongoId,
                employeeId: employee?.employeeId || record.employeeId || '',
                employeeName: record.employeeName || '',
                statusKey: 'on_office',
                statusLabel: 'Present',
                timeIn: 'OT',
                timeOut: 'OT',
                timeOutDate: '',
                reason: 'Present (On time) from overtime',
                approvalStatus: 'approved',
                leaveRequestStatus: '',
                leaveRequestKind: '',
                hourAdjustStatus: '',
                hourAdjustKind: '',
                hoursApproved: 0,
                flexibleFromOtDate: record.date,
                flexibleWorkedHours: split.dayHours,
                flexibleRequiredHours: split.dayHours,
                flexibleOtHours: split.remainderHours,
                flexibleOtStatus: '',
                flexibleOtApprovedHours: 0,
                flexibleOtReason: '',
                flexibleOtNextDayDate: '',
                punchSource: 'manual',
                checkOutSource: 'manual',
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    record.flexibleOtNextDayDate = nextDate;
    await record.save();
    await notifyEmployeeFlexibleOtWhatsApp({
        record,
        nextDayPresent: true,
        approvedHours: approved,
        remainderHours: split.remainderHours,
        actor,
    });
    return {
        status: 200,
        body: {
            record,
            displayOtHours: 0,
            nextDayPresent: true,
            remainderHours: split.remainderHours,
        },
    };
}

function previousAttendanceSnapshot(record) {
    return {
        statusKey: record?.statusKey || '',
        statusLabel: record?.statusLabel || 'Not marked',
        timeIn: record?.timeIn || '',
        timeOut: record?.timeOut || '',
        reason: record?.reason || '',
    };
}

export async function requestFlexibleOvertime(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }
        const actor = await resolveActor(req);
        if (!actor) return res.status(404).json({ message: 'No linked employee profile found.' });

        const attendanceId = String(req.body?.attendanceId || '').trim();
        const approvedHours = roundHours(req.body?.approvedHours);
        const reason = String(req.body?.reason || '').trim();
        if (!mongoose.Types.ObjectId.isValid(attendanceId)) {
            return res.status(400).json({ message: 'Attendance record is required.' });
        }
        if (!reason) return res.status(400).json({ message: 'Reason is required.' });
        if (approvedHours <= 0) return res.status(400).json({ message: 'Approved hours are required.' });

        const record = await Attendance.findById(attendanceId);
        if (!record) return res.status(404).json({ message: 'Attendance record not found.' });
        if (!String(record.timeIn || '').trim() || !String(record.timeOut || '').trim()) {
            return res.status(400).json({ message: 'Check-out is required before requesting overtime.' });
        }
        await refreshFlexibleOtRecords([record]);
        if (!(Number(record.flexibleOtHours) > 0)) {
            return res.status(400).json({ message: 'This day has no overtime to request.' });
        }

        const employee = await EmployeeBasic.findById(record.employeeMongoId)
            .select('_id employeeId firstName lastName primaryReportee companyEmail workEmail email')
            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail email')
            .lean();
        const reporteeId = employee?.primaryReportee?._id || employee?.primaryReportee || '';
        const isReportee = Boolean(reporteeId && String(reporteeId) === String(actor._id));
        const isHr = await actorIsFlowchartHr(actor);
        const permitted = req.user?.id
            ? await hasPermission(req.user.id, 'hrm_attendance_ot', 'view')
            : false;
        if (!isHr && !isReportee && !permitted) {
            return res.status(403).json({
                message: 'Enable Apply OT and next day present on your permission group to use this.',
            });
        }

        const confirmNextDay = req.body?.confirmNextDay === true;
        const targetDate = String(req.body?.targetDate || '').trim();
        const placement = await resolveNextDayPlacement(record, {
            approvedHours,
            confirmNextDay,
            targetDate,
        });
        if (placement.error) {
            return res.status(placement.error.status).json(placement.error.body);
        }

        if (confirmNextDay) {
            const applied = await approveFlexibleOvertimeRecord(record, {
                approvedHours,
                reason,
                confirmNextDay,
                targetDate,
                actor,
            });
            if (applied.status !== 200) {
                return res.status(applied.status).json(applied.body);
            }
            if (!isHr) {
                const hr = await getDepartmentHOD('hr').catch(() => null);
                try {
                    await sendAttendanceDirectChangeEmail({
                        recipients: [hr, employee?.primaryReportee].filter(Boolean),
                        actor,
                        employee,
                        date: targetDate || record.date,
                        previousLabel: 'Authorized leave',
                        nextLabel: `Present from overtime on ${record.date}`,
                        reason,
                    });
                } catch (mailErr) {
                    console.error('[requestFlexibleOvertime] notice email failed:', mailErr?.message || mailErr);
                }
            }
            return res.status(200).json({
                message: 'Present set on the selected day.',
                applied: true,
                ...applied.body,
            });
        }

        const hr = await getDepartmentHOD('hr').catch(() => null);
        const queued = await openAttendanceChangeForEmployee({
            employee,
            date: record.date,
            proposed: {
                statusKey: record.statusKey || '',
                statusLabel: confirmNextDay
                    ? `Next day present on ${targetDate}`
                    : `OT Approval ${approvedHours} hr`,
                reason,
                attendanceId: String(record._id),
                flexibleOtApprovedHours: approvedHours,
                flexibleOtHours: roundHours(record.flexibleOtHours),
                timeIn: String(req.body?.timeIn || record.timeIn || '').trim(),
                timeOut: String(req.body?.timeOut || record.timeOut || '').trim(),
                confirmNextDay,
                targetDate: confirmNextDay ? targetDate : '',
            },
            previous: previousAttendanceSnapshot(record),
            actor,
            hr,
            action: 'flexible_ot',
        });
        if (queued.error) return res.status(400).json({ message: queued.error });
        return res.status(200).json({
            message: attendanceChangeQueuedMessage(queued.pending?.stage),
            pending: queued.pending,
        });
    } catch (error) {
        console.error('[requestFlexibleOvertime]', error);
        return res.status(500).json({ message: error.message || 'Failed to request overtime.' });
    }
}

export async function decideFlexibleOvertime(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }
        const actor = await resolveActor(req);
        if (!actor) return res.status(404).json({ message: 'No linked employee profile found.' });
        if (!(await actorIsFlowchartHr(actor))) {
            return res.status(403).json({ message: 'Only flowchart HR can approve or reject this overtime.' });
        }

        const attendanceId = String(req.body?.attendanceId || '').trim();
        const decision = String(req.body?.decision || '').trim().toLowerCase();
        const confirmNextDay = req.body?.confirmNextDay === true;
        if (!mongoose.Types.ObjectId.isValid(attendanceId)) {
            return res.status(400).json({ message: 'Attendance record is required.' });
        }
        if (decision !== 'approved' && decision !== 'rejected') {
            return res.status(400).json({ message: 'Decision must be approved or rejected.' });
        }

        const record = await Attendance.findById(attendanceId);
        if (!record || record.flexibleOtStatus !== 'pending') {
            return res.status(404).json({ message: 'Pending overtime request not found.' });
        }
        const openChange = await AttendanceChangeRequest.findOne({
            action: 'flexible_ot',
            'proposed.attendanceId': attendanceId,
            stage: { $in: ['pending_reportee', 'pending_hr'] },
        })
            .select('_id')
            .lean();
        if (openChange) {
            return res.status(400).json({
                message: 'Approve the attendance request. The selected day is applied only after HR approval.',
            });
        }

        if (decision === 'rejected') {
            const rejectReason = String(req.body?.rejectReason || '').trim();
            if (!rejectReason) {
                return res.status(400).json({ message: 'Reject reason is required.' });
            }
            record.flexibleOtStatus = 'rejected';
            record.flexibleOtApprovedHours = 0;
            record.flexibleOtReason = rejectReason;
            await record.save();
            return res.status(200).json({ message: 'Overtime rejected.', record });
        }

        const editedHours = roundHours(req.body?.approvedHours);
        const approvedHours = editedHours > 0 ? editedHours : roundHours(record.flexibleOtApprovedHours);
        if (!(approvedHours > 0)) {
            return res.status(400).json({ message: 'Approved hours are required.' });
        }
        const editedIn = String(req.body?.timeIn || '').trim();
        const editedOut = String(req.body?.timeOut || '').trim();
        if (editedIn) record.timeIn = storedClock(editedIn);
        if (editedOut) record.timeOut = storedClock(editedOut);
        const editedReason = String(req.body?.reason || '').trim();

        const applied = await approveFlexibleOvertimeRecord(record, {
            approvedHours,
            reason: editedReason || record.flexibleOtReason,
            confirmNextDay,
            targetDate: req.body?.targetDate,
            actor,
        });
        if (applied.status !== 200) {
            return res.status(applied.status).json(applied.body);
        }
        return res.status(200).json({
            message: 'Overtime approved.',
            ...applied.body,
        });
    } catch (error) {
        console.error('[decideFlexibleOvertime]', error);
        return res.status(500).json({ message: error.message || 'Failed to decide overtime.' });
    }
}
