import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';
import { flexibleExactLossHours, requiredHoursForDate } from '../utils/flexibleAttendance.js';
import {
    getScheduledPunchMinutes,
    getWeekForStaffType,
    isFlexibleTiming,
    loadWorkingTimeDoc,
    normalizeStaffType,
} from '../utils/workingTimeHelpers.js';
import { punchAttendanceKind } from '../utils/partialLeaveWindow.js';
import { isAttendanceSuspendedOn } from '../utils/attendanceSuspension.js';
import {
    attendanceApprovalLimitMessageFor,
    attendanceApprovalLimitText,
    closedMissingCheckout,
    loadMispunchMonthAllowance,
} from '../utils/attendanceApprovalAllowance.js';
import {
    attendanceChangeQueuedMessage,
    openAttendanceChangeForEmployee,
    supersedeOpenAttendanceChanges,
} from '../utils/attendanceChangeApproval.js';
import { attendanceMarkRoute, yellowMarkHours } from '../utils/attendanceMarkPolicy.js';
import { sendAttendanceDirectChangeEmail } from '../utils/sendAttendanceLeaveEmails.js';

const UNAUTH_TIMES = 2;

const APPROVED_LABEL = {
    early_go: 'Early Go (Approved)',
    late_arrived: 'Late Arrival (Approved)',
    mispunch: 'Mispunch (Approved)',
    authorized_leave: 'Auth',
};

const STATUS_KEY = {
    early_go: 'early_go',
    late_arrived: 'late_arrived',
    mispunch: 'mispunch',
    authorized_leave: 'authorized_leave',
};

function roundHours(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours < 0) return 0;
    return Math.round(hours * 1e6) / 1e6;
}

function clockToSeconds(value) {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(value || '').trim());
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
}

