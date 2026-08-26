import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../../utils/attendanceEmployeeFilters.js';
import {
    getScheduledEmailTimeZone,
    getZonedParts,
} from '../../utils/scheduleDailyAtMidnight.js';
import { decideLeaveRequestInternal } from '../attendanceController.js';

const LEAVE_TRACK_KEYS = [
    'authorized_leave',
    'unauthorized_leave',
    'sick_leave',
    'compoff_leave',
    'on_leave',
];

const LEAVE_TRACK_META = {
    authorized_leave: { label: 'Auth', fullLabel: 'Authorized Leave' },
    unauthorized_leave: { label: 'Unauth', fullLabel: 'Unauthorized Leave' },
    sick_leave: { label: 'Sick', fullLabel: 'Sick Leave' },
    compoff_leave: { label: 'Comp Off', fullLabel: 'Comp Off Leave' },
    on_leave: { label: 'Annual', fullLabel: 'Annual Leave' },
};

const PENDING_LEAVE_KINDS = ['leave', 'future_leave', 'future_annual'];

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function leaveTypeLabel(record) {
    const requested = String(record.requestedStatusLabel || '').trim();
    if (requested) return requested;

    const key = String(record.requestedStatusKey || '').trim();
    const labels = {
        sick_leave: 'Sick Leave',
        on_leave: 'Annual Leave',
        authorized_leave: 'Authorize Leave',
        unauthorized_leave: 'Unauthorized Leave',
        compoff_leave: 'Comp Off Leave',
    };
    return labels[key] || 'Leave Request';
}

function formatDisplayDate(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return dateKey || '—';
    const [year, month, day] = dateKey.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatEndDateLabel(record) {
    const fromDate = record.leaveRequestFromDate || record.date;
    const toDate = record.leaveRequestToDate || record.date;

    if (record.leaveRequestDayPart === 'half' && record.leaveRequestTimeIn && record.leaveRequestTimeOut) {
        return `First Half (${record.leaveRequestTimeIn} – ${record.leaveRequestTimeOut})`;
    }

    if (fromDate && toDate && fromDate !== toDate) {
        return formatDisplayDate(toDate);
    }

    if (record.leaveRequestDayPart === 'half') return 'First Half';
    return formatDisplayDate(toDate || record.date);
}

function groupPendingRows(rows) {
    const groups = new Map();

    for (const row of rows) {
        const groupKey =
            String(row.leaveRequestGroupId || '').trim() ||
            `${row.employeeMongoId}-${row.leaveRequestFromDate || row.date}-${row.leaveRequestToDate || row.date}-${row.requestedStatusKey || ''}`;

        if (!groups.has(groupKey)) {
            groups.set(groupKey, {
                id: String(row._id),
                attendanceIds: [],
                employeeMongoId: String(row.employeeMongoId || ''),
                employeeId: row.employeeId || '',
                name: row.employeeName || 'Employee',
                leaveType: leaveTypeLabel(row),
                startDate: formatDisplayDate(row.leaveRequestFromDate || row.date),
                endDate: formatEndDateLabel(row),
                startDateKey: row.leaveRequestFromDate || row.date,
                endDateKey: row.leaveRequestToDate || row.date,
                status: 'Pending',
                requestedStatusKey: row.requestedStatusKey || '',
                leaveRequestKind: row.leaveRequestKind || 'leave',
            });
        }

        const group = groups.get(groupKey);
        group.attendanceIds.push(String(row._id));
        if (String(row._id) < String(group.id)) {
            group.id = String(row._id);
        }
    }

    return Array.from(groups.values()).sort((a, b) =>
        String(b.startDateKey).localeCompare(String(a.startDateKey)),
    );
}

async function resolveActorEmployee(req) {
    const selectFields = '_id employeeId firstName lastName companyEmail workEmail email staffType';

    if (req.user?.employeeObjectId) {
        const employee = await EmployeeBasic.findById(req.user.employeeObjectId)
            .select(selectFields)
            .lean();
        if (employee) return employee;
    }

    if (req.user?.employeeId) {
        const employee = await EmployeeBasic.findOne({ employeeId: req.user.employeeId })
            .select(selectFields)
            .lean();
        if (employee) return employee;
    }

    const emailCandidates = [req.user?.companyEmail, req.user?.email]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean);

    if (emailCandidates.length) {
        const employee = await EmployeeBasic.findOne({
            $or: [
                { companyEmail: { $in: emailCandidates } },
                { workEmail: { $in: emailCandidates } },
                { email: { $in: emailCandidates } },
            ],
        })
            .select(selectFields)
            .lean();
        if (employee) return employee;
    }

    return null;
}

