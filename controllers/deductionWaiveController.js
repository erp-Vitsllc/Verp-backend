import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { employeeAttendanceMatch } from '../utils/attendanceDayLookup.js';
import { isUserActiveInFlowchart } from '../utils/getDepartmentHOD.js';
import { attachAttendanceDeductionDays } from '../utils/attachAttendanceDeductionDays.js';
import { dayHasWaivableDeduction } from '../utils/deductionWaive.js';

function personName(employee) {
    return [employee?.firstName, employee?.lastName].filter(Boolean).join(' ').trim();
}

async function resolveActor(req) {
    const select = '_id employeeId firstName lastName companyEmail workEmail email';
    if (req.user?.employeeObjectId && mongoose.Types.ObjectId.isValid(req.user.employeeObjectId)) {
        const byId = await EmployeeBasic.findById(req.user.employeeObjectId).select(select).lean();
        if (byId) return byId;
    }
    if (req.user?.employeeId) {
        const byCode = await EmployeeBasic.findOne({ employeeId: req.user.employeeId }).select(select).lean();
        if (byCode) return byCode;
    }
    const emails = [req.user?.companyEmail, req.user?.email]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean);
    if (!emails.length) return null;
    return EmployeeBasic.findOne({
        $or: [
            { companyEmail: { $in: emails } },
            { workEmail: { $in: emails } },
            { email: { $in: emails } },
        ],
    })
        .select(select)
        .lean();
}

async function resolveEmployee(employeeMongoId, employeeCode) {
    const select = '_id employeeId';
    const mongoId = String(employeeMongoId || '').trim();
    if (mongoose.Types.ObjectId.isValid(mongoId) && mongoId.length === 24) {
        const byId = await EmployeeBasic.findById(mongoId).select(select).lean();
        if (byId) return byId;
    }
    const code = String(employeeCode || '').trim();
    if (code) {
        const byCode = await EmployeeBasic.findOne({ employeeId: code }).select(select).lean();
        if (byCode) return byCode;
    }
    if (mongoId && mongoId !== code) {
        return EmployeeBasic.findOne({ employeeId: mongoId }).select(select).lean();
    }
    return null;
}

async function actorIsFlowchartHr(req, actor) {
    return isUserActiveInFlowchart(
        {
            employeeObjectId: actor?._id || req.user?.employeeObjectId || null,
            employeeId: actor?.employeeId || req.user?.employeeId || '',
        },
        'hr',
    );
}

function yearOf(value) {
    const text = String(value || '').trim();
    const match = /^(\d{4})/.exec(text);
    const year = match ? Number(match[1]) : 0;
    return year >= 2000 && year <= 2100 ? year : 0;
}

async function waiveCount(employee, year) {
    const person = employee?._id ? employee : { _id: employee };
    return Attendance.countDocuments({
        ...employeeAttendanceMatch(person),
        date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` },
        deductionWaived: true,
    });
}

export async function getDeductionWaiveCount(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }
        const actor = await resolveActor(req);
        if (!(await actorIsFlowchartHr(req, actor))) {
            return res.status(403).json({ message: 'Only the flowchart HR assignee can waive a deduction.' });
        }
        const employeeMongoId = String(req.query?.employeeMongoId || '').trim();
        const employeeCode = String(req.query?.employeeId || '').trim();
        const year = yearOf(req.query?.year);
        const employee = await resolveEmployee(employeeMongoId, employeeCode);
        if (!employee?._id || !year) {
            return res.status(400).json({ message: 'Employee and year are required.' });
        }
        const count = await waiveCount(employee, year);
        return res.status(200).json({ year, count });
    } catch (error) {
        console.error('[getDeductionWaiveCount]', error);
        return res.status(500).json({ message: error.message || 'Failed to load waived deductions.' });
    }
}

export async function waiveAttendanceDeduction(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }
        const actor = await resolveActor(req);
        if (!(await actorIsFlowchartHr(req, actor))) {
            return res.status(403).json({ message: 'Only the flowchart HR assignee can waive a deduction.' });
        }
        const attendanceId = String(req.body?.attendanceId || '').trim();
        const reason = String(req.body?.reason || '').trim();
        if (!mongoose.Types.ObjectId.isValid(attendanceId)) {
            return res.status(400).json({ message: 'Attendance record is required.' });
        }
        if (!reason) {
            return res.status(400).json({ message: 'Reason for waive of deduction is required.' });
        }
        const record = await Attendance.findById(attendanceId);
        if (!record) return res.status(404).json({ message: 'Attendance record not found.' });
        if (!dayHasWaivableDeduction(record)) {
            return res.status(400).json({ message: 'This day has no deduction to waive.' });
        }
        const [withDeduction] = await attachAttendanceDeductionDays([record.toObject()]);
        const approvedHoursStillDeduct = String(record.hourAdjustStatus || '') === 'approved'
            && Number(record.hoursApproved) > 0;
        if (!(Number(withDeduction?.deductionDays) > 0) && !approvedHoursStillDeduct) {
            return res.status(400).json({ message: 'This day has no deduction to waive.' });
        }
        const year = yearOf(record.date);
        if (!record.deductionWaived) {
            record.deductionWaived = true;
            record.deductionWaiveReason = reason;
            record.deductionWaivedAt = new Date();
            record.deductionWaivedByName = personName(actor);
            await record.save();
        }
        const count = year
            ? await waiveCount(
                { _id: record.employeeMongoId, employeeId: record.employeeId },
                year,
            )
            : 0;
        return res.status(200).json({
            message: 'Deduction waived. The status is unchanged.',
            year,
            count,
            record,
        });
    } catch (error) {
        console.error('[waiveAttendanceDeduction]', error);
        return res.status(500).json({ message: error.message || 'Failed to waive the deduction.' });
    }
}
