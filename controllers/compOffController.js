import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';
import { settleFulfilledLeaveRequest } from '../utils/leaveRequestSettlement.js';
import { sendAttendanceDirectChangeEmail } from '../utils/sendAttendanceLeaveEmails.js';
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
 * The day becomes comp-off leave immediately. HR and the primary reportee get a notice email.
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
            .select('_id employeeId firstName lastName companyEmail workEmail email primaryReportee staffType')
            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail email')
            .lean();
        if (!employee) return res.status(404).json({ message: 'No linked employee profile found for this user.' });

        let record = await Attendance.findOne({
            employeeMongoId: String(employee._id),
            date,
        });
        if (String(record?.statusKey || '') === 'compoff_leave') {
            return res.status(400).json({ message: 'This date is already comp-off leave.' });
        }

        const empName = [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() || 'Employee';
        const previousLabel = record?.statusLabel || 'Not marked';
        const hadPendingLeave = record?.leaveRequestStatus === 'pending';
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
        record.previousStatusLabel = previousLabel;
        record.statusKey = 'compoff_leave';
        record.statusLabel = 'Comp Off Leave';
        record.approvalStatus = 'approved';
        record.reason = reason;
        record.employeeId = employee.employeeId || record.employeeId || '';
        record.employeeName = empName;
        if (hadPendingLeave) {
            record.requestedStatusKey = 'compoff_leave';
            record.leaveRequestStatus = 'pending';
            await record.save();
            await settleFulfilledLeaveRequest(record);
        } else {
            record.leaveRequestStatus = '';
            record.leaveApprovalStage = '';
            record.requestedStatusKey = '';
            record.requestedStatusLabel = '';
            record.leaveRequestKind = '';
            await record.save();
        }

        const hr = await getDepartmentHOD('hr').catch(() => null);
        try {
            await sendAttendanceDirectChangeEmail({
                recipients: [hr, employee.primaryReportee].filter(Boolean),
                actor: employee,
                employee,
                date,
                previousLabel,
                nextLabel: 'Comp Off Leave',
                reason,
                recordIds: [record._id],
            });
        } catch (mailError) {
            console.error('[requestCompOffLeave] notice email failed:', mailError?.message || mailError);
        }

        return res.status(200).json({
            message: 'Comp-off leave saved. HR and your primary reportee have been emailed.',
            record,
        });
    } catch (error) {
        console.error('[requestCompOffLeave]', error);
        return res.status(500).json({ message: error.message || 'Failed to request comp-off leave.' });
    }
}