function clockToMinutes(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

async function resolveActor(req) {
    const select = '_id employeeId firstName lastName';
    if (req.user?.employeeObjectId) {
        const byId = await EmployeeBasic.findById(req.user.employeeObjectId).select(select).lean();
        if (byId) return byId;
    }
    if (req.user?.employeeId) {
        return EmployeeBasic.findOne({ employeeId: req.user.employeeId }).select(select).lean();
    }
    return null;
}

async function actorIsFlowchartHr(actor) {
    const hr = await getDepartmentHOD('hr').catch(() => null);
    return Boolean(hr?._id && actor?._id && String(hr._id) === String(actor._id));
}

export function hourAdjustKindOf(record) {
    const kind = punchAttendanceKind(record);
    if (kind) return kind;
    if (closedMissingCheckout(record)) return 'mispunch';
    if (String(record?.statusKey || '').trim() === 'unauthorized_leave') return 'authorized_leave';
    return '';
}

function hoursTakenOf(record, week, kind) {
    if (isFlexibleTiming(week)) {
        const required = requiredHoursForDate(week, record?.date);
        const start = clockToSeconds(record?.timeIn);
        const end = clockToSeconds(record?.timeOut);
        if (required > 0 && start != null && end != null) {
            const outDate = String(record?.timeOutDate || '').trim();
            const date = String(record?.date || '').trim();
            let seconds = end - start;
            if (outDate && date && outDate > date) {
                const days = Math.round((new Date(`${outDate}T12:00:00.000Z`) - new Date(`${date}T12:00:00.000Z`)) / 86400000);
                seconds += days * 86400;
            } else if (seconds < 0) {
                seconds += 86400;
            }
            return { taken: roundHours(Math.max(0, required * 3600 - seconds) / 3600), dayHours: required, flexible: true };
        }
        return { taken: roundHours(flexibleExactLossHours(record, week)), dayHours: 0, flexible: true };
    }
    const schedule = getScheduledPunchMinutes(week, record?.date);
    const dayHours = schedule?.flexible
        ? (Number(schedule.scheduledMinutes) || 0) / 60
        : schedule?.startMinutes != null && schedule?.endMinutes != null
          ? Math.max(0, (schedule.endMinutes - schedule.startMinutes) / 60)
          : 8;
    const safeDay = dayHours > 0 ? dayHours : 8;
    if ((kind === 'early_go' || kind === 'late_arrived') && schedule?.startMinutes != null && schedule?.endMinutes != null) {
        const inn = clockToSeconds(record?.timeIn);
        const out = clockToSeconds(record?.timeOut);
        const late = inn == null ? 0 : Math.max(0, inn - schedule.startMinutes * 60);
        const early = out == null ? 0 : Math.max(0, schedule.endMinutes * 60 - out);
        return { taken: roundHours((late + early) / 3600), dayHours: safeDay };
    }
    return { taken: roundHours(safeDay), dayHours: safeDay };
}

async function weekForRecord(record) {
    const employee = await EmployeeBasic.findById(record.employeeMongoId).select('staffType').lean();
    const doc = await loadWorkingTimeDoc();
    return getWeekForStaffType(doc, normalizeStaffType(employee?.staffType));
}

function storedPunchClock(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim());
    if (!match) return '';
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function applyApproved(record, { kind, approvedHours, taken, max, reason, mode, timeIn, timeOut }) {
    record.hourAdjustStatus = 'approved';
    record.hourAdjustKind = kind;
    record.hoursTaken = taken;
    record.hoursMax = max;
    record.hoursApproved = approvedHours;
    record.hourAdjustMode = mode === 'custom' || mode === 'authorized' ? mode : '';
    if (reason != null) record.hourAdjustReason = reason;
    record.statusKey = STATUS_KEY[kind];
    record.statusLabel = APPROVED_LABEL[kind];
    if (kind !== 'mispunch') return;
    const checkIn = storedPunchClock(timeIn);
    const checkOut = storedPunchClock(timeOut);
    if (checkIn) {
        record.timeIn = checkIn;
        record.punchSource = 'manual';
    }
    if (checkOut) {
        record.timeOut = checkOut;
        record.checkOutSource = 'manual';
    }
    if (reason) record.reason = reason;
}

function isFlexibleHourProposal(proposed = {}) {
    if (proposed?.hourAdjustFlexible === true) return true;
    const taken = roundHours(proposed?.hoursTaken);
    const max = roundHours(proposed?.hoursMax);
    if (max > taken + 0.001) return false;
    return !String(proposed?.reason || '').trim();
}

/** Keep an approver's edited hours inside the request that was sent. */
export function normalizeHourAdjustEdit(proposed = {}, body = {}) {
    const flexible = isFlexibleHourProposal(proposed);
    const max = roundHours(proposed?.hoursMax);
    const hasHours = body?.approvedHours != null && String(body.approvedHours).trim() !== '';
    const requestedHours = hasHours ? Number(body.approvedHours) : roundHours(proposed?.hoursApproved);
    const editedReason = body?.hourReason == null ? '' : String(body.hourReason || '').trim();
    const nextReason = editedReason || String(proposed?.reason || '').trim();
    if (!Number.isFinite(requestedHours) || requestedHours < 0) {
        return { error: 'Approved hours cannot be negative.' };
    }
    const approvedHours = roundHours(requestedHours);
    if (approvedHours > max + 0.001) {
        return { error: `Approved hours cannot be more than ${max}.` };
    }
    const mode = body?.hourAdjustMode === 'custom' ? 'custom' : body?.hourAdjustMode === 'authorized' ? 'authorized' : '';
    const taken = roundHours(proposed?.hoursTaken);
    const storedHours = mode === 'authorized' ? taken : approvedHours;
    if (storedHours > max + 0.001) {
        return { error: `Approved hours cannot be more than ${max}.` };
    }
    return { hoursApproved: storedHours, reason: nextReason, hourAdjustMode: mode };
}

async function emailDirectHourChange({ actor, hr, employee, record, previousLabel, nextLabel, reason }) {
    try {
        await sendAttendanceDirectChangeEmail({
            recipients: [hr, employee?.primaryReportee].filter(Boolean),
            actor,
            employee,
            date: record.date,
            previousLabel: previousLabel || 'Not marked',
            nextLabel,
            timeIn: record.timeIn || '',
            timeOut: record.timeOut || '',
            reason: reason || '',
            recordIds: [record._id],
        });
    } catch (err) {
        console.error('[emailDirectHourChange]', err?.message || err);
    }
}

function applyDirectZeroHour(record, { kind, reason, timeIn, timeOut }) {
    record.hourAdjustStatus = '';
    record.hourAdjustKind = '';
    record.hoursTaken = 0;
    record.hoursApproved = 0;
    record.hoursMax = 0;
    record.statusKey = STATUS_KEY[kind];
    record.statusLabel = {
        early_go: 'Early Go',
        late_arrived: 'Late Arrival',
        mispunch: 'Mispunch',
    }[kind] || record.statusLabel;
    if (reason) {
        record.reason = reason;
        record.hourAdjustReason = '';
    }
    if (kind !== 'mispunch') return;
    const checkIn = storedPunchClock(timeIn);
    const checkOut = storedPunchClock(timeOut);
    if (checkIn) {
        record.timeIn = checkIn;
        record.punchSource = 'manual';
    }
    if (checkOut) {
        record.timeOut = checkOut;
        record.checkOutSource = 'manual';
    }
}

export async function exactHourProposal(record, proposed = {}) {
    const kind = proposed.hourAdjustKind || hourAdjustKindOf(record);
    const week = await weekForRecord(record);
    const { taken, flexible } = hoursTakenOf(record, week, kind);
    return {
        ...proposed,
        hourAdjustKind: kind,
        hourAdjustFlexible: flexible,
        hoursTaken: taken,
        hoursMax: roundHours(taken * UNAUTH_TIMES),
    };
}

export async function applyStoredHourAdjust(record, proposed = {}) {
    const kind = proposed.hourAdjustKind || hourAdjustKindOf(record);
    if (!kind || !STATUS_KEY[kind]) {
        const error = new Error('This status cannot be approved.');
        error.statusCode = 400;
        throw error;
    }
    applyApproved(record, {
        kind,
        approvedHours: roundHours(proposed.hoursApproved),
        taken: roundHours(proposed.hoursTaken),
        max: roundHours(proposed.hoursMax),
        reason: proposed.reason,
        mode: proposed.hourAdjustMode,
        timeIn: proposed.timeIn,
        timeOut: proposed.timeOut,
    });
    await record.save();
    return record;
}

export async function requestHourAdjust(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }
        const actor = await resolveActor(req);
        if (!actor) return res.status(404).json({ message: 'No linked employee profile found.' });

        const attendanceId = String(req.body?.attendanceId || '').trim();
        const requestedHours = Number(req.body?.approvedHours);
        const reason = String(req.body?.reason || '').trim();
        if (!mongoose.Types.ObjectId.isValid(attendanceId)) {
            return res.status(400).json({ message: 'Attendance record is required.' });
        }
        if (!Number.isFinite(requestedHours) || requestedHours < 0) {
            return res.status(400).json({ message: 'Approved hours cannot be negative.' });
        }

        const record = await Attendance.findById(attendanceId);
        if (!record) return res.status(404).json({ message: 'Attendance record not found.' });
        if (record.hourAdjustStatus === 'approved') {
            return res.status(400).json({ message: 'This day is already approved.' });
        }
        const kind = hourAdjustKindOf(record);
        if (!kind) return res.status(400).json({ message: 'This status cannot be sent for hour approval.' });

        const week = await weekForRecord(record);
        const { taken, flexible } = hoursTakenOf(record, week, kind);
        const approvedHours = roundHours(requestedHours);
        if (!reason) return res.status(400).json({ message: 'Reason is required.' });
        const max = roundHours(taken * UNAUTH_TIMES);
        const mode = req.body?.hourAdjustMode === 'custom' ? 'custom' : req.body?.hourAdjustMode === 'authorized' ? 'authorized' : '';
        const storedHours = mode === 'authorized' ? taken : approvedHours;
        if (storedHours > max + 0.001) {
            return res.status(400).json({ message: `Approved hours cannot be more than ${max}.` });
        }

        const isHr = await actorIsFlowchartHr(actor);
        const employee = await EmployeeBasic.findById(record.employeeMongoId)
            .select('_id employeeId firstName lastName staffType primaryReportee companyEmail workEmail email attendanceAccountStatus attendanceSuspension')
            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail email')
            .lean();
        if (isAttendanceSuspendedOn(employee, record.date)) {
            return res.status(403).json({ message: 'This employee is suspended on this date. Attendance cannot be changed.' });
        }
        const hr = await getDepartmentHOD('hr').catch(() => null);
        const measured = await yellowMarkHours(employee || { _id: record.employeeMongoId }, record.date, {
            statusKey: STATUS_KEY[kind],
            timeIn: record.timeIn,
            timeOut: record.timeOut,
            reason,
        });
        const zeroNeedsBothApprovers = flexible && storedHours === 0;
        const route = isHr
            ? 'direct'
            : attendanceMarkRoute({
                statusKey: STATUS_KEY[kind],
                clockHours: kind === 'mispunch' ? 0 : taken,
                deductionHours: measured.deductionHours,
                approvedHours: storedHours,
            });
        if (isHr && !zeroNeedsBothApprovers) {
            applyApproved(record, { kind, approvedHours: storedHours, taken, max, reason, mode });
            await record.save();
            return res.status(200).json({ message: 'Hours approved.', record });
        }
        if (route === 'direct' && !zeroNeedsBothApprovers) {
            const previousLabel = record.statusLabel || 'Not marked';
            applyDirectZeroHour(record, { kind, reason });
            await record.save();
            await supersedeOpenAttendanceChanges({
                date: record.date,
                employeeMongoId: String(record.employeeMongoId),
                actorId: actor._id,
            });
            await emailDirectHourChange({
                actor,
                hr,
                employee,
                record,
                previousLabel,
                nextLabel: record.statusLabel || previousLabel,
                reason,
            });
            return res.status(200).json({
                message: 'Saved. The primary reportee and HR have been emailed.',
                record,
                applied: true,
            });
        }
        if (kind === 'late_arrived' || kind === 'early_go' || kind === 'mispunch') {
            const limitMessage = await attendanceApprovalLimitMessageFor(
                { _id: record.employeeMongoId, employeeId: record.employeeId },
                {
                    pool: kind === 'mispunch' ? 'mispunch' : 'late',
                    requestDates: [record.date],
                },
            );
            if (limitMessage) return res.status(400).json({ message: limitMessage });
        }
        const queued = await openAttendanceChangeForEmployee({
            employee,
            date: record.date,
            proposed: {
                statusKey: record.statusKey || '',
                statusLabel: `Hour approval ${approvedHours} hr`,
                reason,
                timeIn: record.timeIn || '',
                timeOut: record.timeOut || '',
                attendanceId: String(record._id),
                hourAdjustKind: kind,
                hoursTaken: taken,
                hoursMax: max,
                hoursApproved: storedHours,
                hourAdjustMode: mode,
                hourAdjustFlexible: flexible,
            },
            previous: {
                statusKey: record.statusKey || '',
                statusLabel: record.statusLabel || 'Not marked',
                timeIn: record.timeIn || '',
                timeOut: record.timeOut || '',
                reason: record.reason || '',
            },
            actor,
            hr,
            action: 'hour_adjust',
        });
        if (queued.error) return res.status(400).json({ message: queued.error });
        return res.status(200).json({
            message: attendanceChangeQueuedMessage(queued.pending?.stage),
            pending: queued.pending,
        });
    } catch (error) {
        console.error('[requestHourAdjust]', error);
        return res.status(500).json({ message: error.message || 'Failed to send hour request.' });
    }
}

