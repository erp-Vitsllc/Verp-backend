import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../utils/attendanceEmployeeFilters.js';
import {
    isLeaveEntryVisible,
    leaveVisibilityByEmployeeId,
    loadEnrolledLeaveVisibilityByMongoId,
} from '../utils/leaveSalaryVisibility.js';
import {
    addOverlayCountsForEmployees,
    isHistoricalLeaveEntry,
    loadHistoricalLeaveProfilesByEmployeeId,
    overlayAttendanceRowsForEmployee,
} from '../utils/historicalLeaveAttendanceOverlay.js';
import {
    getScheduledEmailTimeZone,
    getZonedParts,
} from '../utils/scheduleDailyAtMidnight.js';

const LEAVE_COUNT_KEYS = [
    'authorized_leave',
    'unauthorized_leave',
    'sick_leave',
    'compoff_leave',
    'on_leave',
];

/** Personal leave only — holidays are company-wide, not per-user calendar bars. */
const LEAVE_CALENDAR_KEYS = [...LEAVE_COUNT_KEYS];

function calendarStatusKeysForLeaveType(leaveType) {
    const raw = String(leaveType || 'all').trim().toLowerCase();
    if (!raw || raw === 'all') return LEAVE_CALENDAR_KEYS;
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
    return key ? [key] : LEAVE_CALENDAR_KEYS;
}

function employeeDisplayName(emp) {
    return [emp?.firstName, emp?.lastName].filter(Boolean).join(' ').trim();
}

function isValidDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function earliestProcessingStart(visibility, fallbackDate) {
    let earliest = '';
    for (const start of visibility?.values?.() || []) {
        if (!isValidDateKey(start)) continue;
        if (!earliest || start < earliest) earliest = start;
    }
    return earliest || fallbackDate;
}

/**
 * GET /api/Leave/employees
 * Active employees with leave day counts from attendance.
 * Query: year=all | year=YYYY | from?&to? (yyyy-MM-dd)
 */
