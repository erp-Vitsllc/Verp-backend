import mongoose from 'mongoose';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeHubRequest from '../../models/EmployeeHubRequest.js';
import Attendance from '../../models/Attendance.js';
import Loan from '../../models/Loan.js';
import { hubRequestDisplayLabel } from '../../utils/employeeHubRequestTypes.js';
import { leaveDashboardRequestObjectId } from '../../utils/notifyLeaveDashboardRequest.js';
import { taskNumbersByRecordId } from '../stats/getTaskManagerNotifications.js';

function isPendingStatus(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) return false;
    if (s.includes("reject") || s.includes("cancel") || s === "draft") return false;
    return s.includes("pending");
}

async function resolveSelf(req) {
    if (req.user?.employeeObjectId) {
        const byOid = await EmployeeBasic.findById(req.user.employeeObjectId).select('_id employeeId').lean();
        if (byOid) return byOid;
    }
    if (req.user?.employeeId) {
        return EmployeeBasic.findOne({ employeeId: req.user.employeeId }).select('_id employeeId').lean();
    }
    return null;
}

function normalizeStatus(raw) {
    const value = String(raw || '').trim();
    if (!value) return 'Pending';
    const lower = value.toLowerCase();
    if (lower === 'pending') return 'Pending';
    if (lower === 'approved') return 'Approved';
    if (lower === 'rejected') return 'Rejected';
    if (lower.includes('reject')) return 'Rejected';
    if (lower.includes('cancel')) return 'Cancelled';
    if (lower === 'draft') return 'Draft';
    if (lower.includes('pending')) return value;
    return value;
}

function leaveRequestLabel(row) {
    const from = String(row.leaveRequestFromDate || row.date || '').trim();
    const to = String(row.leaveRequestToDate || from).trim();
    const range = from && to && from !== to ? `${from} → ${to}` : from || row.date || '';
    const type = row.requestedStatusLabel || (row.leaveRequestKind === 'future_annual' ? 'Annual leave' : row.leaveRequestKind === 'yellow' ? 'Attendance clarification' : 'Leave request');
    return { type, detail: range };
}

function clipText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function dateKeyOf(value) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return '';
}

function markAttendanceHref(date, attendanceId) {
    const day = dateKeyOf(date);
    if (!day) return '';
    const params = new URLSearchParams({ date: day });
    const id = String(attendanceId || '').trim();
    if (id) params.set('leaveAttendanceId', id);
    return `/HRM/Attendance/mark?${params.toString()}`;
}

function hubDetailHref(row) {
    const kind = String(row?.kind || '').trim();
    const area = String(row?.assetType || '').trim();
    const day = dateKeyOf(row?.requestedDate);
    if (kind === 'leave') return markAttendanceHref(day) || '/HRM/Leave';
    if (kind === 'loan' || kind === 'advance') return '/HRM/LoanAndAdvance';
    if (kind === 'salary' || kind === 'certificate') return '/HRM/Salary';
    if (kind === 'fine') return '/HRM/Fine';
    if (kind === 'vehicle' || area === 'Vehicle') return '/HRM/Asset/Vehicle';
    if (kind === 'utility' || area === 'Utility Bill') return '/HRM/Asset/UtilityBills';
    if (kind === 'assets') return '/HRM/Asset';
    return '/dashboard';
}

export async function getMyDashboardRequests(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Database not connected.' });
        const self = await resolveSelf(req);
        if (!self?._id) return res.status(200).json({ requests: [] });

        const employeeMongoId = String(self._id);
        const employeeId = String(self.employeeId || '').trim();
        const employeeMatch = [{ employeeObjectId: self._id }];
        if (employeeId) employeeMatch.push({ employeeId });

        const [hubRows, attendanceRows, loanRows] = await Promise.all([
            EmployeeHubRequest.find({ requester: self._id, status: { $regex: /pending/i } }).sort({ createdAt: -1 }).limit(40).lean(),
            Attendance.find({ employeeMongoId, leaveRequestStatus: 'pending' }).sort({ leaveRequestedAt: -1, updatedAt: -1 }).limit(120).lean(),
            Loan.find({
                $and: [
                    { $or: employeeMatch },
                    {
                        $or: [
                            { approvalStatus: { $regex: /pending/i } },
                            { status: { $regex: /pending/i } },
                        ],
                    },
                ],
            }).select('type loanId reason status approvalStatus appliedDate createdAt').sort({ createdAt: -1 }).limit(40).lean(),
        ]);

        const leaveSeen = new Set();
        const requests = [];

        for (const row of hubRows || []) {
            const status = normalizeStatus(row.status);
            if (!isPendingStatus(status)) continue;
            const label = hubRequestDisplayLabel(row.kind, row.assetType);
            requests.push({
                id: String(row._id),
                source: 'hub',
                label: `${label} request`,
                detail: String(row.description || '').slice(0, 120),
                reason: clipText(row.reason || row.description),
                lookupIds: [String(row._id)],
                status,
                date: row.requestedDate || row.createdAt || null,
                href: hubDetailHref(row),
            });
        }
        for (const row of attendanceRows || []) {
            const key = String(row.leaveRequestGroupId || row._id);
            if (leaveSeen.has(key)) continue;
            leaveSeen.add(key);
            const status = normalizeStatus(row.leaveRequestStatus);
            if (!isPendingStatus(status)) continue;
            const { type, detail } = leaveRequestLabel(row);
            const dashboardId = String(leaveDashboardRequestObjectId(row.leaveRequestGroupId, row._id));
            requests.push({
                id: key,
                source: 'leave',
                label: type,
                detail,
                reason: clipText(row.leaveRequestReason || row.reason || type),
                lookupIds: [dashboardId, key, String(row._id)].filter(Boolean),
                status,
                date: row.leaveRequestedAt || row.createdAt || null,
                href: markAttendanceHref(row.date || row.leaveRequestFromDate, row._id) || '/HRM/Attendance/mark',
            });
        }
        for (const row of loanRows || []) {
            const statusRaw = String(row.approvalStatus || row.status || '').trim();
            const status = normalizeStatus(statusRaw);
            if (!isPendingStatus(status)) continue;
            const type = row.type === 'Advance' ? 'Advance' : 'Loan';
            requests.push({
                id: String(row._id),
                source: 'loan',
                label: `${type} request`,
                detail: row.loanId || row.reason || type,
                reason: clipText(row.reason || type),
                lookupIds: [String(row._id)],
                status,
                date: row.appliedDate || row.createdAt || null,
                href: `/HRM/LoanAndAdvance/${type.replace(/\s+/g, '-')}-${row._id}`,
            });
        }

        const numbers = await taskNumbersByRecordId(requests.flatMap((item) => item.lookupIds || []));
        for (const item of requests) {
            item.taskNo = (item.lookupIds || []).map((id) => numbers.get(id)).find(Boolean) || '';
            delete item.lookupIds;
        }

        requests.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
        return res.status(200).json({ requests: requests.slice(0, 50) });
    } catch (error) {
        console.error('[getMyDashboardRequests]', error);
        return res.status(500).json({ message: error.message || 'Failed to load your requests.' });
    }
}
