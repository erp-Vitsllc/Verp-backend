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
    overlayHistoricalLeave,
} from '../utils/historicalLeaveAttendanceOverlay.js';
import {
    getScheduledEmailTimeZone,
    getZonedParts,
} from '../utils/scheduleDailyAtMidnight.js';
import { listActiveWorkLocations, normalizeStaffTypeKey } from '../utils/workLocationHelpers.js';

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

function nextCalendarDateKey(dateKey) {
    if (!isValidDateKey(dateKey)) return '';
    const [year, month, day] = dateKey.split('-').map(Number);
    const next = new Date(year, month - 1, day + 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

function eachCalendarDateKeys(from, to) {
    if (!isValidDateKey(from) || !isValidDateKey(to) || from > to) return [];
    const keys = [];
    let cursor = from;
    while (cursor && cursor <= to) {
        keys.push(cursor);
        if (cursor === to) break;
        cursor = nextCalendarDateKey(cursor);
    }
    return keys;
}

function dubaiTodayDateKey() {
    const parts = getZonedParts(new Date(), getScheduledEmailTimeZone());
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

const WORKED_ATTENDANCE_KEYS = new Set([
    'on_office',
    'work_from_home',
    'late_arrived',
    'early_go',
    'mispunch',
]);

function attendanceHasPunch(row) {
    return Boolean(String(row?.timeIn || '').trim() || String(row?.timeOut || '').trim());
}

function attendanceDayWasWorked(row) {
    if (!row) return false;
    if (attendanceHasPunch(row)) return true;
    return WORKED_ATTENDANCE_KEYS.has(String(row.statusKey || '').trim());
}

function clipRangeToYear(start, end, yearFrom, yearTo) {
    const from = start > yearFrom ? start : yearFrom;
    const to = end < yearTo ? end : yearTo;
    if (!isValidDateKey(from) || !isValidDateKey(to) || from > to) return null;
    return { start: from, end: to };
}

function clipLeaveSpanToVisiblePeriod(start, end, processingStart) {
    if (!isValidDateKey(start) || !isValidDateKey(end) || !isValidDateKey(processingStart)) return null;
    const nextStart = start >= processingStart ? start : processingStart;
    if (nextStart > end) return null;
    return { start: nextStart, end };
}

function pushConsecutiveDateSpans(target, { employee, dates, pending = false, extra = {} }) {
    const list = dates instanceof Set ? [...dates] : Array.isArray(dates) ? dates : [];
    const sorted = [...new Set(list.filter(isValidDateKey))].sort();
    if (!sorted.length) return;

    let rangeStart = sorted[0];
    let previous = sorted[0];

    const pushSpan = (start, end) => {
        target.push({
            employeeMongoId: String(employee._id),
            employeeId: employee.employeeId || '',
            employeeName: employeeDisplayName(employee) || extra.employeeName || '',
            groupKey: extra.groupKey || 'office',
            start,
            end,
            isPending: Boolean(pending),
        });
    };

    for (let index = 1; index < sorted.length; index += 1) {
        const current = sorted[index];
        if (current !== nextCalendarDateKey(previous)) {
            pushSpan(rangeStart, previous);
            rangeStart = current;
        }
        previous = current;
    }
    pushSpan(rangeStart, previous);
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

            const requestedKey = String(row.requestedStatusKey || 'on_leave');
            if (!statusKeySet.has(requestedKey)) continue;

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

/**
 * GET /api/Leave/calendar/annual-list?year=YYYY
 * Annual leave applications for the year, with taken / used / remaining from punches.
 */
export async function getAnnualLeaveCalendarList(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
        const yearRaw = Number(String(req.query.year || '').trim());
        const year = Number.isInteger(yearRaw) && yearRaw >= 2000 && yearRaw <= 2100 ? yearRaw : dubai.year;
        const yearFrom = `${year}-01-01`;
        const yearTo = `${year}-12-31`;
        const todayKey = dubaiTodayDateKey();

        const [activeEmployees, locations] = await Promise.all([
            EmployeeBasic.find({
                profileStatus: 'active',
                status: { $ne: 'Left User' },
                employeeId: { $ne: 'VEGA-HR-0000' },
                ...REAL_EMPLOYEE_MONGO_FILTER,
            })
                .select('_id employeeId firstName lastName staffType')
                .lean()
                .maxTimeMS(12000),
            listActiveWorkLocations().catch(() => []),
        ]);

        const realEmployees = (activeEmployees || []).filter((row) => !isCompanyShellEmployee(row));
        const visibility = await loadEnrolledLeaveVisibilityByMongoId(realEmployees);

        const employeeMap = new Map();
        const employeeByCode = new Map();
        for (const emp of realEmployees) {
            const mongoId = String(emp._id);
            if (!visibility.has(mongoId)) continue;
            employeeMap.set(mongoId, emp);
            const code = String(emp.employeeId || '').trim();
            if (code) employeeByCode.set(code, emp);
        }

        const groupLabelByKey = new Map();
        for (const loc of locations || []) {
            const key = normalizeStaffTypeKey(loc.key);
            if (!key) continue;
            groupLabelByKey.set(key, loc.label || loc.key);
        }

        const groups = [...groupLabelByKey.entries()].map(([key, label]) => ({ key, label }));

        if (!employeeMap.size) {
            return res.status(200).json({
                message: 'Annual leave calendar list fetched successfully',
                year,
                today: todayKey,
                groups,
                count: 0,
                rows: [],
            });
        }

        const records = await Attendance.find({
            date: { $gte: yearFrom, $lte: yearTo },
            statusKey: 'on_leave',
        })
            .select(
                'date employeeMongoId employeeId employeeName statusKey leaveRequestFromDate leaveRequestToDate leaveRequestGroupId',
            )
            .lean()
            .maxTimeMS(15000);

        const pendingRecords = await Attendance.find({
            leaveRequestStatus: 'pending',
            leaveRequestKind: { $in: ['leave', 'future_leave', 'future_annual'] },
            $or: [
                { date: { $gte: yearFrom, $lte: yearTo } },
                {
                    leaveRequestFromDate: { $lte: yearTo },
                    leaveRequestToDate: { $gte: yearFrom },
                },
            ],
        })
            .select(
                'date employeeMongoId employeeId employeeName requestedStatusKey leaveRequestFromDate leaveRequestToDate leaveRequestGroupId',
            )
            .lean()
            .maxTimeMS(12000);

        const resolveEmp = (row) =>
            employeeMap.get(String(row.employeeMongoId || '')) ||
            employeeByCode.get(String(row.employeeId || '').trim()) ||
            null;

        const approvedDatesByEmp = new Map();
        const groupedApproved = new Map();

        for (const row of records || []) {
            const emp = resolveEmp(row);
            if (!emp) continue;
            const mongoId = String(emp._id);
            const dateKey = String(row.date || '').trim();
            if (!isValidDateKey(dateKey) && !isValidDateKey(String(row.leaveRequestFromDate || ''))) continue;

            const groupId = String(row.leaveRequestGroupId || '').trim();
            if (groupId) {
                if (!groupedApproved.has(groupId)) {
                    groupedApproved.set(groupId, {
                        employee: emp,
                        dates: new Set(),
                        rangeStart: row.leaveRequestFromDate || dateKey,
                        rangeEnd: row.leaveRequestToDate || dateKey,
                    });
                }
                const bucket = groupedApproved.get(groupId);
                if (isValidDateKey(dateKey)) bucket.dates.add(dateKey);
                const fromKey = row.leaveRequestFromDate || dateKey;
                const toKey = row.leaveRequestToDate || dateKey;
                if (isValidDateKey(fromKey) && fromKey < bucket.rangeStart) bucket.rangeStart = fromKey;
                if (isValidDateKey(toKey) && toKey > bucket.rangeEnd) bucket.rangeEnd = toKey;
                continue;
            }

            if (!isValidDateKey(dateKey)) continue;
            if (!approvedDatesByEmp.has(mongoId)) {
                approvedDatesByEmp.set(mongoId, { employee: emp, dates: new Set() });
            }
            approvedDatesByEmp.get(mongoId).dates.add(dateKey);
        }

        const spans = [];
        for (const bucket of groupedApproved.values()) {
            const clipped = clipRangeToYear(
                bucket.rangeStart || [...bucket.dates][0],
                bucket.rangeEnd || [...bucket.dates][0],
                yearFrom,
                yearTo,
            );
            if (!clipped) continue;
            spans.push({
                employeeMongoId: String(bucket.employee._id),
                employeeId: bucket.employee.employeeId || '',
                employeeName: employeeDisplayName(bucket.employee),
                groupKey: normalizeStaffTypeKey(bucket.employee.staffType),
                start: clipped.start,
                end: clipped.end,
                isPending: false,
            });
        }

        for (const bucket of approvedDatesByEmp.values()) {
            pushConsecutiveDateSpans(spans, {
                employee: bucket.employee,
                dates: bucket.dates,
                pending: false,
                extra: { groupKey: normalizeStaffTypeKey(bucket.employee.staffType) },
            });
        }

        const pendingKeys = new Set();
        for (const row of pendingRecords || []) {
            const emp = resolveEmp(row);
            if (!emp) continue;
            const requestedKey = String(row.requestedStatusKey || 'on_leave');
            if (requestedKey !== 'on_leave') continue;

            const rangeStart = row.leaveRequestFromDate || row.date;
            const rangeEnd = row.leaveRequestToDate || row.date;
            const clipped = clipRangeToYear(rangeStart, rangeEnd, yearFrom, yearTo);
            if (!clipped) continue;

            const groupId = String(row.leaveRequestGroupId || row._id || '').trim();
            const dedupe = `${emp._id}|${clipped.start}|${clipped.end}|${groupId}`;
            if (pendingKeys.has(dedupe)) continue;
            pendingKeys.add(dedupe);

            spans.push({
                employeeMongoId: String(emp._id),
                employeeId: emp.employeeId || '',
                employeeName: employeeDisplayName(emp) || row.employeeName || '',
                groupKey: normalizeStaffTypeKey(emp.staffType),
                start: clipped.start,
                end: clipped.end,
                isPending: true,
            });
        }

        const approvedCover = spans.filter((span) => !span.isPending);
        const uniqueSpans = spans.filter((span) => {
            if (!span.isPending) return true;
            return !approvedCover.some(
                (approved) =>
                    approved.employeeMongoId === span.employeeMongoId &&
                    approved.start === span.start &&
                    approved.end === span.end,
            );
        });

        const visibilityByCode = leaveVisibilityByEmployeeId(realEmployees, visibility);
        const historicalProfiles = await loadHistoricalLeaveProfilesByEmployeeId(
            Array.from(employeeByCode.keys()),
        );
        const historicalKeys = new Set(
            uniqueSpans.map((span) => `${span.employeeMongoId}|${span.start}|${span.end}`),
        );
        for (const emp of employeeMap.values()) {
            const overlay = overlayHistoricalLeave(
                historicalProfiles.get(String(emp.employeeId || '').trim()),
                { from: yearFrom, to: yearTo, includeCountOnly: false },
            );
            for (const entry of overlay.entries || []) {
                if (String(entry.statusKey || '') !== 'on_leave') continue;
                const clipped = clipRangeToYear(entry.fromDate, entry.toDate, yearFrom, yearTo);
                if (!clipped) continue;
                const key = `${emp._id}|${clipped.start}|${clipped.end}`;
                if (historicalKeys.has(key)) continue;
                historicalKeys.add(key);
                uniqueSpans.push({
                    employeeMongoId: String(emp._id),
                    employeeId: emp.employeeId || '',
                    employeeName: employeeDisplayName(emp),
                    groupKey: normalizeStaffTypeKey(emp.staffType),
                    start: clipped.start,
                    end: clipped.end,
                    isPending: false,
                    historical: true,
                });
            }
        }

        const punchDates = new Set();
        const punchMongoIds = new Set();
        const punchCodes = new Set();
        for (const span of uniqueSpans) {
            if (span.historical) continue;
            punchMongoIds.add(span.employeeMongoId);
            if (span.employeeId) punchCodes.add(span.employeeId);
            for (const dateKey of eachCalendarDateKeys(span.start, span.end)) {
                if (dateKey <= todayKey) punchDates.add(dateKey);
            }
        }

        const punchRecords =
            punchMongoIds.size && punchDates.size
                ? await Attendance.find({
                      date: { $in: [...punchDates] },
                      $or: [
                          { employeeMongoId: { $in: [...punchMongoIds] } },
                          ...(punchCodes.size ? [{ employeeId: { $in: [...punchCodes] } }] : []),
                      ],
                  })
                      .select('date employeeMongoId employeeId statusKey timeIn timeOut')
                      .lean()
                      .maxTimeMS(15000)
                : [];

        const attendanceByEmpDate = new Map();
        for (const row of punchRecords || []) {
            const emp = resolveEmp(row);
            if (!emp) continue;
            const dateKey = String(row.date || '').trim();
            if (!isValidDateKey(dateKey)) continue;
            attendanceByEmpDate.set(`${String(emp._id)}|${dateKey}`, row);
        }

        const rows = [];

        for (const span of uniqueSpans) {
            let start = span.start;
            let end = span.end;
            if (!span.historical) {
                const processingStart =
                    visibility.get(String(span.employeeMongoId)) ||
                    visibilityByCode.get(String(span.employeeId || '').trim());
                const clipped = clipLeaveSpanToVisiblePeriod(start, end, processingStart);
                if (!clipped) continue;
                start = clipped.start;
                end = clipped.end;
            }

            const dates = eachCalendarDateKeys(start, end);
            if (!dates.length) continue;

            let daysUsed = 0;
            for (const dateKey of dates) {
                if (dateKey > todayKey) continue;
                if (span.historical) {
                    daysUsed += 1;
                    continue;
                }
                const rec = attendanceByEmpDate.get(`${span.employeeMongoId}|${dateKey}`);
                if (!attendanceDayWasWorked(rec)) daysUsed += 1;
            }

            const daysApplied = dates.length;
            const remainingDays = Math.max(0, daysApplied - daysUsed);
            const status = daysApplied > 0 && remainingDays === 0 ? 'Taken' : 'Not';
            const groupKey = span.groupKey || 'office';
            if (!groupLabelByKey.has(groupKey)) {
                groupLabelByKey.set(groupKey, groupKey.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
            }

            rows.push({
                id: `${span.employeeMongoId}-${start}-${end}-${span.isPending ? 'p' : span.historical ? 'h' : 'a'}`,
                employeeMongoId: span.employeeMongoId,
                employeeId: span.employeeId,
                employeeName: span.employeeName || 'Employee',
                groupKey,
                groupLabel: groupLabelByKey.get(groupKey) || groupKey,
                startDate: start,
                endDate: end,
                daysApplied,
                daysUsed,
                remainingDays,
                status,
                isPending: Boolean(span.isPending),
                historical: Boolean(span.historical),
            });
        }

        rows.sort(
            (a, b) =>
                String(a.startDate).localeCompare(String(b.startDate)) ||
                String(a.employeeName).localeCompare(String(b.employeeName)),
        );

        const groupList = [...groupLabelByKey.entries()].map(([key, label]) => ({ key, label }));

        return res.status(200).json({
            message: 'Annual leave calendar list fetched successfully',
            year,
            today: todayKey,
            groups: groupList,
            count: rows.length,
            rows,
        });
    } catch (error) {
        console.error('[getAnnualLeaveCalendarList]', error);
        return res.status(500).json({
            message: error.message || 'Failed to fetch annual leave calendar list.',
        });
    }
}