export async function decideHourAdjust(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }
        const actor = await resolveActor(req);
        if (!actor) return res.status(404).json({ message: 'No linked employee profile found.' });
        if (!(await actorIsFlowchartHr(actor))) {
            return res.status(403).json({ message: 'Only flowchart HR can approve or reject this request.' });
        }

        const attendanceId = String(req.body?.attendanceId || '').trim();
        const decision = String(req.body?.decision || '').trim().toLowerCase();
        if (!mongoose.Types.ObjectId.isValid(attendanceId)) {
            return res.status(400).json({ message: 'Attendance record is required.' });
        }
        if (decision !== 'approved' && decision !== 'rejected') {
            return res.status(400).json({ message: 'Decision must be approved or rejected.' });
        }

        const record = await Attendance.findById(attendanceId);
        if (!record || record.hourAdjustStatus !== 'pending') {
            return res.status(404).json({ message: 'Pending hour request not found.' });
        }

        if (decision === 'rejected') {
            const rejectReason = String(req.body?.rejectReason || '').trim();
            if (!rejectReason) {
                return res.status(400).json({ message: 'Reject reason is required.' });
            }
            record.hourAdjustStatus = 'rejected';
            record.hoursApproved = 0;
            record.hourAdjustReason = rejectReason;
            await record.save();
            return res.status(200).json({ message: 'Request rejected. Deduction is unchanged.', record });
        }

        const kind = record.hourAdjustKind || hourAdjustKindOf(record);
        const measured = await exactHourProposal(record, {
            hourAdjustKind: kind,
            hoursTaken: record.hoursTaken,
            hoursMax: record.hoursMax,
            hoursApproved: record.hoursApproved,
            reason: record.hourAdjustReason,
        });
        record.hoursTaken = measured.hoursTaken;
        record.hoursMax = measured.hoursMax;
        const edited = normalizeHourAdjustEdit(
            {
                hoursTaken: record.hoursTaken,
                hoursMax: record.hoursMax,
                hoursApproved: record.hoursApproved,
                reason: record.hourAdjustReason,
            },
            {
                approvedHours: req.body?.approvedHours,
                hourReason: req.body?.hourReason ?? req.body?.reason,
                hourAdjustMode: req.body?.hourAdjustMode,
            },
        );
        if (edited.error) return res.status(400).json({ message: edited.error });
        applyApproved(record, {
            kind,
            approvedHours: edited.hoursApproved,
            taken: roundHours(record.hoursTaken),
            max: roundHours(record.hoursMax),
            reason: edited.reason,
            mode: edited.hourAdjustMode,
            timeIn: req.body?.timeIn,
            timeOut: req.body?.timeOut,
        });
        await record.save();
        return res.status(200).json({ message: 'Hours approved.', record });
    } catch (error) {
        console.error('[decideHourAdjust]', error);
        return res.status(500).json({ message: error.message || 'Failed to decide hour request.' });
    }
}

