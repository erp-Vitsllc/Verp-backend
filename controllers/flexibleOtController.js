import nodemailer from 'nodemailer';
import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';
import { normalizeStaffType } from '../utils/workingTimeHelpers.js';
import { addDaysKey, approvedOtRemainder } from '../utils/flexibleAttendance.js';
import { refreshFlexibleOtRecords } from '../utils/syncFlexibleOt.js';
import { resolveFrontendBaseUrl } from '../utils/resolveFrontendBaseUrl.js';

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

function roundHours(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours < 0) return 0;
    return Math.round(hours * 100) / 100;
}

async function actorIsFlowchartHr(actor) {
    const hr = await getDepartmentHOD('hr').catch(() => null);
    return Boolean(hr?._id && actor?._id && String(hr._id) === String(actor._id));
}

async function approveFlexibleOvertimeRecord(record, { approvedHours, reason, confirmNextDay }) {
    const approved = roundHours(approvedHours);
    if (approved >= 9 && !confirmNextDay) {
        return {
            status: 409,
            body: {
                message: 'Approving 9 hours or more marks the next day as Present.',
                needsNextDayConfirm: true,
            },
        };
    }

    record.flexibleOtStatus = 'approved';
    record.flexibleOtApprovedHours = approved;
    if (reason != null) record.flexibleOtReason = reason;
    if (approved >= 9) {
        const nextDate = addDaysKey(record.date, 1);
        const existingNext = await Attendance.findOne({
            date: nextDate,
            employeeMongoId: record.employeeMongoId,
        }).select('timeIn').lean();
        const nextPunch = String(existingNext?.timeIn || '').trim();
        if (!nextPunch || nextPunch === 'OT') {
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
                        reason: 'Present from approved overtime (9 hr)',
                        flexibleFromOtDate: record.date,
                        flexibleWorkedHours: 9,
                        punchSource: 'manual',
                        checkOutSource: 'manual',
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );
            record.flexibleOtNextDayDate = nextDate;
        }
    }
    await record.save();
    return {
        status: 200,
        body: {
            record,
            displayOtHours: approvedOtRemainder(approved),
            nextDayPresent: approved >= 9,
        },
    };
}

async function sendHrOtEmail({ hr, record, employeeName, approvedHours, reason, req }) {
    const to = hr?.companyEmail || hr?.workEmail || hr?.email || '';
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!to || !emailUser || !emailPass) return;
    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
    const baseUrl = resolveFrontendBaseUrl(req);
    const staffType = normalizeStaffType(record.staffType || '');
    const link = `${baseUrl}/HRM/Attendance/mark?date=${record.date}&staffType=${staffType}&otAttendanceId=${record._id}`;
    await transporter.sendMail({
        from: emailUser,
        to,
        subject: `[Action Required] Overtime request: ${employeeName} ${record.date}`,
        html: `<p>Hello ${[hr.firstName, hr.lastName].filter(Boolean).join(' ') || 'HR'},</p>
<p><strong>${employeeName}</strong> has an overtime request for <strong>${record.date}</strong>.</p>
<p>Approved hours requested: <strong>${approvedHours}</strong><br/>Reason: ${reason}</p>
<p><a href="${link}">Open Mark Attendance</a></p>`,
    });
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
            .select('primaryReportee staffType firstName lastName')
            .lean();
        const isReportee = Boolean(employee && String(employee.primaryReportee || '') === String(actor._id));
        const isHr = await actorIsFlowchartHr(actor);
        if (!isReportee && !isHr) {
            return res.status(403).json({
                message: 'Only the primary reportee or flowchart HR can use overtime.',
            });
        }

        if (isHr) {
            const applied = await approveFlexibleOvertimeRecord(record, {
                approvedHours,
                reason,
                confirmNextDay: req.body?.confirmNextDay === true,
            });
            if (applied.status !== 200) {
                return res.status(applied.status).json(applied.body);
            }
            return res.status(200).json({
                message: 'Overtime applied.',
                ...applied.body,
            });
        }

        record.flexibleOtStatus = 'pending';
        record.flexibleOtApprovedHours = approvedHours;
        record.flexibleOtReason = reason;
        await record.save();

        const hr = await getDepartmentHOD('hr').catch(() => null);
        const employeeName = record.employeeName || [employee.firstName, employee.lastName].filter(Boolean).join(' ');
        try {
            await sendHrOtEmail({
                hr,
                record: { ...record.toObject(), staffType: employee.staffType },
                employeeName,
                approvedHours,
                reason,
                req,
            });
        } catch (mailErr) {
            console.error('[requestFlexibleOvertime] email failed:', mailErr);
        }

        return res.status(200).json({ message: 'Overtime request sent to HR.', record });
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

        if (decision === 'rejected') {
            record.flexibleOtStatus = 'rejected';
            record.flexibleOtApprovedHours = 0;
            await record.save();
            return res.status(200).json({ message: 'Overtime rejected.', record });
        }

        const applied = await approveFlexibleOvertimeRecord(record, {
            approvedHours: record.flexibleOtApprovedHours,
            confirmNextDay,
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
