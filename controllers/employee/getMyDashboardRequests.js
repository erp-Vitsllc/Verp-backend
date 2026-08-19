import mongoose from 'mongoose';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeHubRequest from '../../models/EmployeeHubRequest.js';
import Attendance from '../../models/Attendance.js';
import Loan from '../../models/Loan.js';
import { hubRequestDisplayLabel } from '../../utils/employeeHubRequestTypes.js';

const LOAN_REQUEST_STATUSES = new Set([
    'Draft', 'Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization',
    'Approved', 'Pending Payment to Employee', 'Rejected', 'Cancelled',
]);

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

export async function getMyDashboardRequests(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Database not connected.' });
        const self = await resolveSelf(req);
        if (!self?._id) return res.status(200).json({ requests: [] });

        const employeeMongoId = String(self._id);
        const employeeId = String(self.employeeId || '').trim();
        const loanQuery = { $or: [{ employeeObjectId: self._id }] };
        if (employeeId) loanQuery.$or.push({ employeeId });

        const [hubRows, attendanceRows, loanRows] = await Promise.all([
            EmployeeHubRequest.find({ requester: self._id }).sort({ createdAt: -1 }).limit(40).lean(),
            Attendance.find({ employeeMongoId, leaveRequestStatus: { $in: ['pending', 'approved', 'rejected'] } }).sort({ leaveRequestedAt: -1, updatedAt: -1 }).limit(120).lean(),
            Loan.find(loanQuery).select('type loanId reason status approvalStatus appliedDate createdAt').sort({ createdAt: -1 }).limit(40).lean(),
        ]);

        const leaveSeen = new Set();
        const requests = [];

        for (const row of hubRows || []) {
            const label = hubRequestDisplayLabel(row.kind, row.assetType);
            requests.push({ id: String(row._id), source: 'hub', label: `${label} request`, detail: String(row.description || '').slice(0, 120), status: normalizeStatus(row.status), date: row.createdAt || null, href: `/dashboard?hubRequestId=${encodeURIComponent(String(row._id))}` });
        }
        for (const row of attendanceRows || []) {
            const key = String(row.leaveRequestGroupId || row._id);
            if (leaveSeen.has(key)) continue;
            leaveSeen.add(key);
            const { type, detail } = leaveRequestLabel(row);
            requests.push({ id: key, source: 'leave', label: type, detail, status: normalizeStatus(row.leaveRequestStatus), date: row.leaveRequestedAt || row.createdAt || null, href: '/dashboard?focusAttendance=1' });
        }
        for (const row of loanRows || []) {
            const statusRaw = String(row.approvalStatus || row.status || '').trim();
            if (!LOAN_REQUEST_STATUSES.has(statusRaw)) continue;
            const type = row.type === 'Advance' ? 'Advance' : 'Loan';
            requests.push({ id: String(row._id), source: 'loan', label: `${type} request`, detail: row.loanId || row.reason || type, status: normalizeStatus(statusRaw), date: row.appliedDate || row.createdAt || null, href: `/HRM/LoanAndAdvance/${type.replace(/\s+/g, '-')}-${row._id}` });
        }

        requests.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
        return res.status(200).json({ requests: requests.slice(0, 50) });
    } catch (error) {
        console.error('[getMyDashboardRequests]', error);
        return res.status(500).json({ message: error.message || 'Failed to load your requests.' });
    }
}