/**
 * GET /api/Leave/pending-requests?year=YYYY
 * All pending leave requests for active employees (HR Leave dashboard).
 */
export async function getLeavePendingRequests(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const requestedYear = Number(req.query.year);
        const year =
            Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
                ? requestedYear
                : null;
        const yearFrom = year ? `${year}-01-01` : '';
        const yearTo = year ? `${year}-12-31` : '';

        const activeEmployees = await EmployeeBasic.find({
            profileStatus: 'active',
            status: { $ne: 'Left User' },
            employeeId: { $ne: 'VEGA-HR-0000' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('_id')
            .lean()
            .maxTimeMS(12000);

        const employeeIds = (activeEmployees || [])
            .filter((row) => !isCompanyShellEmployee(row))
            .map((row) => String(row._id));

        if (!employeeIds.length) {
            return res.status(200).json({
                message: 'Leave pending requests fetched successfully',
                year,
                count: 0,
                items: [],
            });
        }

        const yearDateFilter = year
            ? {
                  $or: [
                      { leaveRequestFromDate: { $gte: yearFrom, $lte: yearTo } },
                      {
                          $and: [
                              {
                                  $or: [
                                      { leaveRequestFromDate: { $exists: false } },
                                      { leaveRequestFromDate: null },
                                      { leaveRequestFromDate: '' },
                                  ],
                              },
                              { date: { $gte: yearFrom, $lte: yearTo } },
                          ],
                      },
                  ],
              }
            : {};

        const rows = await Attendance.find({
            leaveRequestStatus: 'pending',
            leaveRequestKind: { $in: PENDING_LEAVE_KINDS },
            employeeMongoId: { $in: employeeIds },
            employeeName: { $not: /\(company\)\s*$/i },
            ...yearDateFilter,
        })
            .sort({ leaveRequestedAt: -1, date: -1 })
            .limit(500)
            .lean()
            .maxTimeMS(12000);

        const items = groupPendingRows(
            (rows || []).filter((row) => !isCompanyShellEmployee(row.employeeName) && !isCompanyShellEmployee(row)),
        );

        return res.status(200).json({
            message: 'Leave pending requests fetched successfully',
            year,
            count: items.length,
            items,
        });
    } catch (error) {
        console.error('[getLeavePendingRequests]', error);
        return res.status(500).json({
            message: error.message || 'Failed to fetch leave pending requests.',
        });
    }
}

/**
 * POST /api/Leave/pending-requests/decide
 * Body: { attendanceId, decision: 'approved'|'rejected', approvedStatusKey?, leavePayType? }
 */
export async function decideLeavePendingRequest(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const actor = await resolveActorEmployee(req);
        if (!actor) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const attendanceId = String(req.body?.attendanceId || '').trim();
        const decision = String(req.body?.decision || '').trim().toLowerCase();
        const approvedStatusKey = String(req.body?.approvedStatusKey || '').trim();
        const leavePayType = String(req.body?.leavePayType || 'paid').trim();

        if (!attendanceId) {
            return res.status(400).json({ message: 'attendanceId is required.' });
        }
        if (decision !== 'approved' && decision !== 'rejected') {
            return res.status(400).json({ message: 'decision must be approved or rejected.' });
        }

        const pendingRecord = await Attendance.findById(attendanceId).lean();
        const resolvedApprovedKey =
            approvedStatusKey ||
            String(pendingRecord?.requestedStatusKey || '').trim();

        const result = await decideLeaveRequestInternal({
            attendanceId,
            decision,
            approvedStatusKey: resolvedApprovedKey,
            leavePayType,
            actor,
            hrBypass: true,
        });

        if (!result.ok) {
            return res.status(result.status || 400).json({ message: result.message });
        }

        return res.status(200).json({
            message:
                decision === 'approved'
                    ? 'Leave request approved successfully.'
                    : 'Leave request rejected successfully.',
            record: result.record,
        });
    } catch (error) {
        console.error('[decideLeavePendingRequest]', error);
        return res.status(500).json({
            message: error.message || 'Failed to decide leave request.',
        });
    }
}

/** Inclusive calendar days from fromKey to toKey (holidays included). */
function countInclusiveDays(fromKey, toKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey) || toKey < fromKey) {
        return 0;
    }
    let count = 0;
    for (let cursor = fromKey; cursor <= toKey; ) {
        count += 1;
        if (count > 366) break;
        const [year, month, day] = cursor.split('-').map(Number);
        const next = new Date(year, month - 1, day + 1);
        cursor = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    }
    return count;
}

