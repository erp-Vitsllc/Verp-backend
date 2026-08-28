import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../../utils/attendanceEmployeeFilters.js';
import {
    isEmployeeLeaveDateVisible,
    isLeaveEntryVisible,
    isLeaveRangeEntryVisible,
    leaveVisibilityByEmployeeId,
    loadEnrolledLeaveVisibilityByMongoId,
} from '../../utils/leaveSalaryVisibility.js';
import {
    getScheduledEmailTimeZone,
    getZonedParts,
} from '../../utils/scheduleDailyAtMidnight.js';
import { listActiveWorkLocations, normalizeStaffTypeKey } from '../../utils/workLocationHelpers.js';
import { decideLeaveRequestInternal } from '../attendanceController.js';
import { hasPermission } from '../../services/permissionService.js';
import { listPendingHubInboxItems } from '../../utils/employeeHubRequestInbox.js';
import { isReqUserSystemSuperUser } from '../../utils/systemSuperUser.js';
import { syncDashboardAction } from '../../utils/syncDashboard.js';
import {
    LEAVE_DASHBOARD_REQUEST_TYPE,
    leaveDashboardRequestObjectId,
    notifyPrimaryReporteeOfLeaveRequest,
} from '../../utils/notifyLeaveDashboardRequest.js';

const LEAVE_TRACK_KEYS = [
    'authorized_leave',
    'unauthorized_leave',
    'sick_leave',
    'compoff_leave',
    'on_leave',
];

function trackStatusKeysForLeaveType(leaveType) {
    const raw = String(leaveType || 'all').trim().toLowerCase();
    const map = {
        sick: 'sick_leave',
        sick_leave: 'sick_leave',
        authorized: 'authorized_leave',
        authorize: 'authorized_leave',
        authorized_leave: 'authorized_leave',
        unauthorized: 'unauthorized_leave',
        unauthorized_leave: 'unauthorized_leave',
        compoff: 'compoff_leave',
        comp_off: 'compoff_leave',
        'comp-off': 'compoff_leave',
        compoff_leave: 'compoff_leave',
        annual: 'on_leave',
        on_leave: 'on_leave',
    };
    const key = map[raw];
    return key ? [key] : LEAVE_TRACK_KEYS;
}

const LEAVE_TRACK_META = {
    authorized_leave: { label: 'Auth', fullLabel: 'Authorized Leave' },
    unauthorized_leave: { label: 'Unauth', fullLabel: 'Unauthorized Leave' },
    sick_leave: { label: 'Sick', fullLabel: 'Sick Leave' },
    compoff_leave: { label: 'Comp Off', fullLabel: 'Comp Off Leave' },
    on_leave: { label: 'Annual', fullLabel: 'Annual Leave' },
};

const PENDING_LEAVE_KINDS = ['leave', 'future_leave', 'future_annual'];

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shiftYearMonth(year, month, deltaMonths) {
    const index = Number(year) * 12 + (Number(month) - 1) + Number(deltaMonths || 0);
    const nextYear = Math.floor(index / 12);
    const nextMonth = (index % 12) + 1;
    return { year: nextYear, month: nextMonth };
}

function lastDateKeyOfMonth(year, month) {
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

function rollingTrackWindow(dubai) {
    const endYear = Number(dubai.year);
    const endMonth = Number(dubai.month);
    const start = shiftYearMonth(endYear, endMonth, -11);
    return {
        from: `${start.year}-${String(start.month).padStart(2, '0')}-01`,
        to: lastDateKeyOfMonth(endYear, endMonth),
        startYear: start.year,
        startMonth: start.month,
        endYear,
        endMonth,
        rangeLabel: `${MONTH_LABELS[start.month - 1]} ${start.year} – ${MONTH_LABELS[endMonth - 1]} ${endYear}`,
    };
}

function monthPeriodRows(fromYear, fromMonth, toYear, toMonth) {
    const rows = [];
    let year = Number(fromYear);
    let month = Number(fromMonth);
    while (year < toYear || (year === toYear && month <= toMonth)) {
        rows.push({
            periodKey: `${year}-${String(month).padStart(2, '0')}`,
            label: MONTH_LABELS[month - 1],
        });
        const next = shiftYearMonth(year, month, 1);
        year = next.year;
        month = next.month;
        if (rows.length > 24) break;
    }
    return rows;
}

function locationGroupsForCounts(locCounts, catalog, locationLabel) {
    const seen = new Set();
    const groups = [];
    for (const loc of catalog) {
        seen.add(loc.key);
        groups.push({
            key: loc.key,
            label: loc.label || loc.key,
            total: locCounts.get(loc.key) || 0,
        });
    }
    for (const [key, total] of locCounts.entries()) {
        if (seen.has(key)) continue;
        groups.push({
            key,
            label: locationLabel.get(key) || key,
            total,
        });
    }
    return groups;
}

function teamTrackPeriodRow({ label, periodKey, monthCounts, locCounts, catalog, locationLabel }) {
    const counts = monthCounts || {};
    return {
        month: label,
        monthKey: periodKey,
        total: Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0),
        groups: locationGroupsForCounts(locCounts || new Map(), catalog, locationLabel),
        authorizedLeave: counts.authorized_leave || 0,
        unauthorizedLeave: counts.unauthorized_leave || 0,
        sickLeave: counts.sick_leave || 0,
        compoffLeave: counts.compoff_leave || 0,
        annualLeave: counts.on_leave || 0,
    };
}

