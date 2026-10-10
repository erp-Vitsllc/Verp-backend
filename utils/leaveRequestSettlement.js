import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import DashboardAction from '../models/DashboardAction.js';
import { LEAVE_DASHBOARD_REQUEST_TYPE } from './notifyLeaveDashboardRequest.js';

const LEAVE_STATUS_KEYS = new Set([
    'authorized_leave',
    'unauthorized_leave',
    'sick_leave',
    'compoff_leave',
    'on_leave',
]);

const REQUEST_TYPES = [LEAVE_DASHBOARD_REQUEST_TYPE, 'Attendance Leave Request'];

/** The attendance day is already the leave that the open request is asking for. */
export function rowFulfillsOpenLeaveRequest(row) {
    if (String(row?.leaveRequestStatus || '').trim() !== 'pending') return false;
    const requested = String(row?.requestedStatusKey || '').trim();
    const actual = String(row?.statusKey || '').trim();
    return Boolean(requested) && requested === actual && LEAVE_STATUS_KEYS.has(actual);
}

function clearRequestFields(record) {
    record.leaveRequestStatus = '';
    record.leaveRequestKind = '';
    record.requestedStatusKey = '';
    record.requestedStatusLabel = '';
    record.leaveRequestFromDate = '';
    record.leaveRequestToDate = '';
    record.leaveRequestGroupId = '';
    record.leaveRequestedAt = null;
    record.leaveDecidedAt = null;
    record.leaveDecidedBy = null;
    record.leaveRequestReason = '';
    record.leaveRequestDayPart = '';
    record.leaveRequestSession = '';
    record.leaveRequestTimeIn = '';
    record.leaveRequestTimeOut = '';
    record.annualLeaveNotEligible = false;
}

async function dropLeaveBell(requestIds) {
    const ids = [...requestIds].map((id) => String(id || '').trim()).filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!ids.length) return;
    await DashboardAction.deleteMany({
        requestId: { $in: ids },
        requestType: { $in: REQUEST_TYPES },
    });
}

async function closeBellWhenGroupHasNoPending({ groupId, employeeMongoId, recordIds }) {
    const requestIds = new Set((recordIds || []).map((id) => String(id)));
    const group = String(groupId || '').trim();
    if (group) {
        const stillPending = await Attendance.countDocuments({
            leaveRequestGroupId: group,
            employeeMongoId: String(employeeMongoId || ''),
            leaveRequestStatus: 'pending',
        });
        if (stillPending) return;
        requestIds.add(group);
    }
    await dropLeaveBell(requestIds);
}

/**
 * A pending leave request whose day was already marked as that leave is finished.
 * The attendance mark stays. The request and its bell notification go away.
 */
export async function settleFulfilledLeaveRequest(record) {
    if (!record || !rowFulfillsOpenLeaveRequest(record)) return false;
    const groupId = String(record.leaveRequestGroupId || '').trim();
    const employeeMongoId = String(record.employeeMongoId || '');
    const recordId = record._id;
    clearRequestFields(record);
    await record.save();
    await closeBellWhenGroupHasNoPending({
        groupId,
        employeeMongoId,
        recordIds: [recordId],
    });
    return true;
}

/** Close open requests in this list whose attendance is already the requested leave. */
export async function settleFulfilledLeaveRows(rows) {
    const fulfilled = (rows || []).filter(rowFulfillsOpenLeaveRequest);
    if (!fulfilled.length) return rows || [];
    const docs = await Attendance.find({ _id: { $in: fulfilled.map((row) => row._id) } });
    for (const doc of docs) {
        await settleFulfilledLeaveRequest(doc);
    }
    const done = new Set(fulfilled.map((row) => String(row._id)));
    return (rows || []).filter((row) => !done.has(String(row._id)));
}

/** Put an approved leave back to the status it had, and open the request again. */
export async function reopenApprovedLeaveRecords(records) {
    const approved = (records || []).filter((row) => String(row.leaveRequestStatus || '') === 'approved');
    for (const record of approved) {
        const prevKey = String(record.previousStatusKey || 'not_marked').trim() || 'not_marked';
        record.statusKey = prevKey;
        record.statusLabel =
            String(record.previousStatusLabel || '').trim() ||
            (prevKey === 'not_marked' ? 'Upcoming' : record.statusLabel);
        record.leavePayType = '';
        record.leaveDayFraction = null;
        record.approvalStatus = '';
        if (record.leaveRequestReason && record.reason === record.leaveRequestReason) {
            record.reason = '';
        }
        record.leaveRequestStatus = 'pending';
        record.leaveDecidedAt = null;
        record.leaveDecidedBy = null;
        await record.save();
    }
    return approved;
}
