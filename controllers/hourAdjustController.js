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

const UNAUTH_TIMES = 2;

const APPROVED_LABEL = {
    early_go: 'Early Go (Approved)',
    late_arrived: 'Late Arrival (Approved)',
    mispunch: 'Mispunch (Approved)',
    authorized_leave: 'Auth Leave (Approved)',
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
    const key = String(record?.statusKey || '').trim();
    const text = `${record?.statusLabel || ''} ${record?.reason || ''}`;
    const session = String(record?.leaveRequestSession || '').trim();
    if (key === 'mispunch' || /mispunch/i.test(text)) return 'mispunch';
    if (key === 'early_go' || (key === 'unauthorized_leave' && (session === 'pm' || /early/i.test(text) || /\(PM\)/i.test(text)))) {
        return 'early_go';
    }
    if (
        key === 'late_arrived' ||
        (key === 'unauthorized_leave' && (session === 'am' || /\(AM\)/i.test(text) || /late arrival/i.test(text)))
    ) {
        return 'late_arrived';
    }
    if (key === 'unauthorized_leave') return 'authorized_leave';
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

function applyApproved(record, { kind, approvedHours, taken, max, reason }) {
    record.hourAdjustStatus = 'approved';
    record.hourAdjustKind = kind;
    record.hoursTaken = taken;
    record.hoursMax = max;
    record.hoursApproved = approvedHours;
    if (reason != null) record.hourAdjustReason = reason;
    record.statusKey = STATUS_KEY[kind];
    record.statusLabel = APPROVED_LABEL[kind];
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
        if (!Number.isFinite(requestedHours) || requestedHours <= 0) {
            return res.status(400).json({ message: 'Approved hours are required.' });
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
        if (!flexible && !reason) return res.status(400).json({ message: 'Description is required.' });
        if (flexible && Math.abs(requestedHours - Math.round(requestedHours)) > 0.001) {
            return res.status(400).json({ message: 'Approved hours must be a whole number.' });
        }
        const approvedHours = flexible ? Math.round(requestedHours) : roundHours(requestedHours);
        const max = flexible ? taken : roundHours(taken * UNAUTH_TIMES);
        if (max <= 0) return res.status(400).json({ message: 'No hours to approve on this day.' });
        if (approvedHours > max + 0.001) {
            return res.status(400).json({ message: `Approved hours cannot be more than ${max}.` });
        }

        const isHr = await actorIsFlowchartHr(actor);
        if (isHr) {
            applyApproved(record, { kind, approvedHours, taken, max, reason });
            await record.save();
            return res.status(200).json({ message: 'Hours approved.', record });
        }

        record.hourAdjustStatus = 'pending';
        record.hourAdjustKind = kind;
        record.hoursTaken = taken;
        record.hoursMax = max;
        record.hoursApproved = approvedHours;
        record.hourAdjustReason = reason;
        await record.save();
        return res.status(200).json({ message: 'Request sent to HR.', record });
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
            record.hourAdjustStatus = 'rejected';
            record.hoursApproved = 0;
            await record.save();
            return res.status(200).json({ message: 'Request rejected. Deduction is unchanged.', record });
        }

        const kind = record.hourAdjustKind || hourAdjustKindOf(record);
        applyApproved(record, {
            kind,
            approvedHours: roundHours(record.hoursApproved),
            taken: roundHours(record.hoursTaken),
            max: roundHours(record.hoursMax),
            reason: record.hourAdjustReason,
        });
        await record.save();
        return res.status(200).json({ message: 'Hours approved.', record });
    } catch (error) {
        console.error('[decideHourAdjust]', error);
        return res.status(500).json({ message: error.message || 'Failed to decide hour request.' });
    }
}