function leaveTypeLabel(record) {
    const requested = String(record.requestedStatusLabel || record.statusLabel || '').trim();
    const key = String(record.requestedStatusKey || record.statusKey || '').trim();
    const labels = {
        sick_leave: 'Sick Leave',
        on_leave: 'Annual Leave',
        authorized_leave: 'Authorize Leave',
        unauthorized_leave: 'Unauthorized Leave',
        compoff_leave: 'Comp Off Leave',
    };
    if (labels[key]) return labels[key];
    if (requested) return requested;
    return 'Leave Request';
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

function requestStatusMeta(status) {
    const raw = String(status || 'pending').trim().toLowerCase();
    if (raw === 'approved') return { status: 'Approved', statusKey: 'approved' };
    if (raw === 'rejected') return { status: 'Rejected', statusKey: 'rejected' };
    return { status: 'Pending', statusKey: 'pending' };
}

function groupPendingRows(rows) {
    const groups = new Map();

    for (const row of rows) {
        const groupKey =
            String(row.leaveRequestGroupId || '').trim() ||
            `${row.employeeMongoId}-${row.leaveRequestFromDate || row.date}-${row.leaveRequestToDate || row.date}-${row.requestedStatusKey || ''}`;
        const meta = requestStatusMeta(row.leaveRequestStatus);

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
                status: meta.status,
                statusKey: meta.statusKey,
                requestedStatusKey: row.requestedStatusKey || row.statusKey || '',
                leaveRequestKind: row.leaveRequestKind || 'leave',
                sortAt: row.leaveRequestedAt || row.leaveDecidedAt || row.date || '',
            });
        }

        const group = groups.get(groupKey);
        group.attendanceIds.push(String(row._id));
        if (String(row._id) < String(group.id)) {
            group.id = String(row._id);
        }
        if (meta.statusKey === 'pending') {
            group.status = 'Pending';
            group.statusKey = 'pending';
        }
        const sortAt = row.leaveRequestedAt || row.leaveDecidedAt || '';
        if (sortAt && (!group.sortAt || String(sortAt) > String(group.sortAt))) {
            group.sortAt = sortAt;
        }
    }

    return Array.from(groups.values()).sort((a, b) => {
        const pendingRank = (row) => (row.statusKey === 'pending' ? 0 : 1);
        const rank = pendingRank(a) - pendingRank(b);
        if (rank !== 0) return rank;
        return String(b.startDateKey || '').localeCompare(String(a.startDateKey || ''));
    });
}

function coverLeaveDates(covered, employeeMongoId, fromKey, toKey) {
    const from = String(fromKey || toKey || '').trim();
    const to = String(toKey || fromKey || '').trim();
    if (!from) return;
    const end = to >= from ? to : from;
    for (const dateKey of dateKeysInRange(from, end)) {
        covered.add(`${employeeMongoId}|${dateKey}`);
    }
}

function normalizeCompletedLeaveRow(row) {
    const statusKey = String(row.statusKey || row.requestedStatusKey || '').trim();
    return {
        ...row,
        leaveRequestStatus: 'approved',
        requestedStatusKey: row.requestedStatusKey || statusKey,
        requestedStatusLabel: row.requestedStatusLabel || row.statusLabel || '',
        leaveRequestFromDate: row.leaveRequestFromDate || row.date,
        leaveRequestToDate: row.leaveRequestToDate || row.date,
        statusKey,
    };
}

function mergeAdjacentApprovedItems(items) {
    const sorted = [...items].sort((a, b) => {
        const emp = String(a.employeeMongoId || '').localeCompare(String(b.employeeMongoId || ''));
        if (emp) return emp;
        const type = String(a.requestedStatusKey || '').localeCompare(String(b.requestedStatusKey || ''));
        if (type) return type;
        return String(a.startDateKey || '').localeCompare(String(b.startDateKey || ''));
    });

    const merged = [];
    for (const item of sorted) {
        const last = merged[merged.length - 1];
        if (
            last &&
            last.statusKey === 'approved' &&
            item.statusKey === 'approved' &&
            String(last.employeeMongoId) === String(item.employeeMongoId) &&
            String(last.requestedStatusKey) === String(item.requestedStatusKey) &&
            nextDateKey(last.endDateKey) === item.startDateKey
        ) {
            last.endDateKey = item.endDateKey;
            last.endDate = item.endDate;
            last.attendanceIds = [...(last.attendanceIds || []), ...(item.attendanceIds || [])];
            continue;
        }
        merged.push({ ...item, attendanceIds: [...(item.attendanceIds || [])] });
    }
    return merged;
}

