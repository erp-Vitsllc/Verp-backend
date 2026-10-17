import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';
import { flexibleLossHours } from '../utils/flexibleAttendance.js';
import {
    getScheduledPunchMinutes,
    getWeekForStaffType,
    isFlexibleTiming,
    loadWorkingTimeDoc,
    normalizeStaffType,
} from '../utils/workingTimeHelpers.js';
import { punchAttendanceKind } from '../utils/partialLeaveWindow.js';
import {
    attendanceApprovalLimitMessageFor,
    attendanceApprovalLimitText,
    loadMispunchMonthAllowance,
} from '../utils/attendanceApprovalAllowance.js';
import {
    attendanceChangeQueuedMessage,
    openAttendanceChangeForEmployee,
} from '../utils/attendanceChangeApproval.js';

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
    return Math.round(hours * 100) / 100;
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
    if (String(record?.statusKey || '').trim() === 'unauthorized_leave') return 'authorized_leave';
    return '';
}

function hoursTakenOf(record, week, kind) {
    if (isFlexibleTiming(week)) {
        return { taken: flexibleLossHours(record, week), dayHours: 0, flexible: true };
    }
    const schedule = getScheduledPunchMinutes(week, record?.date);
    const dayHours = schedule?.flexible
        ? (Number(schedule.scheduledMinutes) || 0) / 60
        : schedule?.startMinutes != null && schedule?.endMinutes != null
          ? Math.max(0, (schedule.endMinutes - schedule.startMinutes) / 60)
          : 8;
    const safeDay = dayHours > 0 ? dayHours : 8;
    if (kind === 'early_go' && schedule?.endMinutes != null) {
        const out = clockToMinutes(record?.timeOut);
        if (out != null) return { taken: roundHours(Math.max(0, (schedule.endMinutes - out) / 60)), dayHours: safeDay };
    }
    if (kind === 'late_arrived' && schedule?.startMinutes != null) {
        const inn = clockToMinutes(record?.timeIn);
        if (inn != null) return { taken: roundHours(Math.max(0, (inn - schedule.startMinutes) / 60)), dayHours: safeDay };
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

function applyApproved(record, { kind, approvedHours, taken, max, reason, timeIn, timeOut }) {
    record.hourAdjustStatus = 'approved';
    record.hourAdjustKind = kind;
    record.hoursTaken = taken;
    record.hoursMax = max;
    record.hoursApproved = approvedHours;
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
    const nextReason =
        body?.hourReason == null
            ? String(proposed?.reason || '').trim()
            : String(body.hourReason || '').trim();
    if (!Number.isFinite(requestedHours) || requestedHours < 0) {
        return { error: 'Approved hours cannot be negative.' };
    }
    if (flexible && Math.abs(requestedHours - Math.round(requestedHours)) > 0.001) {
        return { error: 'Approved hours must be a whole number.' };
    }
    const approvedHours = flexible ? Math.round(requestedHours) : roundHours(requestedHours);
    if (approvedHours > max + 0.001) {
        return { error: `Approved hours cannot be more than ${max}.` };
    }
    if (!flexible && !nextReason) return { error: 'Description is required.' };
    return { hoursApproved: approvedHours, reason: flexible ? '' : nextReason };
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

        const week = await weekForRecord(record);
        const { taken, flexible } = hoursTakenOf(record, week, kind);
        if (!flexible && !reason) return res.status(400).json({ message: 'Description is required.' });
        if (flexible && Math.abs(requestedHours - Math.round(requestedHours)) > 0.001) {
            return res.status(400).json({ message: 'Approved hours must be a whole number.' });
        }
        const approvedHours = flexible ? Math.round(requestedHours) : roundHours(requestedHours);
        const max = flexible ? taken : roundHours(taken * UNAUTH_TIMES);
        if (approvedHours > max + 0.001) {
            return res.status(400).json({ message: `Approved hours cannot be more than ${max}.` });
        }

        const isHr = await actorIsFlowchartHr(actor);
        if (isHr) {
            applyApproved(record, { kind, approvedHours, taken, max, reason });
            await record.save();
            return res.status(200).json({ message: 'Hours approved.', record });
        }

        const employee = await EmployeeBasic.findById(record.employeeMongoId)
            .select('_id employeeId firstName lastName staffType primaryReportee companyEmail workEmail email')
            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail email')
            .lean();
        const hr = await getDepartmentHOD('hr').catch(() => null);
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
                hoursApproved: approvedHours,
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
            },
        );
        if (edited.error) return res.status(400).json({ message: edited.error });
        applyApproved(record, {
            kind,
            approvedHours: edited.hoursApproved,
            taken: roundHours(record.hoursTaken),
            max: roundHours(record.hoursMax),
            reason: edited.reason,
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

        const employee = await EmployeeBasic.findById(record.employeeMongoId)
            .select('_id employeeId firstName lastName staffType primaryReportee companyEmail workEmail email')
            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail email')
            .lean();
        const hr = await getDepartmentHOD('hr').catch(() => null);
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