export async function getMispunchAllowance(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }
        const employeeMongoId = String(req.query?.employeeMongoId || '').trim();
        const date = String(req.query?.date || '').trim();
        if (!mongoose.Types.ObjectId.isValid(employeeMongoId)) {
            return res.status(400).json({ message: 'Employee is required.' });
        }
        const allowance = await loadMispunchMonthAllowance({ _id: employeeMongoId }, date);
        if (allowance.error) return res.status(400).json({ message: allowance.error });
        return res.status(200).json(allowance);
    } catch (error) {
        console.error('[getMispunchAllowance]', error);
        return res.status(500).json({ message: error.message || 'Failed to load the mispunch allowance.' });
    }
}

export async function requestMispunch(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }
        const actor = await resolveActor(req);
        if (!actor) return res.status(404).json({ message: 'No linked employee profile found.' });

        const attendanceId = String(req.body?.attendanceId || '').trim();
        const timeIn = storedPunchClock(req.body?.timeIn);
        const timeOut = storedPunchClock(req.body?.timeOut);
        const reason = String(req.body?.reason || '').trim();
        if (!mongoose.Types.ObjectId.isValid(attendanceId)) {
            return res.status(400).json({ message: 'Attendance record is required.' });
        }
        if (!timeIn || !timeOut) {
            return res.status(400).json({ message: 'Check-in time and check-out time are required.' });
        }
        if (!reason) return res.status(400).json({ message: 'Reason is required.' });

        const record = await Attendance.findById(attendanceId);
        if (!record) return res.status(404).json({ message: 'Attendance record not found.' });
        if (record.hourAdjustStatus === 'approved' && record.hourAdjustKind === 'mispunch') {
            return res.status(400).json({ message: 'This missed punch is already approved.' });
        }
        if (hourAdjustKindOf(record) !== 'mispunch') {
            return res.status(400).json({ message: 'This day is not a missed punch.' });
        }

        const allowance = await loadMispunchMonthAllowance(
            { _id: record.employeeMongoId, employeeId: record.employeeId },
            record.date,
        );
        if (allowance.error) return res.status(400).json({ message: allowance.error });
        if (allowance.allowed != null && !allowance.includesDate && allowance.used >= allowance.allowed) {
            return res.status(400).json({
                message: attendanceApprovalLimitText({
                    pool: 'mispunch',
                    taken: allowance.used,
                    allowed: allowance.allowed,
                }),
            });
        }

        const isHr = await actorIsFlowchartHr(actor);
        const employee = await EmployeeBasic.findById(record.employeeMongoId)
            .select('_id employeeId firstName lastName staffType primaryReportee companyEmail workEmail email attendanceAccountStatus attendanceSuspension')
            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail email')
            .lean();
        if (isAttendanceSuspendedOn(employee, record.date)) {
            return res.status(403).json({ message: 'This employee is suspended on this date. Attendance cannot be changed.' });
        }
        const hr = await getDepartmentHOD('hr').catch(() => null);
        const measured = await yellowMarkHours(employee || { _id: record.employeeMongoId }, record.date, {
            statusKey: 'mispunch',
            timeIn,
            timeOut,
            reason,
        });
        const route = isHr
            ? 'direct'
            : attendanceMarkRoute({
                statusKey: 'mispunch',
                deductionHours: measured.deductionHours,
                approvedHours: 0,
            });
        if (isHr) {
            applyApproved(record, {
                kind: 'mispunch',
                approvedHours: 0,
                taken: 0,
                max: 0,
                reason,
                timeIn,
                timeOut,
            });
            await record.save();
            return res.status(200).json({ message: 'Misspunch saved.', record });
        }
        if (route === 'direct') {
            const previousLabel = record.statusLabel || 'Not marked';
            applyDirectZeroHour(record, { kind: 'mispunch', reason, timeIn, timeOut });
            await record.save();
            await supersedeOpenAttendanceChanges({
                date: record.date,
                employeeMongoId: String(record.employeeMongoId),
                actorId: actor._id,
            });
            await emailDirectHourChange({
                actor,
                hr,
                employee,
                record,
                previousLabel,
                nextLabel: 'Mispunch',
                reason,
            });
            return res.status(200).json({
                message: 'Saved. The primary reportee and HR have been emailed.',
                record,
                applied: true,
            });
        }
        const queued = await openAttendanceChangeForEmployee({
            employee,
            date: record.date,
            proposed: {
                statusKey: 'mispunch',
                statusLabel: 'Misspunch request',
                reason,
                timeIn,
                timeOut,
                attendanceId: String(record._id),
                hourAdjustKind: 'mispunch',
                hoursTaken: 0,
                hoursMax: 0,
                hoursApproved: 0,
                hourAdjustFlexible: false,
            },
            previous: {
                statusKey: record.statusKey || '',
                statusLabel: record.statusLabel || 'Not marked',
                timeIn: record.timeIn || '',
                timeOut: record.timeOut || '',
                reason: record.reason || '',
            },
            actor,
            hr,
            action: 'hour_adjust',
        });
        if (queued.error) return res.status(400).json({ message: queued.error });
        return res.status(200).json({
            message: attendanceChangeQueuedMessage(queued.pending?.stage),
            pending: queued.pending,
        });
    } catch (error) {
        console.error('[requestMispunch]', error);
        return res.status(500).json({ message: error.message || 'Failed to send the misspunch request.' });
    }
}