async function resolveLeaveHrFlags(req) {
    const userId = req.user?._id || req.user?.id;
    const isSuper = await isReqUserSystemSuperUser(req.user);
    const canView = Boolean(userId && (await hasPermission(userId, 'hrm_leave', 'view')));
    const canEdit = Boolean(
        isSuper ||
            (userId &&
                ((await hasPermission(userId, 'hrm_leave', 'edit')) ||
                    (await hasPermission(userId, 'hrm_leave', 'create')))),
    );
    return {
        userId,
        canEdit,
        isHr: Boolean(isSuper || canView || canEdit),
    };
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
 * GET /api/Leave/pending-requests?year=YYYY|all
 * All pending leave requests for active employees (HR Leave dashboard).
 */
export async function getLeavePendingRequests(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const yearRaw = String(req.query.year || '').trim().toLowerCase();
        const requestedYear = Number(req.query.year);
        const year =
            yearRaw === 'all'
                ? null
                : Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
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
            .select('_id employeeId primaryReportee')
            .lean()
            .maxTimeMS(12000);

        const realEmployees = (activeEmployees || []).filter((row) => !isCompanyShellEmployee(row));
        const visibility = await loadEnrolledLeaveVisibilityByMongoId(realEmployees);
        const visibilityByCode = leaveVisibilityByEmployeeId(realEmployees, visibility);
        const employeeIds = realEmployees
            .map((row) => String(row._id))
            .filter((id) => visibility.has(id));
        const enrolledCodes = realEmployees
            .filter((row) => visibility.has(String(row._id)))
            .map((row) => String(row.employeeId || '').trim())
            .filter(Boolean);

        if (!employeeIds.length) {
            return res.status(200).json({
                message: 'Leave pending requests fetched successfully',
                year: yearRaw === 'all' ? 'all' : year,
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

        const partyFilter = {
            $or: [
                { employeeMongoId: { $in: employeeIds } },
                ...(enrolledCodes.length ? [{ employeeId: { $in: enrolledCodes } }] : []),
            ],
        };

        const baseFilter = {
            leaveRequestKind: { $in: PENDING_LEAVE_KINDS },
            employeeName: { $not: /\(company\)\s*$/i },
            $and: [partyFilter, ...(year ? [yearDateFilter] : [])],
        };

        const [pendingRows, decidedRows, leaveMarkRows] = await Promise.all([
            Attendance.find({ ...baseFilter, leaveRequestStatus: 'pending' })
                .sort({ leaveRequestedAt: -1, date: -1 })
                .limit(1500)
                .lean()
                .maxTimeMS(12000),
            Attendance.find({
                ...baseFilter,
                leaveRequestStatus: { $in: ['approved', 'rejected'] },
            })
                .sort({ leaveDecidedAt: -1, leaveRequestedAt: -1, date: -1 })
                .limit(1500)
                .lean()
                .maxTimeMS(12000),
            Attendance.find({
                statusKey: { $in: LEAVE_TRACK_KEYS },
                employeeName: { $not: /\(company\)\s*$/i },
                $and: [partyFilter, ...(year ? [{ date: { $gte: yearFrom, $lte: yearTo } }] : [])],
            })
                .sort({ date: -1 })
                .limit(4000)
                .lean()
                .maxTimeMS(12000),
        ]);

        const visibleRows = [...(pendingRows || []), ...(decidedRows || [])].filter((row) => {
            if (isCompanyShellEmployee(row.employeeName) || isCompanyShellEmployee(row)) {
                return false;
            }
            const fromKey = row.leaveRequestFromDate || row.date;
            const toKey = row.leaveRequestToDate || row.date;
            return isLeaveRangeEntryVisible(
                row,
                fromKey,
                toKey,
                visibility,
                visibilityByCode,
            );
        });

        const requestItems = groupPendingRows(visibleRows);
        const coveredDates = new Set();
        for (const row of visibleRows) {
            coverLeaveDates(
                coveredDates,
                String(row.employeeMongoId || ''),
                row.leaveRequestFromDate || row.date,
                row.leaveRequestToDate || row.date,
            );
        }

        const extraLeaveRows = (leaveMarkRows || [])
            .filter((row) => {
                if (isCompanyShellEmployee(row.employeeName) || isCompanyShellEmployee(row)) {
                    return false;
                }
                if (coveredDates.has(`${row.employeeMongoId}|${row.date}`)) return false;
                return isLeaveRangeEntryVisible(
                    row,
                    row.date,
                    row.date,
                    visibility,
                    visibilityByCode,
                );
            })
            .map(normalizeCompletedLeaveRow);

        const completedItems = mergeAdjacentApprovedItems(groupPendingRows(extraLeaveRows));

        const actor = await resolveActorEmployee(req);
        const hrFlags = await resolveLeaveHrFlags(req);
        const isHr = hrFlags.isHr;
        const actorId = actor?._id ? String(actor._id) : '';
        const reporteeByMongoId = new Map(
            realEmployees.map((emp) => [String(emp._id), String(emp.primaryReportee || '')]),
        );

        const items = [...requestItems, ...completedItems]
            .map((item) => {
                const isPrimaryReportee =
                    Boolean(actorId) && reporteeByMongoId.get(String(item.employeeMongoId)) === actorId;
                const canDecide = item.statusKey === 'pending' && (isHr || isPrimaryReportee);
                return { ...item, canDecide, canEdit: hrFlags.canEdit };
            })
            .sort((a, b) => {
                const pendingRank = (row) => (row.statusKey === 'pending' ? 0 : 1);
                const rank = pendingRank(a) - pendingRank(b);
                if (rank !== 0) return rank;
                return String(b.startDateKey || '').localeCompare(String(a.startDateKey || ''));
            });

        return res.status(200).json({
            message: 'Leave requests fetched successfully',
            year: yearRaw === 'all' ? 'all' : year,
            count: items.length,
            canApproveAll: isHr,
            canEditAll: hrFlags.canEdit,
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

        const userId = req.user?._id || req.user?.id;
        const isHr = Boolean(
            userId &&
                ((await hasPermission(userId, 'hrm_leave', 'view')) ||
                    (await hasPermission(userId, 'hrm_leave', 'edit')) ||
                    (await hasPermission(userId, 'hrm_leave', 'create'))),
        );

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
            hrBypass: isHr,
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

/**
 * GET /api/Leave/dashboard/pending-inbox
 * Pending leave requests for the logged-in primary reportee (Leave Dashboard bell).
 */
export async function getLeavePendingInbox(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const actor = await resolveActorEmployee(req);
        if (!actor) {
            return res.status(200).json({
                message: 'Leave pending inbox fetched successfully',
                count: 0,
                items: [],
            });
        }

        const hubItems = await listPendingHubInboxItems({
            assigneeIds: [actor._id],
            kinds: ['leave'],
        });

        const reportees = await EmployeeBasic.find({ primaryReportee: actor._id })
            .select('_id')
            .lean();
        const reporteeIds = (reportees || []).map((row) => String(row._id)).filter(Boolean);

        let grouped = [];
        if (reporteeIds.length) {
            const rows = await Attendance.find({
                leaveRequestStatus: 'pending',
                employeeMongoId: { $in: reporteeIds },
                employeeName: { $not: /\(company\)\s*$/i },
            })
                .sort({ leaveRequestedAt: -1, date: -1 })
                .limit(800)
                .lean();

            const leaveRows = (rows || []).filter((row) => {
                if (isCompanyShellEmployee(row.employeeName) || isCompanyShellEmployee(row)) {
                    return false;
                }
                const kind = String(row.leaveRequestKind || '').trim();
                if (kind === 'yellow' || kind === 'future_late' || kind === 'future_early') {
                    return false;
                }
                return (
                    PENDING_LEAVE_KINDS.includes(kind) ||
                    LEAVE_TRACK_KEYS.includes(String(row.requestedStatusKey || '').trim())
                );
            });
            grouped = groupPendingRows(leaveRows).filter((item) => item.statusKey === 'pending');
        }

        const attendanceItems = grouped.map((group) => {
            const rangeLabel =
                group.startDateKey && group.endDateKey && group.startDateKey !== group.endDateKey
                    ? `${group.startDateKey} → ${group.endDateKey}`
                    : group.startDateKey || '';
            const summary = `${group.leaveType} request for ${rangeLabel || group.startDate}`;
            return {
                id: group.id,
                dashboardActionId: group.id,
                requestType: 'Employee Leave Request',
                requestObjectId: group.id,
                employeeMongoId: group.employeeMongoId,
                employeeId: group.employeeId,
                subjectName: group.name,
                startDate: group.startDate,
                endDate: group.endDate,
                startDateKey: group.startDateKey,
                endDateKey: group.endDateKey,
                requestedStatusKey: group.requestedStatusKey,
                leaveType: group.leaveType,
                leaveRequestKind: group.leaveRequestKind,
                status: 'Pending',
                extra1: group.startDateKey,
                extra2: summary,
                extra3: JSON.stringify({
                    attendanceId: group.id,
                    employeeMongoId: group.employeeMongoId,
                    from: group.startDateKey,
                    to: group.endDateKey,
                    requestedStatusKey: group.requestedStatusKey,
                    leaveRequestKind: group.leaveRequestKind,
                    leaveDashboard: true,
                }),
                message: summary,
                requestedDate: group.sortAt || new Date(),
            };
        });

        const hubMapped = hubItems.map((item) => {
            let meta = {};
            try {
                meta =
                    typeof item.extra3 === 'string'
                        ? JSON.parse(item.extra3 || '{}')
                        : item.extra3 && typeof item.extra3 === 'object'
                          ? item.extra3
                          : {};
            } catch {
                meta = {};
            }
            return {
                ...item,
                extra3: JSON.stringify({ ...meta, leaveDashboard: true, hubRequest: true }),
            };
        });

        const items = [...hubMapped, ...attendanceItems];
        return res.status(200).json({
            message: 'Leave pending inbox fetched successfully',
            count: items.length,
            items,
        });
    } catch (error) {
        console.error('[getLeavePendingInbox]', error);
        return res.status(500).json({
            message: error.message || 'Failed to fetch pending leave requests.',
        });
    }
}

function nextDateKey(dateKey) {
    const [year, month, day] = String(dateKey).split('-').map(Number);
    const next = new Date(year, month - 1, day + 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

/** Inclusive calendar days from fromKey to toKey (holidays included). */
function countInclusiveDays(fromKey, toKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey) || toKey < fromKey) {
        return 0;
    }
    let count = 0;
    for (let cursor = fromKey; cursor <= toKey; cursor = nextDateKey(cursor)) {
        count += 1;
        if (count > 366) break;
    }
    return count;
}

function dateKeysInRange(fromKey, toKey) {
    const keys = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey) || toKey < fromKey) {
        return keys;
    }
    for (let cursor = fromKey; cursor <= toKey; cursor = nextDateKey(cursor)) {
        keys.push(cursor);
        if (keys.length > 366) break;
    }
    return keys;
}

function employeeDisplayName(emp) {
    return [emp?.firstName, emp?.lastName].filter(Boolean).join(' ').trim();
}

const LEAVE_APPLY_SPECS = {
    annual: {
        kind: 'future_annual',
        requestedStatusKey: 'on_leave',
        requestedStatusLabel: 'Annual Leave',
        leaveType: 'annual',
    },
    authorized: {
        kind: 'future_leave',
        requestedStatusKey: 'authorized_leave',
        requestedStatusLabel: 'Authorized Leave',
        leaveType: 'authorized',
    },
    unauthorized: {
        kind: 'leave',
        requestedStatusKey: 'unauthorized_leave',
        requestedStatusLabel: 'Unauthorized Leave',
        leaveType: 'unauthorized',
    },
    sick: {
        kind: 'leave',
        requestedStatusKey: 'sick_leave',
        requestedStatusLabel: 'Sick Leave',
        leaveType: 'sick',
    },
    compoff: {
        kind: 'leave',
        requestedStatusKey: 'compoff_leave',
        requestedStatusLabel: 'Comp Off Leave',
        leaveType: 'compoff',
    },
};

function resolveLeaveApplySpec(leaveType, dayCount) {
    const raw = String(leaveType || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    const aliases = {
        annual: 'annual',
        on_leave: 'annual',
        authorized: 'authorized',
        authorize: 'authorized',
        authorized_leave: 'authorized',
        unauthorized: 'unauthorized',
        unauthorized_leave: 'unauthorized',
        sick: 'sick',
        sick_leave: 'sick',
        compoff: 'compoff',
        comp_off: 'compoff',
        compoff_leave: 'compoff',
    };
    const mapped = aliases[raw];
    if (mapped && LEAVE_APPLY_SPECS[mapped]) return LEAVE_APPLY_SPECS[mapped];
    return dayCount < 5 ? LEAVE_APPLY_SPECS.authorized : LEAVE_APPLY_SPECS.annual;
}

async function findLeaveApplyConflict(employeeMongoId, from, to, excludeGroupId = '', excludeRecordIds = []) {
    const rows = await Attendance.find({
        employeeMongoId: String(employeeMongoId),
        date: { $gte: from, $lte: to },
    })
        .lean()
        .maxTimeMS(12000);

    const excludeIds = new Set((excludeRecordIds || []).map((id) => String(id)));

    for (const row of rows || []) {
        if (excludeIds.has(String(row._id))) continue;
        if (excludeGroupId && String(row.leaveRequestGroupId || '') === String(excludeGroupId)) {
            continue;
        }
        if (
            row.leaveRequestStatus === 'pending' &&
            PENDING_LEAVE_KINDS.includes(String(row.leaveRequestKind || ''))
        ) {
            return `A leave request is already pending for ${row.date}.`;
        }
        if (
            (row.leaveRequestStatus === 'approved' || row.approvalStatus === 'approved') &&
            LEAVE_TRACK_KEYS.includes(String(row.statusKey || ''))
        ) {
            return `${row.date} already has approved leave.`;
        }
    }
    return '';
}

async function revertLeaveAttendanceRecord(record) {
    if (!record) return;

    const requestStatus = String(record.leaveRequestStatus || '').trim();
    const statusKey = String(record.statusKey || '').trim();
    const isTrackedLeave = LEAVE_TRACK_KEYS.includes(statusKey);
    if (requestStatus !== 'pending' && requestStatus !== 'approved' && !isTrackedLeave) {
        return;
    }

    const prevKey = String(record.previousStatusKey || 'not_marked');
    const hadNoClock = !String(record.timeIn || '').trim();
    if (hadNoClock && (!prevKey || prevKey === 'not_marked')) {
        await Attendance.deleteOne({ _id: record._id });
        return;
    }

    record.statusKey = prevKey || 'not_marked';
    record.statusLabel =
        record.previousStatusLabel || (prevKey === 'not_marked' ? 'Upcoming' : record.statusLabel);
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
    record.leaveRequestTimeIn = '';
    record.leaveRequestTimeOut = '';
    record.approvalStatus = '';
    record.leavePayType = '';
    await record.save();
}

async function revertPendingAttendanceRecord(record) {
    await revertLeaveAttendanceRecord(record);
}

async function writePendingLeaveDay({
    dateKey,
    employee,
    spec,
    from,
    to,
    groupId,
    requestedAt,
    markedBy,
    reason,
}) {
    const employeeName = employeeDisplayName(employee) || 'Employee';
    let record = await Attendance.findOne({
        date: dateKey,
        employeeMongoId: String(employee._id),
    });

    if (!record) {
        record = new Attendance({
            date: dateKey,
            employeeMongoId: String(employee._id),
            employeeId: employee.employeeId || '',
            employeeName,
            statusKey: 'not_marked',
            statusLabel: 'Upcoming',
        });
    }

    const sameGroup = Boolean(groupId) && String(record.leaveRequestGroupId || '') === String(groupId);
    if (!sameGroup) {
        record.previousStatusKey = record.statusKey || 'not_marked';
        record.previousStatusLabel = record.statusLabel || 'Upcoming';
    }

    record.employeeId = employee.employeeId || record.employeeId || '';
    record.employeeName = employeeName;
    record.requestedStatusKey = spec.requestedStatusKey;
    record.requestedStatusLabel = spec.requestedStatusLabel;
    record.leaveRequestKind = spec.kind;
    record.leaveRequestStatus = 'pending';
    record.leaveRequestDayPart = 'full';
    record.leaveRequestTimeIn = '';
    record.leaveRequestTimeOut = '';
    record.leaveRequestFromDate = from;
    record.leaveRequestToDate = to;
    record.leaveRequestGroupId = groupId;
    record.leaveRequestedAt = requestedAt;
    record.leaveDecidedAt = null;
    record.leaveDecidedBy = null;
    record.leaveRequestReason = reason;
    record.approvalStatus = '';
    record.leavePayType = '';
    record.markedBy = markedBy;
    await record.save();
    return record;
}

async function loadEditableLeaveGroup(attendanceId) {
    if (!attendanceId || !mongoose.Types.ObjectId.isValid(attendanceId)) return null;

    const seed = await Attendance.findById(attendanceId);
    if (!seed) return null;

    const groupId = String(seed.leaveRequestGroupId || '').trim();
    if (groupId) {
        const records = await Attendance.find({
            leaveRequestGroupId: groupId,
            employeeMongoId: seed.employeeMongoId,
        }).sort({ date: 1 });
        return { groupId, records: records.length ? records : [seed] };
    }

    const from = seed.leaveRequestFromDate || seed.date;
    const to = seed.leaveRequestToDate || seed.date;
    const statusKey = String(seed.requestedStatusKey || seed.statusKey || '').trim();
    const records = await Attendance.find({
        employeeMongoId: seed.employeeMongoId,
        date: { $gte: from, $lte: to },
        $or: [
            { _id: seed._id },
            { leaveRequestStatus: { $in: ['pending', 'approved', 'rejected'] } },
            ...(statusKey ? [{ statusKey }] : []),
        ],
    }).sort({ date: 1 });

    return { groupId: '', records: records.length ? records : [seed] };
}

async function loadPendingLeaveGroup(attendanceId) {
    const group = await loadEditableLeaveGroup(attendanceId);
    if (!group) return null;
    const pending = (group.records || []).filter(
        (row) => String(row.leaveRequestStatus || '') === 'pending',
    );
    if (!pending.length) return null;
    return { ...group, records: pending };
}

async function markLeaveRecordsRejected(records, actor) {
    for (const record of records || []) {
        const prevKey = String(record.previousStatusKey || 'not_marked');
        const hadNoClock = !String(record.timeIn || '').trim();
        if (hadNoClock && (!prevKey || prevKey === 'not_marked')) {
            record.statusKey = 'not_marked';
            record.statusLabel = 'Upcoming';
        } else {
            record.statusKey = prevKey || record.statusKey;
            record.statusLabel = record.previousStatusLabel || record.statusLabel;
        }
        record.leaveRequestStatus = 'rejected';
        record.leaveDecidedAt = new Date();
        record.leaveDecidedBy = actor?._id || null;
        record.approvalStatus = '';
        await record.save();
    }
}

/**
 * POST /api/Leave/apply
 * Create a pending leave request, or update + approve an existing pending request.
 * Body: { employeeId, from, to, leaveType?, leavePayType?, attendanceId?, approve? }
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
        const attendanceId = String(req.body?.attendanceId || req.body?.approvalId || '').trim();
        const shouldApprove =
            req.body?.approve === true ||
            String(req.body?.approve || '').trim().toLowerCase() === 'true';
        const shouldReject =
            req.body?.reject === true ||
            String(req.body?.reject || '').trim().toLowerCase() === 'true';
        const hrFlags = await resolveLeaveHrFlags(req);

        if (shouldReject) {
            if (!attendanceId) {
                return res.status(400).json({ message: 'attendanceId is required to reject leave.' });
            }
            if (!hrFlags.canEdit) {
                return res.status(403).json({ message: 'Only HR can reject leave from this form.' });
            }

            const existingGroup = await loadEditableLeaveGroup(attendanceId);
            if (!existingGroup?.records?.length) {
                return res.status(400).json({ message: 'No leave request found to reject.' });
            }

            const actor = await resolveActorEmployee(req);
            if (!actor) {
                return res.status(404).json({ message: 'No linked employee profile found for this user.' });
            }

            const pendingSeed = existingGroup.records.find(
                (row) => String(row.leaveRequestStatus || '') === 'pending',
            );
            if (pendingSeed) {
                const result = await decideLeaveRequestInternal({
                    attendanceId: String(pendingSeed._id),
                    decision: 'rejected',
                    actor,
                    hrBypass: hrFlags.isHr,
                });
                if (!result.ok) {
                    return res.status(result.status || 400).json({ message: result.message });
                }
            } else {
                await markLeaveRecordsRejected(existingGroup.records, actor);
                const seed = existingGroup.records[0];
                await syncDashboardAction({
                    requestId: leaveDashboardRequestObjectId(seed.leaveRequestGroupId, seed._id),
                    requestType: LEAVE_DASHBOARD_REQUEST_TYPE,
                    assignedTo: actor._id,
                    status: 'Rejected',
                    subjectEmployee: {
                        _id: seed.employeeMongoId,
                        employeeId: seed.employeeId,
                        firstName: seed.employeeName,
                    },
                    actionedBy: actor._id,
                    extra1: seed.date,
                    extra2: seed.requestedStatusLabel || seed.statusLabel || 'Leave',
                });
            }

            return res.status(200).json({
                message: 'Leave request rejected.',
                leaveRequestStatus: 'rejected',
                attendanceId,
            });
        }

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
            .select(
                '_id employeeId firstName lastName status profileStatus companyEmail workEmail email primaryReportee',
            )
            .populate(
                'primaryReportee',
                'firstName lastName employeeId companyEmail workEmail email',
            )
            .lean();

        if (!employee || isCompanyShellEmployee(employee)) {
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const visibility = await loadEnrolledLeaveVisibilityByMongoId([employee]);
        const processingStart = visibility.get(String(employee._id)) || '';
        if (processingStart && from < processingStart) {
            return res.status(400).json({
                message: `Leave cannot start before this employee's salary processing date (${processingStart}).`,
            });
        }

        const dayCount = countInclusiveDays(from, to);
        if (dayCount < 1) {
            return res.status(400).json({ message: 'Selected date range is empty.' });
        }

        const spec = resolveLeaveApplySpec(req.body?.leaveType || req.body?.leaveMode, dayCount);
        const existingGroup = attendanceId ? await loadEditableLeaveGroup(attendanceId) : null;
        if (attendanceId && !existingGroup) {
            return res.status(400).json({ message: 'No leave request found to update.' });
        }

        const existingIsSettled = Boolean(
            existingGroup?.records?.some((row) =>
                ['approved', 'rejected'].includes(String(row.leaveRequestStatus || '')),
            ) ||
                existingGroup?.records?.some((row) =>
                    LEAVE_TRACK_KEYS.includes(String(row.statusKey || '')),
                ),
        );
        if (existingGroup && existingIsSettled && !hrFlags.canEdit) {
            return res.status(403).json({ message: 'Only HR can edit completed leave.' });
        }

        const excludeGroupId = existingGroup?.groupId || '';
        const excludeRecordIds = (existingGroup?.records || []).map((row) => String(row._id));
        const conflict = await findLeaveApplyConflict(
            String(employee._id),
            from,
            to,
            excludeGroupId,
            excludeRecordIds,
        );
        if (conflict) {
            return res.status(400).json({ message: conflict });
        }

        if (existingGroup?.records?.length) {
            const previousEmployeeId = String(existingGroup.records[0].employeeMongoId || '');
            const employeeChanged = previousEmployeeId !== String(employee._id);
            const nextDateSet = new Set(dateKeysInRange(from, to));

            for (const record of existingGroup.records) {
                if (employeeChanged || !nextDateSet.has(record.date)) {
                    await revertLeaveAttendanceRecord(record);
                }
            }
        }

        const groupId =
            existingGroup?.groupId &&
            String(existingGroup.records?.[0]?.employeeMongoId || '') === String(employee._id)
                ? existingGroup.groupId
                : new mongoose.Types.ObjectId().toString();
        const markedBy = req.user?.id || null;
        const requestedAt = new Date();
        const reason = `${spec.requestedStatusLabel} request (${dayCount} day${dayCount === 1 ? '' : 's'})`;
        const saved = [];

        for (const dateKey of dateKeysInRange(from, to)) {
            const record = await writePendingLeaveDay({
                dateKey,
                employee,
                spec,
                from,
                to,
                groupId,
                requestedAt,
                markedBy,
                reason,
            });
            saved.push(record);
        }

        if (!shouldApprove) {
            const approvalAttendanceId = saved.reduce((min, row) => {
                const id = String(row?._id || '');
                return !min || (id && id < min) ? id : min;
            }, '');
            try {
                await notifyPrimaryReporteeOfLeaveRequest({
                    employee,
                    manager: employee.primaryReportee,
                    from,
                    to,
                    attendanceId: approvalAttendanceId || saved[0]?._id,
                    groupId,
                    requestedLabel: spec.requestedStatusLabel,
                    requestedStatusKey: spec.requestedStatusKey,
                    leaveRequestKind: spec.kind,
                    reason,
                });
            } catch (notifyError) {
                console.warn('[applyLeaveRange] leave notify failed:', notifyError?.message || notifyError);
            }

            return res.status(200).json({
                message: `${spec.requestedStatusLabel} request submitted for ${dayCount} day${
                    dayCount === 1 ? '' : 's'
                }. Status is Pending.`,
                from,
                to,
                dayCount,
                statusKey: spec.requestedStatusKey,
                statusLabel: spec.requestedStatusLabel,
                leaveType: spec.leaveType,
                leaveRequestStatus: 'pending',
                attendanceId: saved[0] ? String(saved[0]._id) : '',
                count: saved.length,
                records: saved.map((row) => ({
                    id: String(row._id),
                    date: row.date,
                    statusKey: row.requestedStatusKey,
                    statusLabel: row.requestedStatusLabel,
                    leaveRequestStatus: row.leaveRequestStatus,
                })),
            });
        }

        const actor = await resolveActorEmployee(req);
        if (!actor) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const result = await decideLeaveRequestInternal({
            attendanceId: String(saved[0]._id),
            decision: 'approved',
            approvedStatusKey: spec.requestedStatusKey,
            leavePayType,
            actor,
            hrBypass: hrFlags.isHr,
        });

        if (!result.ok) {
            return res.status(result.status || 400).json({ message: result.message });
        }

        return res.status(200).json({
            message: `${spec.requestedStatusLabel} approved for ${dayCount} day${
                dayCount === 1 ? '' : 's'
            }.`,
            from,
            to,
            dayCount,
            statusKey: spec.requestedStatusKey,
            statusLabel: spec.requestedStatusLabel,
            leaveType: spec.leaveType,
            leaveRequestStatus: 'approved',
            attendanceId: String(saved[0]._id),
            count: saved.length,
            record: result.record,
        });
    } catch (error) {
        console.error('[applyLeaveRange]', error);
        return res.status(500).json({
            message: error.message || 'Failed to apply leave.',
        });
    }
}

/**
 * GET /api/Leave/team-track?year=YYYY|all
 * Leave-day totals for the team (approved leave marks).
 * year=all: rolling 12 months ending at the current month (e.g. Sep 2025–Aug 2026).
 * year=YYYY: January–December of that year.
 */
export async function getLeaveTeamTrack(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
        const yearRaw = String(req.query.year || '').trim().toLowerCase();
        const isAll = yearRaw === 'all';
        const requestedYear = Number(req.query.year);
        const year = isAll
            ? 'all'
            : Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
              ? requestedYear
              : dubai.year;

        const [activeEmployees, locationRows] = await Promise.all([
            EmployeeBasic.find({
                profileStatus: 'active',
                status: { $ne: 'Left User' },
                employeeId: { $ne: 'VEGA-HR-0000' },
                ...REAL_EMPLOYEE_MONGO_FILTER,
            })
                .select('_id employeeId staffType')
                .lean()
                .maxTimeMS(12000),
            listActiveWorkLocations(),
        ]);

        const realEmployees = (activeEmployees || []).filter((row) => !isCompanyShellEmployee(row));
        const visibility = await loadEnrolledLeaveVisibilityByMongoId(realEmployees);
        const visibilityByCode = leaveVisibilityByEmployeeId(realEmployees, visibility);
        const locationByMongoId = new Map();
        const locationByCode = new Map();
        for (const emp of realEmployees) {
            const loc = normalizeStaffTypeKey(emp.staffType);
            locationByMongoId.set(String(emp._id), loc);
            const code = String(emp.employeeId || '').trim();
            if (code) locationByCode.set(code, loc);
        }
        const catalog = (locationRows || []).length
            ? locationRows
            : [
                  { key: 'office', label: 'Office' },
                  { key: 'site', label: 'Site' },
              ];
        const locationLabel = new Map(catalog.map((row) => [row.key, row.label || row.key]));
        const employeeIds = realEmployees
            .map((row) => String(row._id))
            .filter((id) => visibility.has(id));
        const enrolledCodes = realEmployees
            .filter((row) => visibility.has(String(row._id)))
            .map((row) => String(row.employeeId || '').trim())
            .filter(Boolean);

        const rolling = isAll ? rollingTrackWindow(dubai) : null;
        const from = isAll ? rolling.from : `${year}-01-01`;
        const to = isAll ? rolling.to : `${year}-12-31`;

        const leaveRows =
            employeeIds.length === 0
                ? []
                : await Attendance.find({
                      $or: [
                          { employeeMongoId: { $in: employeeIds } },
                          ...(enrolledCodes.length ? [{ employeeId: { $in: enrolledCodes } }] : []),
                      ],
                      date: { $gte: from, $lte: to },
                      statusKey: { $in: trackStatusKeysForLeaveType(req.query.leaveType) },
                  })
                      .select('employeeMongoId employeeId date statusKey')
                      .lean()
                      .maxTimeMS(12000);

        const totalsByPeriod = new Map();
        const groupsByPeriod = new Map();
        for (const row of leaveRows || []) {
            const dateKey = String(row?.date || '');
            const statusKey = String(row?.statusKey || '');
            if (!dateKey || !statusKey) continue;
            if (
                !isEmployeeLeaveDateVisible(row.employeeMongoId, dateKey, visibility) &&
                !isLeaveEntryVisible({ ...row, date: dateKey }, visibility, visibilityByCode)
            ) {
                continue;
            }
            const monthKey = dateKey.slice(0, 7);
            const processingStart =
                visibility.get(String(row.employeeMongoId || '')) ||
                visibilityByCode.get(String(row.employeeId || '').trim());
            if (processingStart && String(processingStart).slice(0, 7) > monthKey) continue;
            const periodKey = monthKey;
            if (!totalsByPeriod.has(periodKey)) totalsByPeriod.set(periodKey, {});
            const periodCounts = totalsByPeriod.get(periodKey);
            periodCounts[statusKey] = (periodCounts[statusKey] || 0) + 1;
            const locKey =
                locationByMongoId.get(String(row.employeeMongoId || '')) ||
                locationByCode.get(String(row.employeeId || '').trim()) ||
                'office';
            if (!groupsByPeriod.has(periodKey)) groupsByPeriod.set(periodKey, new Map());
            const locCounts = groupsByPeriod.get(periodKey);
            locCounts.set(locKey, (locCounts.get(locKey) || 0) + 1);
        }

        const periodRows = isAll
            ? monthPeriodRows(rolling.startYear, rolling.startMonth, rolling.endYear, rolling.endMonth)
            : MONTH_LABELS.map((label, index) => ({
                  label,
                  periodKey: `${year}-${String(index + 1).padStart(2, '0')}`,
              }));
        const months = periodRows.map((period) =>
            teamTrackPeriodRow({
                label: period.label,
                periodKey: period.periodKey,
                monthCounts: totalsByPeriod.get(period.periodKey) || {},
                locCounts: groupsByPeriod.get(period.periodKey) || new Map(),
                catalog,
                locationLabel,
            }),
        );

        return res.status(200).json({
            message: 'Leave team track fetched successfully',
            year,
            from,
            to,
            bucket: 'month',
            rangeLabel: isAll ? rolling.rangeLabel : String(year),
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