function employeeDisplayName(emp) {
    return [emp?.firstName, emp?.lastName].filter(Boolean).join(' ').trim();
}

/**
 * POST /api/Leave/apply
 * Confirm selected range on Leave Calendar.
 * Day count < 5 (including holidays) → authorized_leave
 * Day count >= 5 → on_leave (annual)
 * Body: { employeeId, from, to, leavePayType? }
 */
export async function applyLeaveRange(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const employeeMongoId = String(req.body?.employeeId || req.body?.employeeMongoId || '').trim();
        const from = String(req.body?.from || req.body?.fromDate || '').trim();
        const to = String(req.body?.to || req.body?.toDate || '').trim();
        const leavePayType =
            String(req.body?.leavePayType || 'paid').trim().toLowerCase() === 'unpaid'
                ? 'unpaid'
                : 'paid';

        if (!employeeMongoId || !mongoose.Types.ObjectId.isValid(employeeMongoId)) {
            return res.status(400).json({ message: 'Valid employeeId is required.' });
        }
        if (
            !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
            !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
            to < from
        ) {
            return res.status(400).json({ message: 'Valid from and to dates (yyyy-MM-dd) are required.' });
        }

        const employee = await EmployeeBasic.findById(employeeMongoId)
            .select('_id employeeId firstName lastName status profileStatus')
            .lean();

        if (!employee || isCompanyShellEmployee(employee)) {
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const dayCount = countInclusiveDays(from, to);
        if (dayCount < 1) {
            return res.status(400).json({ message: 'Selected date range is empty.' });
        }

        const isAuthorize = dayCount < 5;
        const statusKey = isAuthorize ? 'authorized_leave' : 'on_leave';
        const statusLabel = isAuthorize
            ? leavePayType === 'unpaid'
                ? 'Authorized Leave (Unpaid)'
                : 'Authorized Leave (Paid)'
            : 'Annual Leave';

        const markedBy = req.user?.id || null;
        const employeeName = employeeDisplayName(employee);
        const employeeId = employee.employeeId || '';
        const saved = [];

        for (let cursor = from; cursor <= to; ) {
            const doc = await Attendance.findOneAndUpdate(
                { date: cursor, employeeMongoId: String(employee._id) },
                {
                    $set: {
                        date: cursor,
                        employeeMongoId: String(employee._id),
                        employeeId,
                        employeeName,
                        statusKey,
                        statusLabel,
                        leavePayType: isAuthorize ? leavePayType : '',
                        timeIn: '',
                        timeOut: '',
                        reason: isAuthorize
                            ? `Authorize leave (${dayCount} day${dayCount === 1 ? '' : 's'})`
                            : `Annual leave (${dayCount} days)`,
                        approvalStatus: 'approved',
                        leaveRequestStatus: '',
                        leaveRequestKind: '',
                        leaveRequestFromDate: from,
                        leaveRequestToDate: to,
                        leaveRequestGroupId: '',
                        requestedStatusKey: '',
                        requestedStatusLabel: '',
                        previousStatusKey: '',
                        previousStatusLabel: '',
                        leaveRequestReason: '',
                        leaveRequestDayPart: '',
                        leaveRequestTimeIn: '',
                        leaveRequestTimeOut: '',
                        markedBy,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );
            saved.push(doc);

            const [year, month, day] = cursor.split('-').map(Number);
            const next = new Date(year, month - 1, day + 1);
            cursor = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
        }

        return res.status(200).json({
            message: isAuthorize
                ? `Authorize leave saved for ${dayCount} day${dayCount === 1 ? '' : 's'}.`
                : `Annual leave saved for ${dayCount} days.`,
            from,
            to,
            dayCount,
            statusKey,
            statusLabel,
            leaveType: isAuthorize ? 'authorized' : 'annual',
            count: saved.length,
            records: saved.map((row) => ({
                id: String(row._id),
                date: row.date,
                statusKey: row.statusKey,
                statusLabel: row.statusLabel,
            })),
        });
    } catch (error) {
        console.error('[applyLeaveRange]', error);
        return res.status(500).json({
            message: error.message || 'Failed to apply leave.',
        });
    }
}

/**
 * GET /api/Leave/team-track?year=YYYY
 * Monthly leave-day totals for the team (approved leave marks).
 */
export async function getLeaveTeamTrack(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
        const requestedYear = Number(req.query.year);
        const year =
            Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
                ? requestedYear
                : dubai.year;
        const from = `${year}-01-01`;
        const to = `${year}-12-31`;

        const activeEmployees = await EmployeeBasic.find({
            profileStatus: 'active',
            status: { $ne: 'Left User' },
            employeeId: { $ne: 'VEGA-HR-0000' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('_id')
            .lean()
            .maxTimeMS(12000);

        const employeeIds = (activeEmployees || [])
            .filter((row) => !isCompanyShellEmployee(row))
            .map((row) => String(row._id));

        const grouped =
            employeeIds.length === 0
                ? []
                : await Attendance.aggregate([
                      {
                          $match: {
                              employeeMongoId: { $in: employeeIds },
                              date: { $gte: from, $lte: to },
                              statusKey: { $in: LEAVE_TRACK_KEYS },
                          },
                      },
                      {
                          $group: {
                              _id: {
                                  monthKey: { $substr: ['$date', 0, 7] },
                                  statusKey: '$statusKey',
                              },
                              total: { $sum: 1 },
                          },
                      },
                      { $sort: { '_id.monthKey': 1, '_id.statusKey': 1 } },
                  ]).option({ maxTimeMS: 12000 });

        const totalsByMonth = new Map();
        for (const row of grouped || []) {
            const monthKey = String(row?._id?.monthKey || '');
            const statusKey = String(row?._id?.statusKey || '');
            if (!monthKey || !statusKey) continue;
            if (!totalsByMonth.has(monthKey)) totalsByMonth.set(monthKey, {});
            totalsByMonth.get(monthKey)[statusKey] = Number(row.total) || 0;
        }

        const months = MONTH_LABELS.map((label, index) => {
            const monthKey = `${year}-${String(index + 1).padStart(2, '0')}`;
            const monthCounts = totalsByMonth.get(monthKey) || {};
            return {
                month: label,
                monthKey,
                total: Object.values(monthCounts).reduce((sum, value) => sum + (Number(value) || 0), 0),
                authorizedLeave: monthCounts.authorized_leave || 0,
                unauthorizedLeave: monthCounts.unauthorized_leave || 0,
                sickLeave: monthCounts.sick_leave || 0,
                compoffLeave: monthCounts.compoff_leave || 0,
                annualLeave: monthCounts.on_leave || 0,
            };
        });

        return res.status(200).json({
            message: 'Leave team track fetched successfully',
            year,
            months,
            series: Object.entries(LEAVE_TRACK_META).map(([statusKey, meta]) => ({
                statusKey,
                dataKey:
                    statusKey === 'authorized_leave'
                        ? 'authorizedLeave'
                        : statusKey === 'unauthorized_leave'
                          ? 'unauthorizedLeave'
                          : statusKey === 'sick_leave'
                            ? 'sickLeave'
                            : statusKey === 'compoff_leave'
                              ? 'compoffLeave'
                              : 'annualLeave',
                label: meta.label,
                fullLabel: meta.fullLabel,
            })),
        });
    } catch (error) {
        console.error('[getLeaveTeamTrack]', error);
        return res.status(500).json({
            message: error.message || 'Failed to fetch leave team track.',
        });
    }
}
