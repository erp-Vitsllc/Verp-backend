import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../utils/attendanceEmployeeFilters.js';
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

const LEAVE_CALENDAR_KEYS = [...LEAVE_COUNT_KEYS, 'holiday'];

function employeeDisplayName(emp) {
    return [emp?.firstName, emp?.lastName].filter(Boolean).join(' ').trim();
}

function isValidDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

/**
 * GET /api/Leave/employees
 * Active employees with leave day counts from attendance.
 * Query: year? | from?&to? (yyyy-MM-dd)
 */
export async function getEmployeeLeaveDirectory(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
        const queryFrom = String(req.query.from || '').trim();
        const queryTo = String(req.query.to || '').trim();
        const requestedYear = Number(req.query.year);

        let from;
        let to;
        let year;

        if (isValidDateKey(queryFrom) && isValidDateKey(queryTo) && queryFrom <= queryTo) {
            from = queryFrom;
            to = queryTo;
            year = Number(from.slice(0, 4));
        } else {
            year =
                Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
                    ? requestedYear
                    : dubai.year;
            from = `${year}-01-01`;
            to = `${year}-12-31`;
        }

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

        const employees = (rows || []).filter((e) => !isCompanyShellEmployee(e));
        const mongoIds = employees.map((e) => String(e._id));

        const grouped =
            mongoIds.length === 0
                ? []
                : await Attendance.aggregate([
                      {
                          $match: {
                              employeeMongoId: { $in: mongoIds },
                              date: { $gte: from, $lte: to },
                              statusKey: { $in: LEAVE_COUNT_KEYS },
                          },
                      },
                      {
                          $group: {
                              _id: {
                                  employeeMongoId: '$employeeMongoId',
                                  statusKey: '$statusKey',
                              },
                              count: { $sum: 1 },
                          },
                      },
                  ]);

        const countsByEmp = {};
        for (const row of grouped) {
            const id = String(row?._id?.employeeMongoId || '');
            const key = String(row?._id?.statusKey || '').trim();
            if (!id || !LEAVE_COUNT_KEYS.includes(key)) continue;
            if (!countsByEmp[id]) countsByEmp[id] = {};
            countsByEmp[id][key] = Number(row.count) || 0;
        }

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

        const statusKeys =
            leaveType === 'authorized'
                ? ['authorized_leave']
                : leaveType === 'annual'
                  ? ['on_leave']
                  : LEAVE_CALENDAR_KEYS;

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

        const employeeMap = new Map();
        for (const emp of (activeEmployees || []).filter((row) => !isCompanyShellEmployee(row))) {
            if (employeeMongoId && String(emp._id) !== employeeMongoId) continue;
            employeeMap.set(String(emp._id), emp);
        }

        const query = {
            date: { $gte: from, $lte: to },
            statusKey: { $in: statusKeys },
            employeeMongoId: { $in: Array.from(employeeMap.keys()) },
        };

        const records = await Attendance.find(query)
            .sort({ date: 1, employeeName: 1 })
            .lean()
            .maxTimeMS(12000);

        const pendingRecords = await Attendance.find({
            leaveRequestStatus: 'pending',
            leaveRequestKind: { $in: ['leave', 'future_leave', 'future_annual'] },
            employeeMongoId: { $in: Array.from(employeeMap.keys()) },
            employeeName: { $not: /\(company\)\s*$/i },
            $or: [
                { date: { $gte: from, $lte: to } },
                {
                    leaveRequestFromDate: { $lte: to },
                    leaveRequestToDate: { $gte: from },
                },
            ],
        })
            .sort({ date: 1, employeeName: 1 })
            .lean()
            .maxTimeMS(12000);

        const approvedEntries = (records || [])
            .filter((row) => employeeMap.has(String(row.employeeMongoId || '')))
            .map((row) => {
                const emp = employeeMap.get(String(row.employeeMongoId));
                return {
                    id: String(row._id || `${row.date}-${row.employeeMongoId}-${row.statusKey}`),
                    date: row.date,
                    employeeMongoId: String(row.employeeMongoId || emp?._id || ''),
                    employeeId: row.employeeId || emp?.employeeId || '',
                    employeeName: row.employeeName || employeeDisplayName(emp),
                    statusKey: row.statusKey,
                    statusLabel: row.statusLabel || row.statusKey,
                    isPending: false,
                };
            });

        const pendingKeys = new Set();
        const pendingEntries = [];

        for (const row of pendingRecords || []) {
            if (!employeeMap.has(String(row.employeeMongoId || ''))) continue;

            const emp = employeeMap.get(String(row.employeeMongoId));
            const rangeStart = row.leaveRequestFromDate || row.date;
            const rangeEnd = row.leaveRequestToDate || row.date;
            let cursor = rangeStart > from ? rangeStart : from;
            const endKey = rangeEnd < to ? rangeEnd : to;

            while (cursor && cursor <= endKey) {
                const dedupeKey = `${row.employeeMongoId}-${cursor}-pending`;
                if (!pendingKeys.has(dedupeKey)) {
                    pendingKeys.add(dedupeKey);
                    pendingEntries.push({
                        id: String(row._id || `${cursor}-${row.employeeMongoId}-pending`),
                        date: cursor,
                        employeeMongoId: String(row.employeeMongoId || emp?._id || ''),
                        employeeId: row.employeeId || emp?.employeeId || '',
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

        const entries = [...approvedEntries, ...pendingEntries].sort(
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