export async function getEmployeeLeaveDirectory(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
        const queryFrom = String(req.query.from || '').trim();
        const queryTo = String(req.query.to || '').trim();
        const yearRaw = String(req.query.year || '').trim().toLowerCase();
        const requestedYear = Number(req.query.year);

        const rows = await EmployeeBasic.find({
            profileStatus: 'active',
            status: { $ne: 'Left User' },
            employeeId: { $ne: 'VEGA-HR-0000' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('_id employeeId firstName lastName staffType dateOfJoining')
            .sort({ firstName: 1, lastName: 1 })
            .lean()
            .maxTimeMS(12000);

        const activeEmployees = (rows || []).filter((e) => !isCompanyShellEmployee(e));
        const visibility = await loadEnrolledLeaveVisibilityByMongoId(activeEmployees);
        const visibilityByCode = leaveVisibilityByEmployeeId(activeEmployees, visibility);
        const employees = activeEmployees.filter((emp) => visibility.has(String(emp._id)));
        const mongoIds = employees.map((e) => String(e._id));
        const enrolledCodes = employees.map((e) => String(e.employeeId || '').trim()).filter(Boolean);

        let from;
        let to;
        let year;

        if (isValidDateKey(queryFrom) && isValidDateKey(queryTo) && queryFrom <= queryTo) {
            from = queryFrom;
            to = queryTo;
            year = Number(from.slice(0, 4));
        } else if (yearRaw === 'all') {
            from = earliestProcessingStart(visibility, `${dubai.year}-01-01`);
            to = `${dubai.year}-12-31`;
            year = 'all';
        } else {
            year =
                Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
                    ? requestedYear
                    : dubai.year;
            from = `${year}-01-01`;
            to = `${year}-12-31`;
        }

        const leaveRows =
            mongoIds.length === 0
                ? []
                : await Attendance.find({
                      $or: [
                          { employeeMongoId: { $in: mongoIds } },
                          ...(enrolledCodes.length ? [{ employeeId: { $in: enrolledCodes } }] : []),
                      ],
                      date: { $gte: from, $lte: to },
                      statusKey: { $in: LEAVE_COUNT_KEYS },
                  })
                      .select('employeeMongoId employeeId date statusKey')
                      .lean()
                      .maxTimeMS(12000);

        const mongoByCode = new Map(
            employees.map((emp) => [String(emp.employeeId || '').trim(), String(emp._id)]),
        );
        const countsByEmp = {};
        for (const row of leaveRows || []) {
            const key = String(row?.statusKey || '').trim();
            if (!LEAVE_COUNT_KEYS.includes(key)) continue;
            if (!isLeaveEntryVisible(row, visibility, visibilityByCode)) continue;
            const id =
                (visibility.has(String(row.employeeMongoId || ''))
                    ? String(row.employeeMongoId)
                    : '') ||
                mongoByCode.get(String(row.employeeId || '').trim()) ||
                '';
            if (!id) continue;
            if (!countsByEmp[id]) countsByEmp[id] = {};
            countsByEmp[id][key] = (countsByEmp[id][key] || 0) + 1;
        }

        const historicalProfiles = await loadHistoricalLeaveProfilesByEmployeeId(enrolledCodes);
        addOverlayCountsForEmployees({
            profilesByCode: historicalProfiles,
            employees,
            from: yearRaw === 'all' ? '' : from,
            to,
            countsByEmp,
        });

        const list = employees.map((emp) => {
            const counts = countsByEmp[String(emp._id)] || {};
            const staffType =
                String(emp.staffType || '').trim().toLowerCase() || 'office';
            let dateOfJoining = '';
            if (emp.dateOfJoining) {
                const join = new Date(emp.dateOfJoining);
                if (!Number.isNaN(join.getTime())) {
                    const y = join.getFullYear();
                    const m = String(join.getMonth() + 1).padStart(2, '0');
                    const d = String(join.getDate()).padStart(2, '0');
                    dateOfJoining = `${y}-${m}-${d}`;
                }
            }
            return {
                _id: String(emp._id),
                employeeId: emp.employeeId || '',
                employeeName: employeeDisplayName(emp),
                staffType,
                dateOfJoining,
                authorizedLeave: counts.authorized_leave || 0,
                unauthorizedLeave: counts.unauthorized_leave || 0,
                sickLeave: counts.sick_leave || 0,
                compoffLeave: counts.compoff_leave || 0,
                annualLeaveTaken: counts.on_leave || 0,
            };
        });

        return res.status(200).json({
            message: 'Employee leave directory fetched successfully',
            year,
            from,
            to,
            count: list.length,
            employees: list,
        });
    } catch (error) {
        console.error('[getEmployeeLeaveDirectory]', error);
        return res.status(500).json({
            message: error.message || 'Failed to fetch employee leave directory.',
        });
    }
}

/**
 * GET /api/Leave/calendar?from=yyyy-MM-dd&to=yyyy-MM-dd&employeeId=<mongoId optional>
 * Team leave calendar — all employees with leave marks in range.
 */
export async function getLeaveCalendar(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const from = String(req.query.from || '').trim();
        const to = String(req.query.to || '').trim();
        const employeeMongoId = String(req.query.employeeId || '').trim();
        const leaveType = String(req.query.leaveType || 'all').trim().toLowerCase();

        const statusKeys = calendarStatusKeysForLeaveType(leaveType);

        if (!isValidDateKey(from) || !isValidDateKey(to) || from > to) {
            return res.status(400).json({ message: 'Valid from and to dates (yyyy-MM-dd) are required.' });
        }

        const activeEmployees = await EmployeeBasic.find({
            profileStatus: 'active',
            status: { $ne: 'Left User' },
            employeeId: { $ne: 'VEGA-HR-0000' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('_id employeeId firstName lastName')
            .lean()
            .maxTimeMS(12000);

        const realEmployees = (activeEmployees || []).filter((row) => !isCompanyShellEmployee(row));
        const visibility = await loadEnrolledLeaveVisibilityByMongoId(realEmployees);
        const visibilityByCode = leaveVisibilityByEmployeeId(realEmployees, visibility);

        const employeeMap = new Map();
        const employeeByCode = new Map();
        for (const emp of realEmployees) {
            const mongoId = String(emp._id);
            if (!visibility.has(mongoId)) continue;
            if (employeeMongoId && mongoId !== employeeMongoId && String(emp.employeeId || '') !== employeeMongoId) {
                continue;
            }
            employeeMap.set(mongoId, emp);
            const code = String(emp.employeeId || '').trim();
            if (code) employeeByCode.set(code, emp);
        }

        if (!employeeMap.size) {
            return res.status(200).json({
                message: 'Leave calendar fetched successfully',
                from,
                to,
                leaveType,
                focusEmployee: null,
                count: 0,
                entries: [],
            });
        }

        const enrolledMongoIds = Array.from(employeeMap.keys());
        const enrolledCodes = Array.from(employeeByCode.keys());
        const partyFilter = {
            $or: [
                { employeeMongoId: { $in: enrolledMongoIds } },
                ...(enrolledCodes.length ? [{ employeeId: { $in: enrolledCodes } }] : []),
            ],
        };

        const query = {
            date: { $gte: from, $lte: to },
            statusKey: { $in: statusKeys },
            ...partyFilter,
        };

        const records = await Attendance.find(query)
            .sort({ date: 1, employeeName: 1 })
            .lean()
            .maxTimeMS(12000);

        const pendingRecords = await Attendance.find({
            leaveRequestStatus: 'pending',
            leaveRequestKind: { $in: ['leave', 'future_leave', 'future_annual'] },
            employeeName: { $not: /\(company\)\s*$/i },
            $and: [
                partyFilter,
                {
                    $or: [
                        { date: { $gte: from, $lte: to } },
                        {
                            leaveRequestFromDate: { $lte: to },
                            leaveRequestToDate: { $gte: from },
                        },
                    ],
                },
            ],
        })
            .sort({ date: 1, employeeName: 1 })
            .lean()
            .maxTimeMS(12000);

        const resolveEmp = (row) =>
            employeeMap.get(String(row.employeeMongoId || '')) ||
            employeeByCode.get(String(row.employeeId || '').trim()) ||
            null;

        const approvedEntries = (records || [])
            .map((row) => {
                const emp = resolveEmp(row);
                if (!emp) return null;
                return {
                    id: String(row._id || `${row.date}-${row.employeeMongoId}-${row.statusKey}`),
                    date: row.date,
                    employeeMongoId: String(emp._id),
                    employeeId: row.employeeId || emp.employeeId || '',
                    employeeName: row.employeeName || employeeDisplayName(emp),
                    statusKey: row.statusKey,
                    statusLabel: row.statusLabel || row.statusKey,
                    isPending: false,
                };
            })
            .filter(Boolean);

        const historicalProfiles = await loadHistoricalLeaveProfilesByEmployeeId(enrolledCodes);
        const occupiedLeaveDays = new Set(
            approvedEntries.map((row) => `${row.employeeMongoId}|${row.date}`),
        );
        const statusKeySet = new Set(statusKeys);
        for (const emp of employeeMap.values()) {
            const overlayRows = overlayAttendanceRowsForEmployee({
                profile: historicalProfiles.get(String(emp.employeeId || '').trim()),
                employee: emp,
                from,
                to,
                statusKeys: statusKeySet,
            });
            for (const row of overlayRows) {
                const occupiedKey = `${row.employeeMongoId}|${row.date}`;
                if (occupiedLeaveDays.has(occupiedKey)) continue;
                occupiedLeaveDays.add(occupiedKey);
                approvedEntries.push({
                    id: String(row._id || `${row.date}-${row.employeeMongoId}-${row.statusKey}`),
                    date: row.date,
                    employeeMongoId: row.employeeMongoId,
                    employeeId: row.employeeId,
                    employeeName: row.employeeName || employeeDisplayName(emp),
                    statusKey: row.statusKey,
                    statusLabel: row.statusLabel || row.statusKey,
                    isPending: false,
                    historical: true,
                    source: 'Salary enrollment',
                    leaveRequestKind: 'historical',
                });
            }
        }

        const pendingKeys = new Set();
        const pendingEntries = [];

        for (const row of pendingRecords || []) {
            const emp = resolveEmp(row);
            if (!emp) continue;

            const rangeStart = row.leaveRequestFromDate || row.date;
            const rangeEnd = row.leaveRequestToDate || row.date;
            let cursor = rangeStart > from ? rangeStart : from;
            const endKey = rangeEnd < to ? rangeEnd : to;

            while (cursor && cursor <= endKey) {
                const dedupeKey = `${emp._id}-${cursor}-pending`;
                if (!pendingKeys.has(dedupeKey)) {
                    pendingKeys.add(dedupeKey);
                    pendingEntries.push({
                        id: String(row._id || `${cursor}-${emp._id}-pending`),
                        attendanceId: String(row._id || ''),
                        leaveRequestGroupId: String(row.leaveRequestGroupId || row._id || ''),
                        date: cursor,
                        rangeStart,
                        rangeEnd,
                        employeeMongoId: String(emp._id),
                        employeeId: row.employeeId || emp.employeeId || '',
                        employeeName: row.employeeName || employeeDisplayName(emp),
                        statusKey: String(row.requestedStatusKey || 'on_leave'),
                        statusLabel: row.requestedStatusLabel || row.requestedStatusKey || 'Pending Leave',
                        isPending: true,
                    });
                }

                if (cursor === endKey) break;
                const [year, month, day] = cursor.split('-').map(Number);
                const next = new Date(year, month - 1, day + 1);
                cursor = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
            }
        }

        const entries = [...approvedEntries, ...pendingEntries]
            .filter(
                (entry) =>
                    isHistoricalLeaveEntry(entry) ||
                    isLeaveEntryVisible(entry, visibility, visibilityByCode),
            )
            .sort(
                (a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName),
            );

        const focusEmployee = employeeMongoId ? employeeMap.get(employeeMongoId) : null;

        return res.status(200).json({
            message: 'Leave calendar fetched successfully',
            from,
            to,
            leaveType,
            focusEmployee: focusEmployee
                ? {
                      _id: String(focusEmployee._id),
                      employeeId: focusEmployee.employeeId || '',
                      employeeName: employeeDisplayName(focusEmployee),
                  }
                : null,
            count: entries.length,
            entries,
        });
    } catch (error) {
        console.error('[getLeaveCalendar]', error);
        return res.status(500).json({
            message: error.message || 'Failed to fetch leave calendar.',
        });
    }
}

/**
 * GET /api/Leave/salary-visibility
 * Enrolled employees and their live salary start dates (for Leave UI filters).
 */
export async function getLeaveSalaryVisibility(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const rows = await EmployeeBasic.find({
            profileStatus: 'active',
            status: { $ne: 'Left User' },
            employeeId: { $ne: 'VEGA-HR-0000' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('_id employeeId')
            .lean()
            .maxTimeMS(12000);

        const employees = (rows || []).filter((row) => !isCompanyShellEmployee(row));
        const visibility = await loadEnrolledLeaveVisibilityByMongoId(employees);
        const items = employees
            .filter((emp) => visibility.has(String(emp._id)))
            .map((emp) => ({
                employeeMongoId: String(emp._id),
                employeeId: String(emp.employeeId || '').trim(),
                processingStartDate: visibility.get(String(emp._id)) || '',
            }));

        const earliestProcessingStartDate = earliestProcessingStart(visibility, '');
        const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());

        return res.status(200).json({
            message: 'Leave salary visibility fetched successfully',
            count: items.length,
            items,
            earliestProcessingStartDate,
            yearFrom: earliestProcessingStartDate
                ? Number(earliestProcessingStartDate.slice(0, 4))
                : dubai.year,
            yearTo: dubai.year,
        });
    } catch (error) {
        console.error('[getLeaveSalaryVisibility]', error);
        return res.status(500).json({
            message: error.message || 'Failed to fetch leave salary visibility.',
        });
    }
}
