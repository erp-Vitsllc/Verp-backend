import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { notifyPrimaryReporteeOfLeaveRequest } from '../utils/notifyLeaveDashboardRequest.js';
import { loadCompOffMonth, settleCompOffDay } from '../utils/compOffSettlement.js';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

async function linkedEmployee(req) {
    const select = '_id employeeId firstName lastName companyEmail workEmail email primaryReportee staffType';
    if (req.user?.employeeObjectId) {
        const byId = await EmployeeBasic.findById(req.user.employeeObjectId).select(select).lean();
        if (byId) return byId;
    }
    if (req.user?.employeeId) {
        const byCode = await EmployeeBasic.findOne({ employeeId: req.user.employeeId }).select(select).lean();
        if (byCode) return byCode;
    }
    return null;
}

export async function getCompOffMonth(req, res) {
    try {
        const result = await loadCompOffMonth({
            employeeMongoId: req.query?.employeeMongoId || req.query?.employeeId,
            date: req.query?.date,
        });
        if (result.error) return res.status(result.status || 400).json({ message: result.error });
        return res.status(200).json(result.data);
    } catch (error) {
        console.error('[getCompOffMonth]', error);
        return res.status(500).json({ message: error.message || 'Failed to load comp-off.' });
    }
}

export async function settleCompOff(req, res) {
    try {
        const result = await settleCompOffDay({
            employeeMongoId: req.body?.employeeMongoId,
            date: req.body?.date,
            action: req.body?.action,
        });
        if (result.error) return res.status(result.status || 400).json({ message: result.error });
        const fresh = await loadCompOffMonth({
            employeeMongoId: req.body?.employeeMongoId,
            date: req.body?.date,
        });
        return res.status(200).json({
            message: result.message,
            compOff: fresh.data || null,
        });
    } catch (error) {
        console.error('[settleCompOff]', error);
        return res.status(500).json({ message: error.message || 'Failed to settle comp-off.' });
    }
}

/**
 * POST /api/Attendance/me/compoff-request
 * Body: { date, reason }
 * The day stays unchanged until the primary reportee approves it as comp-off leave.
 */
export async function requestCompOffLeave(req, res) {
    try {
        const self = await linkedEmployee(req);
        if (!self) return res.status(404).json({ message: 'No linked employee profile found for this user.' });

        const date = String(req.body?.date || '').trim();
        const reason = String(req.body?.reason || '').trim();
        if (!DATE_KEY.test(date)) {
            return res.status(400).json({ message: 'Select a comp-off date.' });
        }
        if (!reason) {
            return res.status(400).json({ message: 'Reason is required.' });
        }

        const employee = await EmployeeBasic.findById(self._id)
            .select('_id employeeId firstName lastName companyEmail workEmail email primaryReportee')
            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail email')
            .lean();
        if (!employee?.primaryReportee?._id) {
            return res.status(400).json({ message: 'Primary reportee is required before requesting comp-off leave.' });
        }

        let record = await Attendance.findOne({
            employeeMongoId: String(employee._id),
            date,
        });
        if (String(record?.statusKey || '') === 'compoff_leave') {
            return res.status(400).json({ message: 'This date is already comp-off leave.' });
        }
        if (record?.leaveRequestStatus === 'pending') {
            return res.status(400).json({ message: 'A leave request is already pending for this date.' });
        }

        const empName = [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() || 'Employee';
        if (!record) {
            record = new Attendance({
                date,
                employeeMongoId: String(employee._id),
                employeeId: employee.employeeId || '',
                employeeName: empName,
                statusKey: 'not_marked',
                statusLabel: 'Upcoming',
            });
        }

        record.previousStatusKey = record.statusKey || 'not_marked';
        record.previousStatusLabel = record.statusLabel || 'Upcoming';
        record.requestedStatusKey = 'compoff_leave';
        record.requestedStatusLabel = 'Comp Off Leave';
        record.leaveRequestReason = reason;
        record.leaveRequestKind = 'leave';
        record.leaveRequestStatus = 'pending';
        record.leaveRequestFromDate = date;
        record.leaveRequestToDate = date;
        record.leaveRequestedAt = new Date();
        record.leaveDecidedAt = null;
        record.leaveDecidedBy = null;
        record.employeeId = employee.employeeId || record.employeeId || '';
        record.employeeName = empName;
        await record.save();

        await notifyPrimaryReporteeOfLeaveRequest({
            employee,
            manager: employee.primaryReportee,
            from: date,
            to: date,
            attendanceId: record._id,
            requestedLabel: 'Comp Off Leave',
            requestedStatusKey: 'compoff_leave',
            leaveRequestKind: 'leave',
            reason,
        });

        return res.status(200).json({
            message: 'Comp-off request sent to your primary reportee.',
            record,
        });
    } catch (error) {
        console.error('[requestCompOffLeave]', error);
        return res.status(500).json({ message: error.message || 'Failed to request comp-off leave.' });
    }
}
