import mongoose from 'mongoose';
import Attendance, { ATTENDANCE_STATUS_KEYS } from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Holiday from '../models/Holiday.js';
import { getScheduledEmailTimeZone, getZonedParts } from '../utils/scheduleDailyAtMidnight.js';
import {
    getOffWeekdayKeys,
    getScheduledPunchMinutes,
    clockTimeToMinutes,
    isWeekOffForStaff,
    loadWorkingTimeDoc,
    normalizeStaffType,
    resolveStatusFromPunches,
    weekdayKeyFromDateKey,
} from '../utils/workingTimeHelpers.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import {
    sendAttendanceLeaveRequestEmail,
    sendAttendanceLeaveDecisionEmail,
} from '../utils/sendAttendanceLeaveEmails.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../utils/attendanceEmployeeFilters.js';
import { listPendingHubInboxItems } from '../utils/employeeHubRequestInbox.js';

const LEAVE_REQUEST_STATUS_KEYS = new Set([
    'unauthorized_leave',
    'authorized_leave',
    'sick_leave',
    'on_leave',
]);

/** Employee red-day request: sick or other leave — not auth / unauth. */
const EMPLOYEE_LEAVE_REQUEST_KEYS = new Set(['sick_leave', 'on_leave']);

/** Reportee sets the final day status on approve. */
const REPORTEE_APPROVE_LEAVE_KEYS = new Set([
    'unauthorized_leave',
    'authorized_leave',
    'sick_leave',
]);

const YELLOW_REQUEST_STATUS_KEYS = new Set(['late_arrived', 'early_go', 'mispunch']);

const RED_LEAVE_STATUS_KEYS = new Set(['unauthorized_leave', 'on_leave']);

const LEAVE_STATUS_LABELS = {
    unauthorized_leave: 'Unauthorized Leave',
    authorized_leave: 'Authorized Leave',
    sick_leave: 'Sick Leave',
    on_leave: 'On Leave',
    on_office: 'Present',
    work_from_home: 'Work from home',
    late_arrived: 'Late Arrival',
    early_go: 'Early Go',
    mispunch: 'Mispunched',
};

function leaveStatusLabel(statusKey, fallback = '') {
    const key = String(statusKey || '').trim();
    return LEAVE_STATUS_LABELS[key] || fallback || key || '—';
}

function isMispunchReasonText(reason) {
    return String(reason || '')
        .toLowerCase()
        .includes('mispunch');
}

/** Yellow calendar days eligible for clarification → Present. */
function isYellowClarificationEligible(record) {
    if (!record) return false;
    const key = String(record.statusKey || '').trim();
    if (YELLOW_REQUEST_STATUS_KEYS.has(key)) return true;
    if (key === 'unauthorized_leave' && isMispunchReasonText(record.reason)) return true;
    if (record.timeIn && !record.timeOut && (key === 'on_office' || key === 'late_arrived' || key === 'work_from_home')) {
        return true;
    }
    return false;
}

function isValidDateKey(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatDateKeyFromParts({ year, month, day }) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getDubaiNowParts() {
    return getZonedParts(new Date(), getScheduledEmailTimeZone());
}

function getDubaiDateKey(date = new Date()) {
    const p = getZonedParts(date, getScheduledEmailTimeZone());
    return formatDateKeyFromParts(p);
}

function nextDateKey(dateKey) {
    const [year, month, day] = String(dateKey).split('-').map(Number);
    const dt = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
    return formatDateKeyFromParts({
        year: dt.getUTCFullYear(),
        month: dt.getUTCMonth() + 1,
        day: dt.getUTCDate(),
    });
}

function isNonWorkingDate(dateKey, holidaySet, offWeekdays) {
    if (holidaySet?.has(dateKey)) return true;
    const weekday = weekdayKeyFromDateKey(dateKey);
    return Boolean(weekday && offWeekdays?.has(weekday));
}

/** Skip tomorrow and all holidays/weekends; first allowed date is the 2nd working day from today. */
function firstEligibleAdvanceRequestDate(todayKey, holidaySet, offWeekdays) {
    let cursor = todayKey;
    let workingSeen = 0;
    for (let i = 0; i < 90; i += 1) {
        cursor = nextDateKey(cursor);
        if (isNonWorkingDate(cursor, holidaySet, offWeekdays)) continue;
        workingSeen += 1;
        if (workingSeen >= 2) return cursor;
    }
    return null;
}

async function loadHolidaySet(fromKey, toKey) {
    const rows = await Holiday.find({
        date: { $gte: fromKey, $lte: toKey },
    })
        .select('date')
        .lean();
    return new Set((rows || []).map((row) => String(row.date || '').trim()).filter(Boolean));
}

/** Exact local clock time HH:mm:ss in company TZ */
function getDubaiClockTime(date = new Date()) {
    const p = getZonedParts(date, getScheduledEmailTimeZone());
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

async function resolveLinkedEmployee(req) {
    let employee = null;

    const selectFields = '_id employeeId firstName lastName companyEmail workEmail email staffType';

    if (req.user?.employeeObjectId) {
        try {
            employee = await EmployeeBasic.findById(req.user.employeeObjectId)
                .select(selectFields)
                .lean();
        } catch {
            employee = null;
        }
    }

    if (!employee && req.user?.employeeId) {
        employee = await EmployeeBasic.findOne({ employeeId: req.user.employeeId })
            .select(selectFields)
            .lean();
    }

    const emailCandidates = [
        req.user?.companyEmail,
        req.user?.email,
    ]
        .map((e) => String(e || '').trim().toLowerCase())
        .filter(Boolean);

    if (!employee && emailCandidates.length) {
        employee = await EmployeeBasic.findOne({
            $or: [
                { companyEmail: { $in: emailCandidates } },
                { workEmail: { $in: emailCandidates } },
                { email: { $in: emailCandidates } },
            ],
        })
            .select(selectFields)
            .lean();

        // Case-insensitive fallback
        if (!employee) {
            const escaped = emailCandidates.map((e) =>
                e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            );
            employee = await EmployeeBasic.findOne({
                $or: escaped.flatMap((e) => [
                    { companyEmail: { $regex: `^${e}$`, $options: 'i' } },
                    { workEmail: { $regex: `^${e}$`, $options: 'i' } },
                    { email: { $regex: `^${e}$`, $options: 'i' } },
                ]),
            })
                .select(selectFields)
                .lean();
        }
    }

    return employee;
}

/** True if targetEmpId is the manager or anywhere under them via primaryReportee. */
async function isEmployeeInTeamTree(managerMongoId, targetMongoId) {
    const managerId = String(managerMongoId);
    const targetId = String(targetMongoId);
    if (managerId === targetId) return true;

    const rows = await EmployeeBasic.aggregate([
        { $match: { _id: new mongoose.Types.ObjectId(String(managerId)) } },
        {
            $graphLookup: {
                from: 'employeebasics',
                startWith: '$_id',
                connectFromField: '_id',
                connectToField: 'primaryReportee',
                as: 'team',
                depthField: 'depth',
            },
        },
        { $project: { teamIds: '$team._id' } },
    ]);

    const teamIds = (rows[0]?.teamIds || []).map((id) => String(id));
    return teamIds.includes(targetId);
}

function buildTeamTree(manager, flatList) {
    if (!manager) return [];
    const list = Array.isArray(flatList) ? flatList : [];
    const seenIds = new Set();

    const getChildren = (parentId, visited = new Set()) => {
        const parentKey = String(parentId);
        if (visited.has(parentKey)) return [];
        const nextVisited = new Set(visited);
        nextVisited.add(parentKey);

        return list
            .filter((e) => {
                const id = String(e._id);
                if (seenIds.has(id) || nextVisited.has(id)) return false;
                return String(e.primaryReportee) === parentKey;
            })
            .map((child) => {
                const id = String(child._id);
                seenIds.add(id);
                return {
                    ...child,
                    children: getChildren(child._id, nextVisited),
                };
            });
    };

    return [
        {
            _id: manager._id,
            firstName: manager.firstName,
            lastName: manager.lastName,
            employeeId: manager.employeeId,
            designation: manager.designation,
            department: manager.department,
            profilePicture: manager.profilePicture,
            primaryReportee: null,
            children: getChildren(manager._id),
        },
    ];
}

/** Empty day bucket used by calendar summary aggregation. */
function emptyDayStats(totalStaff = 0) {
    return {
        activeEmployees: totalStaff,
        present: 0,
        onLeave: 0,
        lateArrived: 0,
        sickLeave: 0,
        workFromHome: 0,
        // No marks yet — calendar shows total staff only until attendance is recorded.
        notMarked: 0,
        holiday: 0,
        weeklyOff: 0,
        isWeeklyOff: false,
        officePresent: 0,
        officeTotal: totalStaff,
        sitePresent: 0,
        siteTotal: 0,
        totalPresent: 0,
        absentAuthorized: 0,
        absentUnauthorized: 0,
    };
}

/**
 * Aggregate attendance marks for one calendar day.
 * unauthorized_leave counts with not_marked (same bucket).
 */
function buildDayStatsFromRecords(records, totalStaff = 0, { isWeeklyOffDay = false } = {}) {
    const rows = Array.isArray(records) ? records : [];
    const counts = {
        on_office: 0,
        on_leave: 0,
        sick_leave: 0,
        authorized_leave: 0,
        work_from_home: 0,
        late_arrived: 0,
        not_marked: 0,
        unauthorized_leave: 0,
        holiday: 0,
        weekly_off: 0,
    };

    for (const row of rows) {
        const key = String(row?.statusKey || '').trim();
        if (Object.prototype.hasOwnProperty.call(counts, key)) {
            counts[key] += 1;
        }
    }

    const markedCount = rows.length;
    const offOrHolidayCount = counts.holiday + counts.weekly_off;
    const implicitNotMarked = Math.max(0, totalStaff - markedCount);
    // Weekly off / holiday staff are not "not marked".
    const notMarked = isWeeklyOffDay
        ? counts.not_marked + counts.unauthorized_leave
        : counts.not_marked + counts.unauthorized_leave + Math.max(0, implicitNotMarked - offOrHolidayCount);
    const authorizedLeaveTotal = counts.on_leave + counts.authorized_leave;
    const weeklyOff = isWeeklyOffDay ? Math.max(offOrHolidayCount, totalStaff) : counts.weekly_off;
    const holiday = counts.holiday;

    return {
        activeEmployees: totalStaff,
        present: counts.on_office,
        onLeave: authorizedLeaveTotal,
        lateArrived: counts.late_arrived,
        sickLeave: counts.sick_leave,
        workFromHome: counts.work_from_home,
        notMarked: isWeeklyOffDay ? 0 : notMarked,
        holiday,
        weeklyOff,
        isWeeklyOff: Boolean(isWeeklyOffDay),
        officePresent: counts.on_office,
        officeTotal: totalStaff,
        sitePresent: 0,
        siteTotal: 0,
        totalPresent: counts.on_office,
        absentAuthorized: authorizedLeaveTotal,
        // Same value as notMarked — unauthorized and not marked are one category.
        absentUnauthorized: isWeeklyOffDay ? 0 : notMarked,
    };
}

function resolveStaffTypeFilter(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'site') return 'site';
    if (value === 'office') return 'office';
    return null;
}

/** Holiday / weekly off do not need HR approval queue. */
function approvalStatusForMark(statusKey) {
    const key = String(statusKey || '').trim();
    if (!key || key === 'holiday' || key === 'weekly_off' || key === 'clear_attendance' || key === 'clear') {
        return '';
    }
    return 'pending';
}

async function getActiveEmployeeIdsByStaffType(staffType) {
    const filter = {
        profileStatus: 'active',
        ...REAL_EMPLOYEE_MONGO_FILTER,
    };
    if (staffType === 'site') {
        filter.staffType = 'site';
    } else if (staffType === 'office') {
        // Default missing staffType to office so existing employees stay on Office tab.
        filter.$or = [
            { staffType: 'office' },
            { staffType: { $exists: false } },
            { staffType: null },
            { staffType: '' },
        ];
    }
    const rows = await EmployeeBasic.find(filter).select('_id').lean();
    return rows.map((r) => String(r._id));
}

async function countActiveEmployees(staffType = null) {
    if (!staffType) {
        return EmployeeBasic.countDocuments({
            profileStatus: 'active',
            ...REAL_EMPLOYEE_MONGO_FILTER,
        });
    }
    const ids = await getActiveEmployeeIdsByStaffType(staffType);
    return ids.length;
}

/**
 * GET /api/Attendance/mark-roster
 * Lean active-employee list for Mark Attendance (no heavy Employee list aggregation).
 * Query: staffType=office|site (optional)
 */
export async function getAttendanceMarkRoster(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const staffType = resolveStaffTypeFilter(req.query.staffType);
        const filter = {
            profileStatus: 'active',
            status: { $ne: 'Left User' },
            employeeId: { $ne: 'VEGA-HR-0000' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        };

        if (staffType === 'site') {
            filter.staffType = 'site';
        } else if (staffType === 'office') {
            filter.$or = [
                { staffType: 'office' },
                { staffType: { $exists: false } },
                { staffType: null },
                { staffType: '' },
            ];
        }

        const rows = await EmployeeBasic.find(filter)
            .select('_id employeeId firstName lastName staffType profileStatus status')
            .sort({ firstName: 1, lastName: 1 })
            .lean()
            .maxTimeMS(8000);

        const employees = (rows || [])
            .filter((e) => !isCompanyShellEmployee(e))
            .map((e) => ({
                _id: String(e._id),
                id: String(e._id),
                employeeId: e.employeeId || '',
                firstName: e.firstName || '',
                lastName: e.lastName || '',
                name: [e.firstName, e.lastName].filter(Boolean).join(' ').trim(),
                staffType: normalizeStaffType(e.staffType),
                profileStatus: e.profileStatus || 'active',
                status: e.status || '',
            }));

        return res.status(200).json({
            message: 'Attendance mark roster fetched successfully',
            count: employees.length,
            staffType: staffType || 'all',
            employees,
        });
    } catch (error) {
        console.error('[getAttendanceMarkRoster]', error);
        return res.status(500).json({
            message: error.message || 'Failed to load attendance roster.',
        });
    }
}

/** GET /api/Attendance?date=yyyy-MM-dd */
export async function getAttendanceByDate(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const date = String(req.query.date || '').trim();
        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'Valid date (yyyy-MM-dd) is required.' });
        }

        const records = await Attendance.find({
            date,
            employeeName: { $not: /\(company\)\s*$/i },
        })
            .sort({ employeeName: 1 })
            .lean();
        return res.status(200).json({
            message: 'Attendance fetched successfully',
            date,
            records: (records || []).filter((r) => !isCompanyShellEmployee(r.employeeName)),
        });
    } catch (error) {
        console.error('[getAttendanceByDate]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch attendance.' });
    }
}

/**
 * GET /api/Attendance/calendar?month=yyyy-MM
 * Optional: from=yyyy-MM-dd&to=yyyy-MM-dd (overrides month bounds when both valid).
 * Optional: staffType=office|site — filter calendar to that staff group.
 * Returns per-day attendance summary for the HR attendance calendar.
 */
export async function getAttendanceCalendarSummary(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const month = String(req.query.month || '').trim();
        const fromQuery = String(req.query.from || '').trim();
        const toQuery = String(req.query.to || '').trim();
        const staffType = resolveStaffTypeFilter(req.query.staffType);

        let from;
        let to;
        let monthKey;

        if (isValidDateKey(fromQuery) && isValidDateKey(toQuery) && fromQuery <= toQuery) {
            from = fromQuery;
            to = toQuery;
            monthKey = from.slice(0, 7);
        } else {
            let year;
            let monthNum;
            if (/^\d{4}-\d{2}$/.test(month)) {
                year = Number(month.slice(0, 4));
                monthNum = Number(month.slice(5, 7));
            } else {
                const p = getDubaiNowParts();
                year = p.year;
                monthNum = p.month;
            }

            if (!Number.isFinite(year) || !Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) {
                return res.status(400).json({ message: 'Valid month (yyyy-MM) is required.' });
            }

            from = `${year}-${String(monthNum).padStart(2, '0')}-01`;
            const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
            to = `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
            monthKey = `${year}-${String(monthNum).padStart(2, '0')}`;
        }

        const [staffIds, totalStaff, records, workingTime] = await Promise.all([
            staffType ? getActiveEmployeeIdsByStaffType(staffType) : Promise.resolve(null),
            countActiveEmployees(staffType),
            Attendance.find({ date: { $gte: from, $lte: to } }).lean(),
            loadWorkingTimeDoc(),
        ]);

        const staffIdSet = staffIds ? new Set(staffIds) : null;
        const scheduleWeek = staffType === 'site' ? workingTime.site : workingTime.office;

        const byDate = new Map();
        for (const row of records) {
            if (staffIdSet && !staffIdSet.has(String(row?.employeeMongoId || ''))) continue;
            const key = String(row?.date || '').trim();
            if (!isValidDateKey(key)) continue;
            if (!byDate.has(key)) byDate.set(key, []);
            byDate.get(key).push(row);
        }

        const days = {};
        const start = new Date(`${from}T12:00:00.000Z`);
        const end = new Date(`${to}T12:00:00.000Z`);
        for (let cursor = start; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
            const dateKey = cursor.toISOString().slice(0, 10);
            const dayRecords = byDate.get(dateKey) || [];
            const isWeeklyOffDay = staffType
                ? isWeekOffForStaff(scheduleWeek, dateKey)
                : false;
            const stats =
                dayRecords.length > 0 || isWeeklyOffDay
                    ? buildDayStatsFromRecords(dayRecords, totalStaff, { isWeeklyOffDay })
                    : emptyDayStats(totalStaff);

            if (isWeeklyOffDay) {
                stats.isWeeklyOff = true;
                stats.weeklyOff = Math.max(Number(stats.weeklyOff) || 0, totalStaff);
                stats.notMarked = 0;
                stats.absentUnauthorized = 0;
            }

            // When filtered to one staff group, mirror totals into that group's present/total fields.
            if (staffType === 'office') {
                stats.officePresent = stats.totalPresent;
                stats.officeTotal = totalStaff;
                stats.sitePresent = 0;
                stats.siteTotal = 0;
            } else if (staffType === 'site') {
                stats.sitePresent = stats.totalPresent;
                stats.siteTotal = totalStaff;
                stats.officePresent = 0;
                stats.officeTotal = 0;
            }

            days[dateKey] = stats;
        }

        return res.status(200).json({
            message: 'Attendance calendar fetched successfully',
            month: monthKey,
            from,
            to,
            staffType: staffType || 'all',
            totalStaff,
            offWeekdays: staffType ? getOffWeekdayKeys(scheduleWeek) : [],
            days,
        });
    } catch (error) {
        console.error('[getAttendanceCalendarSummary]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch attendance calendar.' });
    }
}

/** POST /api/Attendance/mark — upsert one or many marks for a day */
export async function markAttendance(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const date = String(req.body?.date || '').trim();
        const marks = Array.isArray(req.body?.marks) ? req.body.marks : [];

        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'Valid date (yyyy-MM-dd) is required.' });
        }
        if (marks.length === 0) {
            return res.status(400).json({ message: 'At least one mark is required.' });
        }

        const markedBy = req.user?.id || null;
        const saved = [];

        for (const raw of marks) {
            const employeeMongoId = String(raw?.employeeMongoId || raw?.id || '').trim();
            const statusKey = String(raw?.statusKey || raw?.markKey || '').trim();
            const statusLabel = String(raw?.statusLabel || raw?.markLabel || '').trim();

            if (!employeeMongoId) {
                return res.status(400).json({ message: 'employeeMongoId is required for each mark.' });
            }

            // Clear attendance → remove the day record so status shows blank.
            if (statusKey === 'clear_attendance' || statusKey === 'clear') {
                await Attendance.deleteOne({ date, employeeMongoId });
                saved.push({
                    date,
                    employeeMongoId,
                    cleared: true,
                    statusKey: '',
                    statusLabel: '',
                    timeIn: '',
                    timeOut: '',
                });
                continue;
            }

            if (!ATTENDANCE_STATUS_KEYS.includes(statusKey)) {
                return res.status(400).json({ message: `Invalid statusKey: ${statusKey}` });
            }
            if (!statusLabel) {
                return res.status(400).json({ message: 'statusLabel is required for each mark.' });
            }

            const timeIn = raw?.timeIn != null && raw.timeIn !== '—' ? String(raw.timeIn).trim() : '';
            const timeOut = raw?.timeOut != null && raw.timeOut !== '—' ? String(raw.timeOut).trim() : '';
            let reason = String(raw?.reason || '').trim();

            // Apply Flowchart HR Working Time punch rules (grace / early go) when times are set.
            let finalStatusKey = statusKey;
            let finalStatusLabel = statusLabel;
            try {
                const emp = await EmployeeBasic.findById(employeeMongoId)
                    .select('staffType employeeId firstName lastName')
                    .lean();
                const staffType = normalizeStaffType(emp?.staffType);
                const workingTime = await loadWorkingTimeDoc();
                const week = staffType === 'site' ? workingTime.site : workingTime.office;
                const schedule = getScheduledPunchMinutes(week, date);
                const resolved = resolveStatusFromPunches({
                    timeIn,
                    timeOut,
                    startMinutes: schedule.startMinutes,
                    endMinutes: schedule.endMinutes,
                    isOffDay: schedule.isOffDay,
                    baseStatusKey: statusKey,
                    baseStatusLabel: statusLabel,
                    baseReason: reason,
                });
                finalStatusKey = resolved.statusKey;
                finalStatusLabel = resolved.statusLabel;
                if (resolved.reason !== undefined) reason = resolved.reason;
            } catch (scheduleErr) {
                console.error('[markAttendance] schedule punch rules failed:', scheduleErr);
            }

            const doc = await Attendance.findOneAndUpdate(
                { date, employeeMongoId },
                {
                    $set: {
                        date,
                        employeeMongoId,
                        employeeId: String(raw?.employeeId || raw?.empNo || '').trim(),
                        employeeName: String(raw?.employeeName || raw?.name || '').trim(),
                        statusKey: finalStatusKey,
                        statusLabel: finalStatusLabel,
                        timeIn,
                        timeOut,
                        reason,
                        attachmentName: String(raw?.attachmentName || '').trim(),
                        approvalStatus: approvalStatusForMark(finalStatusKey),
                        markedBy,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );

            saved.push(doc);
        }

        return res.status(200).json({
            message: 'Attendance saved successfully',
            date,
            records: saved,
        });
    } catch (error) {
        console.error('[markAttendance]', error);
        return res.status(500).json({ message: error.message || 'Failed to save attendance.' });
    }
}

/** GET /api/Attendance/me?month=yyyy-MM&forEmployeeId=optionalMongoId */
export async function getMyAttendanceMonth(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        let employee = self;
        const forEmployeeId = String(req.query.forEmployeeId || '').trim();
        if (forEmployeeId && forEmployeeId !== String(self._id)) {
            const allowed = await isEmployeeInTeamTree(self._id, forEmployeeId);
            if (!allowed) {
                return res.status(403).json({ message: 'You can only view attendance for your team.' });
            }
            const target = await EmployeeBasic.findById(forEmployeeId)
                .select('_id employeeId firstName lastName staffType')
                .lean();
            if (!target) {
                return res.status(404).json({ message: 'Employee not found.' });
            }
            employee = target;
        } else {
            employee = await EmployeeBasic.findById(self._id)
                .select('_id employeeId firstName lastName staffType')
                .lean();
            if (!employee) employee = self;
        }

        const month = String(req.query.month || '').trim();
        let year;
        let monthNum;
        if (/^\d{4}-\d{2}$/.test(month)) {
            year = Number(month.slice(0, 4));
            monthNum = Number(month.slice(5, 7));
        } else {
            const p = getDubaiNowParts();
            year = p.year;
            monthNum = p.month;
        }

        const from = `${year}-${String(monthNum).padStart(2, '0')}-01`;
        const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
        const to = `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const todayKey = getDubaiDateKey();
        const employeeMongoId = String(employee._id);
        const isSelf = employeeMongoId === String(self._id);
        const staffType = normalizeStaffType(employee.staffType);

        const [records, workingTime] = await Promise.all([
            Attendance.find({
                employeeMongoId,
                date: { $gte: from, $lte: to },
            }).lean(),
            loadWorkingTimeDoc(),
        ]);

        const scheduleWeek = staffType === 'site' ? workingTime.site : workingTime.office;
        const offWeekdays = getOffWeekdayKeys(scheduleWeek);
        const todayRecord = records.find((r) => r.date === todayKey) || null;

        return res.status(200).json({
            message: 'Attendance fetched successfully',
            month: `${year}-${String(monthNum).padStart(2, '0')}`,
            from,
            to,
            today: todayKey,
            isSelf,
            employee: {
                id: employeeMongoId,
                employeeId: employee.employeeId,
                name: [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim(),
                staffType,
            },
            offWeekdays,
            workingTime: {
                site: workingTime.site,
                office: workingTime.office,
            },
            records,
            todayRecord,
        });
    } catch (error) {
        console.error('[getMyAttendanceMonth]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch attendance.' });
    }
}

const YEAR_SUMMARY_KEYS = [
    'on_leave',
    'sick_leave',
    'authorized_leave',
    'unauthorized_leave',
    'work_from_home',
    'on_office',
    'late_arrived',
    'early_go',
    'mispunch',
    'holiday',
    'weekly_off',
];

function emptyYearCounts() {
    return Object.fromEntries(YEAR_SUMMARY_KEYS.map((key) => [key, 0]));
}

/**
 * GET /api/Attendance/me/year-summary
 * Logged-in employee's attendance counts for the current (or requested) calendar year.
 */
export async function getMyAttendanceYearSummary(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const dubai = getDubaiNowParts();
        const requested = Number(req.query.year);
        const year = Number.isInteger(requested) && requested >= 2000 && requested <= 2100
            ? requested
            : dubai.year;
        const from = `${year}-01-01`;
        const to = `${year}-12-31`;
        const counts = emptyYearCounts();

        const grouped = await Attendance.aggregate([
            {
                $match: {
                    employeeMongoId: String(self._id),
                    date: { $gte: from, $lte: to },
                },
            },
            { $group: { _id: '$statusKey', count: { $sum: 1 } } },
        ]);

        for (const row of grouped) {
            const key = String(row?._id || '').trim();
            if (Object.prototype.hasOwnProperty.call(counts, key)) {
                counts[key] = Number(row.count) || 0;
            }
        }

        const leaveTotal =
            counts.on_leave +
            counts.sick_leave +
            counts.authorized_leave +
            counts.unauthorized_leave;

        return res.status(200).json({
            message: 'Year summary fetched successfully',
            year,
            from,
            to,
            counts,
            leaveTotal,
        });
    } catch (error) {
        console.error('[getMyAttendanceYearSummary]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch year summary.' });
    }
}

/**
 * GET /api/Attendance/team-tree
 * Root = logged-in employee; children = primaryReportee chain (full tree).
 */
export async function getAttendanceTeamTree(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const manager = await resolveLinkedEmployee(req);
        if (!manager) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const managerFull = await EmployeeBasic.findById(manager._id)
            .select('_id firstName lastName employeeId designation department profilePicture')
            .lean();

        const rows = await EmployeeBasic.aggregate([
            { $match: { _id: manager._id } },
            {
                $graphLookup: {
                    from: 'employeebasics',
                    startWith: '$_id',
                    connectFromField: '_id',
                    connectToField: 'primaryReportee',
                    as: 'team',
                    depthField: 'depth',
                },
            },
            { $unwind: '$team' },
            {
                $project: {
                    _id: '$team._id',
                    firstName: '$team.firstName',
                    lastName: '$team.lastName',
                    employeeId: '$team.employeeId',
                    designation: '$team.designation',
                    department: '$team.department',
                    profilePicture: '$team.profilePicture',
                    primaryReportee: '$team.primaryReportee',
                    depth: '$team.depth',
                },
            },
            { $sort: { depth: 1, firstName: 1 } },
        ]);

        const tree = buildTeamTree(managerFull, rows);

        return res.status(200).json({
            message: 'Team tree fetched successfully',
            manager: managerFull,
            hierarchy: rows,
            tree,
        });
    } catch (error) {
        console.error('[getAttendanceTeamTree]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch team tree.' });
    }
}

/** Resolve self or a team member (forEmployeeId) the manager is allowed to mark. */
async function resolveMarkTargetEmployee(req) {
    const self = await resolveLinkedEmployee(req);
    if (!self) return { error: { status: 404, message: 'No linked employee profile found for this user.' } };

    const forEmployeeId = String(
        req.body?.forEmployeeId || req.query?.forEmployeeId || '',
    ).trim();

    if (!forEmployeeId || forEmployeeId === String(self._id)) {
        return { self, employee: self, isSelf: true };
    }

    const allowed = await isEmployeeInTeamTree(self._id, forEmployeeId);
    if (!allowed) {
        return { error: { status: 403, message: 'You can only mark attendance for your team.' } };
    }

    const target = await EmployeeBasic.findById(forEmployeeId)
        .select('_id employeeId firstName lastName staffType')
        .lean();
    if (!target) {
        return { error: { status: 404, message: 'Employee not found.' } };
    }

    return { self, employee: target, isSelf: false };
}

/** POST /api/Attendance/me/check-in — store exact Time In for today (self or team) */
export async function checkInMyAttendance(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const resolved = await resolveMarkTargetEmployee(req);
        if (resolved.error) {
            return res.status(resolved.error.status).json({ message: resolved.error.message });
        }

        const { employee } = resolved;
        const date = getDubaiDateKey();
        const timeIn = getDubaiClockTime();
        const employeeMongoId = String(employee._id);
        const employeeName = [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim();

        const existing = await Attendance.findOne({ date, employeeMongoId }).lean();
        if (existing?.timeIn) {
            return res.status(400).json({
                message: 'Already checked in for today.',
                record: existing,
            });
        }

        // Punch-in vs Flowchart HR Working Time (15-minute grace).
        let statusKey = 'not_marked';
        let statusLabel = 'On time';
        let reason = '';
        try {
            const staffType = normalizeStaffType(employee.staffType);
            const workingTime = await loadWorkingTimeDoc();
            const week = staffType === 'site' ? workingTime.site : workingTime.office;
            const { startMinutes, isOffDay } = getScheduledPunchMinutes(week, date);
            const actualMinutes = clockTimeToMinutes(timeIn);
            if (!isOffDay && startMinutes != null && actualMinutes != null) {
                const graceLimit = startMinutes + 15;
                if (actualMinutes > graceLimit) {
                    const lateMinutes = actualMinutes - graceLimit;
                    statusKey = 'late_arrived';
                    statusLabel = 'Late Arrival';
                    reason = `${lateMinutes} minute${lateMinutes === 1 ? '' : 's'} late`;
                }
            }
        } catch (scheduleErr) {
            console.error('[checkInMyAttendance] schedule lookup failed:', scheduleErr);
        }

        // Self check-in is allowed even if HR previously marked leave for the day —
        // checking in means the employee is present and starts the timer.
        const doc = await Attendance.findOneAndUpdate(
            { date, employeeMongoId },
            {
                $set: {
                    date,
                    employeeMongoId,
                    employeeId: String(employee.employeeId || ''),
                    employeeName,
                    statusKey,
                    statusLabel,
                    timeIn,
                    timeOut: '',
                    reason,
                    attachmentName: existing?.attachmentName || '',
                    approvalStatus: approvalStatusForMark(statusKey),
                    markedBy: req.user?.id || null,
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        return res.status(200).json({
            message: 'Checked in successfully',
            date,
            timeIn,
            record: doc,
        });
    } catch (error) {
        console.error('[checkInMyAttendance]', error);
        return res.status(500).json({ message: error.message || 'Failed to check in.' });
    }
}

/** POST /api/Attendance/me/check-out — store exact Time Out for today (self or team) */
export async function checkOutMyAttendance(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const resolved = await resolveMarkTargetEmployee(req);
        if (resolved.error) {
            return res.status(resolved.error.status).json({ message: resolved.error.message });
        }

        const { employee } = resolved;
        const date = getDubaiDateKey();
        const timeOut = getDubaiClockTime();
        const employeeMongoId = String(employee._id);

        const existing = await Attendance.findOne({ date, employeeMongoId });
        if (!existing?.timeIn) {
            return res.status(400).json({ message: 'Check in first before checking out.' });
        }
        if (existing.timeOut) {
            return res.status(400).json({
                message: 'Already checked out for today.',
                record: existing,
            });
        }

        existing.timeOut = timeOut;
        existing.markedBy = req.user?.id || existing.markedBy || null;

        const wasLate = existing.statusKey === 'late_arrived';
        const lateReason = wasLate ? String(existing.reason || '').trim() : '';

        // Punch-out vs Flowchart HR Working Time — early go = yellow.
        let earlyGo = false;
        try {
            const staffType = normalizeStaffType(employee.staffType);
            const workingTime = await loadWorkingTimeDoc();
            const week = staffType === 'site' ? workingTime.site : workingTime.office;
            const { endMinutes, isOffDay } = getScheduledPunchMinutes(week, date);
            const actualOut = clockTimeToMinutes(timeOut);
            if (!isOffDay && endMinutes != null && actualOut != null && actualOut < endMinutes) {
                earlyGo = true;
            }
        } catch (scheduleErr) {
            console.error('[checkOutMyAttendance] schedule lookup failed:', scheduleErr);
        }

        if (earlyGo) {
            existing.statusKey = 'early_go';
            existing.statusLabel = 'Early Go';
            existing.reason = lateReason
                ? `${lateReason}; Early go`
                : 'Punched out before scheduled punch-out';
        } else if (wasLate) {
            existing.statusKey = 'late_arrived';
            existing.statusLabel = 'Late Arrival';
            existing.reason = lateReason;
        } else {
            existing.statusKey = 'on_office';
            existing.statusLabel = 'On work';
            if (String(existing.reason || '').toLowerCase().includes('mispunch')) {
                existing.reason = '';
            }
        }
        existing.approvalStatus = approvalStatusForMark(existing.statusKey);

        await existing.save();

        return res.status(200).json({
            message: 'Checked out successfully',
            date,
            timeOut,
            record: existing,
        });
    } catch (error) {
        console.error('[checkOutMyAttendance]', error);
        return res.status(500).json({ message: error.message || 'Failed to check out.' });
    }
}

/**
 * POST /api/Attendance/team/mark
 * Mark one or many team members for a date (manager tree only).
 * Body: { date?, employeeMongoIds: [], statusKey, statusLabel, timeIn?, timeOut?, reason? }
 */
export async function markTeamAttendance(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const date = String(req.body?.date || getDubaiDateKey()).trim();
        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'Valid date (yyyy-MM-dd) is required.' });
        }

        const statusKey = String(req.body?.statusKey || req.body?.markKey || '').trim();
        const statusLabel = String(req.body?.statusLabel || req.body?.markLabel || '').trim();
        const isClear = statusKey === 'clear_attendance' || statusKey === 'clear';
        if (!isClear && (!ATTENDANCE_STATUS_KEYS.includes(statusKey) || !statusLabel)) {
            return res.status(400).json({ message: 'Valid statusKey and statusLabel are required.' });
        }

        let ids = Array.isArray(req.body?.employeeMongoIds)
            ? req.body.employeeMongoIds.map((id) => String(id || '').trim()).filter(Boolean)
            : [];

        // Mark entire team tree (excluding optional flag)
        if (req.body?.markAllTeam === true) {
            const treeRes = await EmployeeBasic.aggregate([
                { $match: { _id: self._id } },
                {
                    $graphLookup: {
                        from: 'employeebasics',
                        startWith: '$_id',
                        connectFromField: '_id',
                        connectToField: 'primaryReportee',
                        as: 'team',
                    },
                },
                { $project: { teamIds: '$team._id' } },
            ]);
            ids = (treeRes[0]?.teamIds || []).map((id) => String(id));
            // Include self when markAllTeam
            ids = Array.from(new Set([String(self._id), ...ids]));
        }

        if (ids.length === 0) {
            return res.status(400).json({ message: 'At least one employee is required.' });
        }

        const timeIn =
            req.body?.timeIn != null && req.body.timeIn !== '—' ? String(req.body.timeIn).trim() : '';
        const timeOut =
            req.body?.timeOut != null && req.body.timeOut !== '—'
                ? String(req.body.timeOut).trim()
                : '';
        const reason = String(req.body?.reason || '').trim();
        const attachmentName = String(req.body?.attachmentName || '').trim();
        const markedBy = req.user?.id || null;
        const saved = [];

        for (const employeeMongoId of ids) {
            const allowed = await isEmployeeInTeamTree(self._id, employeeMongoId);
            if (!allowed) {
                return res.status(403).json({
                    message: `Not allowed to mark employee ${employeeMongoId}.`,
                });
            }

            if (isClear) {
                await Attendance.deleteOne({ date, employeeMongoId });
                saved.push({
                    date,
                    employeeMongoId,
                    cleared: true,
                    statusKey: '',
                    statusLabel: '',
                });
                continue;
            }

            const emp = await EmployeeBasic.findById(employeeMongoId)
                .select('_id employeeId firstName lastName staffType')
                .lean();
            if (!emp) continue;

            let finalStatusKey = statusKey;
            let finalStatusLabel = statusLabel;
            let finalReason = reason;
            try {
                const staffType = normalizeStaffType(emp.staffType);
                const workingTime = await loadWorkingTimeDoc();
                const week = staffType === 'site' ? workingTime.site : workingTime.office;
                const schedule = getScheduledPunchMinutes(week, date);
                const resolved = resolveStatusFromPunches({
                    timeIn,
                    timeOut,
                    startMinutes: schedule.startMinutes,
                    endMinutes: schedule.endMinutes,
                    isOffDay: schedule.isOffDay,
                    baseStatusKey: statusKey,
                    baseStatusLabel: statusLabel,
                    baseReason: reason,
                });
                finalStatusKey = resolved.statusKey;
                finalStatusLabel = resolved.statusLabel;
                if (resolved.reason !== undefined) finalReason = resolved.reason;
            } catch (scheduleErr) {
                console.error('[markTeamAttendance] schedule punch rules failed:', scheduleErr);
            }

            const doc = await Attendance.findOneAndUpdate(
                { date, employeeMongoId },
                {
                    $set: {
                        date,
                        employeeMongoId,
                        employeeId: String(emp.employeeId || ''),
                        employeeName: [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim(),
                        statusKey: finalStatusKey,
                        statusLabel: finalStatusLabel,
                        timeIn,
                        timeOut,
                        reason: finalReason,
                        attachmentName,
                        approvalStatus: approvalStatusForMark(finalStatusKey),
                        markedBy,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );
            saved.push(doc);
        }

        return res.status(200).json({
            message: isClear
                ? 'Team attendance cleared successfully'
                : 'Team attendance marked successfully',
            date,
            count: saved.length,
            records: saved,
        });
    } catch (error) {
        console.error('[markTeamAttendance]', error);
        return res.status(500).json({ message: error.message || 'Failed to mark team attendance.' });
    }
}

/**
 * GET /api/Attendance/dashboard/pending-inbox
 * Leave requests pending for the logged-in primary reportee (Attendance bell + sidebar).
 */
export async function getAttendancePendingInbox(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        // Safety: remove any attendance rows for company shell accounts
        try {
            await Attendance.deleteMany({ employeeName: /\(company\)\s*$/i });
        } catch {
            /* ignore */
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(200).json({
                message: 'Attendance pending inbox fetched successfully',
                count: 0,
                items: [],
            });
        }

        const reportees = await EmployeeBasic.find({ primaryReportee: self._id })
            .select('_id')
            .lean();
        const reporteeIds = (reportees || []).map((r) => String(r._id));
        const hubItems = await listPendingHubInboxItems({
            assigneeIds: [self._id],
            kinds: ['leave'],
        });

        if (!reporteeIds.length) {
            return res.status(200).json({
                message: 'Attendance pending inbox fetched successfully',
                count: hubItems.length,
                items: hubItems,
            });
        }

        const rows = await Attendance.find({
            leaveRequestStatus: 'pending',
            employeeMongoId: { $in: reporteeIds },
            employeeName: { $not: /\(company\)\s*$/i },
        })
            .sort({ leaveRequestedAt: -1, date: -1 })
            .limit(500)
            .lean();

        const items = (rows || [])
            .filter((r) => !isCompanyShellEmployee(r.employeeName) && !isCompanyShellEmployee(r))
            .map((r) => {
                const kind = String(r.leaveRequestKind || '');
                const isYellow = kind === 'yellow';
                const isFuture = kind.startsWith('future_');
                const currentLabel =
                    r.previousStatusLabel || r.statusLabel || leaveStatusLabel(r.statusKey);
                const requestedLabel =
                    r.requestedStatusLabel ||
                    (isYellow ? 'Present' : leaveStatusLabel(r.requestedStatusKey));
                const summary = isYellow
                    ? `Clarification: mark ${r.date} as Present (currently ${currentLabel})`
                    : isFuture
                        ? `${requestedLabel} request for ${r.date}`
                        : `Leave change: mark ${r.date} as ${requestedLabel} (currently ${currentLabel})`;

                return {
                    id: String(r._id),
                    dashboardActionId: String(r._id),
                    requestType: 'Attendance Leave Request',
                    requestObjectId: String(r._id),
                    date: r.date,
                    employeeMongoId: r.employeeMongoId,
                    employeeId: r.employeeId || '',
                    subjectName: r.employeeName || 'Employee',
                    statusKey: r.statusKey,
                    statusLabel: r.statusLabel,
                    requestedStatusKey: r.requestedStatusKey || '',
                    requestedStatusLabel: requestedLabel,
                    previousStatusKey: r.previousStatusKey || '',
                    previousStatusLabel: currentLabel,
                    leaveRequestKind: r.leaveRequestKind || 'leave',
                    timeIn: r.timeIn || '',
                    timeOut: r.timeOut || '',
                    reason: r.leaveRequestReason || r.reason || '',
                    attachmentName: r.attachmentName || '',
                    leaveRequestStatus: r.leaveRequestStatus || 'pending',
                    approvalStatus: r.leaveRequestStatus || 'pending',
                    status: 'Pending',
                    extra1: r.date,
                    extra2: summary,
                    message: summary,
                };
            });

        return res.status(200).json({
            message: 'Attendance pending inbox fetched successfully',
            count: items.length + hubItems.length,
            items: [...hubItems, ...items],
        });
    } catch (error) {
        console.error('[getAttendancePendingInbox]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch pending attendance.' });
    }
}

/**
 * POST /api/Attendance/dashboard/approve-pending
 * Body: { ids: string[] } — approve pending leave requests for reportees.
 */
export async function approveAttendancePending(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const ids = Array.isArray(req.body?.ids)
            ? req.body.ids.map((id) => String(id || '').trim()).filter(Boolean)
            : [];
        if (ids.length === 0) {
            return res.status(400).json({ message: 'At least one pending attendance id is required.' });
        }

        let modifiedCount = 0;
        for (const id of ids) {
            const result = await decideLeaveRequestInternal({
                attendanceId: id,
                decision: 'approved',
                actor: self,
            });
            if (result?.ok) modifiedCount += 1;
        }

        return res.status(200).json({
            message: 'Attendance leave requests approved successfully',
            modifiedCount,
        });
    } catch (error) {
        console.error('[approveAttendancePending]', error);
        return res.status(500).json({ message: error.message || 'Failed to approve attendance.' });
    }
}

/**
 * POST /api/Attendance/me/leave-request
 * Employee requests Sick or Other leave on a red day.
 * Body: { date, requestedStatusKey, reason, attachmentName }
 */
export async function requestAttendanceLeave(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const date = String(req.body?.date || '').trim();
        const requestedStatusKey = String(req.body?.requestedStatusKey || '').trim();
        const reason = String(req.body?.reason || '').trim();
        const attachmentName = String(req.body?.attachmentName || '').trim();

        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'A valid date (yyyy-MM-dd) is required.' });
        }
        if (!EMPLOYEE_LEAVE_REQUEST_KEYS.has(requestedStatusKey)) {
            return res.status(400).json({
                message: 'requestedStatusKey must be sick_leave or on_leave.',
            });
        }
        if (!reason) {
            return res.status(400).json({ message: 'Description is required for leave requests.' });
        }
        if (!attachmentName) {
            return res.status(400).json({ message: 'Attachment is required for leave requests.' });
        }

        const todayKey = getDubaiDateKey();
        if (date > todayKey) {
            return res.status(400).json({ message: 'Cannot request leave for a future date.' });
        }

        const employee = await EmployeeBasic.findById(self._id)
            .select(
                '_id employeeId firstName lastName companyEmail workEmail email primaryReportee',
            )
            .populate(
                'primaryReportee',
                'firstName lastName employeeId companyEmail workEmail email',
            )
            .lean();

        if (!employee?.primaryReportee?._id) {
            return res.status(400).json({
                message: 'Primary reportee is required before requesting a leave status change.',
            });
        }

        let record = await Attendance.findOne({
            employeeMongoId: String(employee._id),
            date,
        });

        if (!record) {
            return res.status(400).json({
                message: 'No attendance mark found for this date. Only red leave days can be requested.',
            });
        }

        if (!RED_LEAVE_STATUS_KEYS.has(record.statusKey)) {
            return res.status(400).json({
                message: 'Leave change can only be requested on Unauthorized / Leave (red) days.',
            });
        }

        if (record.leaveRequestStatus === 'pending') {
            return res.status(400).json({
                message: 'A leave request is already pending for this date.',
                record,
            });
        }

        const empName =
            [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() ||
            record.employeeName ||
            'Employee';
        const requestedStatusLabel = leaveStatusLabel(requestedStatusKey);
        const previousStatusKey = record.statusKey;
        const previousStatusLabel =
            record.statusLabel || leaveStatusLabel(record.statusKey);

        record.previousStatusKey = previousStatusKey;
        record.previousStatusLabel = previousStatusLabel;
        record.requestedStatusKey = requestedStatusKey;
        record.requestedStatusLabel = requestedStatusLabel;
        record.leaveRequestReason = reason;
        record.leaveRequestKind = 'leave';
        record.attachmentName = attachmentName || record.attachmentName || '';
        record.leaveRequestStatus = 'pending';
        record.leaveRequestedAt = new Date();
        record.leaveDecidedAt = null;
        record.leaveDecidedBy = null;
        record.employeeId = employee.employeeId || record.employeeId || '';
        record.employeeName = empName;
        await record.save();

        await syncDashboardAction({
            requestId: record._id,
            requestType: 'Attendance Leave Request',
            assignedTo: employee.primaryReportee._id,
            status: 'Pending',
            subjectEmployee: employee,
            requestedByName: empName,
            extra1: date,
            extra2: `Leave request: ${requestedStatusLabel} (was ${previousStatusLabel})`,
            extra3: JSON.stringify({
                attendanceId: String(record._id),
                employeeMongoId: String(employee._id),
                date,
                requestedStatusKey,
                leaveRequestKind: 'leave',
            }),
        });

        await sendAttendanceLeaveRequestEmail({
            manager: employee.primaryReportee,
            employee,
            date,
            requestedLabel: requestedStatusLabel,
            currentLabel: previousStatusLabel,
            reason,
            kind: 'leave',
            attachmentName,
        });

        return res.status(200).json({
            message: 'Leave request sent to your primary reportee.',
            record,
        });
    } catch (error) {
        console.error('[requestAttendanceLeave]', error);
        return res.status(500).json({ message: error.message || 'Failed to submit leave request.' });
    }
}

/**
 * POST /api/Attendance/me/yellow-request
 * Employee clarifies a yellow day (late / early / mispunch) → asks Present.
 * Body: { date, reason, attachmentName? }
 */
export async function requestAttendanceYellow(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const date = String(req.body?.date || '').trim();
        const reason = String(req.body?.reason || '').trim();
        const attachmentName = String(req.body?.attachmentName || '').trim();

        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'A valid date (yyyy-MM-dd) is required.' });
        }
        if (!reason) {
            return res.status(400).json({ message: 'Reason is required for yellow day clarification.' });
        }

        const todayKey = getDubaiDateKey();
        if (date > todayKey) {
            return res.status(400).json({ message: 'Cannot request clarification for a future date.' });
        }

        const employee = await EmployeeBasic.findById(self._id)
            .select(
                '_id employeeId firstName lastName companyEmail workEmail email primaryReportee',
            )
            .populate(
                'primaryReportee',
                'firstName lastName employeeId companyEmail workEmail email',
            )
            .lean();

        if (!employee?.primaryReportee?._id) {
            return res.status(400).json({
                message: 'Primary reportee is required before requesting clarification.',
            });
        }

        const record = await Attendance.findOne({
            employeeMongoId: String(employee._id),
            date,
        });

        if (!record) {
            return res.status(400).json({
                message: 'No attendance mark found for this date.',
            });
        }

        if (!isYellowClarificationEligible(record)) {
            return res.status(400).json({
                message: 'Clarification can only be requested on yellow (late / early / mispunch) days.',
            });
        }

        if (record.leaveRequestStatus === 'pending') {
            return res.status(400).json({
                message: 'A request is already pending for this date.',
                record,
            });
        }

        const empName =
            [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() ||
            record.employeeName ||
            'Employee';
        const previousStatusKey = record.statusKey;
        const previousStatusLabel =
            record.statusLabel || leaveStatusLabel(record.statusKey);

        record.previousStatusKey = previousStatusKey;
        record.previousStatusLabel = previousStatusLabel;
        record.requestedStatusKey = 'on_office';
        record.requestedStatusLabel = 'Present';
        record.leaveRequestReason = reason;
        record.leaveRequestKind = 'yellow';
        record.attachmentName = attachmentName || record.attachmentName || '';
        record.leaveRequestStatus = 'pending';
        record.leaveRequestedAt = new Date();
        record.leaveDecidedAt = null;
        record.leaveDecidedBy = null;
        record.employeeId = employee.employeeId || record.employeeId || '';
        record.employeeName = empName;
        await record.save();

        await syncDashboardAction({
            requestId: record._id,
            requestType: 'Attendance Leave Request',
            assignedTo: employee.primaryReportee._id,
            status: 'Pending',
            subjectEmployee: employee,
            requestedByName: empName,
            extra1: date,
            extra2: `Clarification: mark as Present (was ${previousStatusLabel})`,
            extra3: JSON.stringify({
                attendanceId: String(record._id),
                employeeMongoId: String(employee._id),
                date,
                requestedStatusKey: 'on_office',
                leaveRequestKind: 'yellow',
            }),
        });

        await sendAttendanceLeaveRequestEmail({
            manager: employee.primaryReportee,
            employee,
            date,
            requestedLabel: 'Present',
            currentLabel: previousStatusLabel,
            reason,
            kind: 'yellow',
            attachmentName,
        });

        return res.status(200).json({
            message: 'Clarification request sent to your primary reportee.',
            record,
        });
    } catch (error) {
        console.error('[requestAttendanceYellow]', error);
        return res.status(500).json({
            message: error.message || 'Failed to submit yellow day clarification.',
        });
    }
}

const FUTURE_REQUEST_KINDS = {
    leave: {
        leaveRequestKind: 'future_leave',
        requestedStatusKey: 'authorized_leave',
        requestedStatusLabel: 'Authorized Leave',
        extra2Prefix: 'Future leave',
    },
    late_arrived: {
        leaveRequestKind: 'future_late',
        requestedStatusKey: 'late_arrived',
        requestedStatusLabel: 'Late arrival',
        extra2Prefix: 'Future late arrival',
    },
    early_go: {
        leaveRequestKind: 'future_early',
        requestedStatusKey: 'early_go',
        requestedStatusLabel: 'Early go',
        extra2Prefix: 'Future early go',
    },
};

/**
 * POST /api/Attendance/me/future-request
 * Planned leave / late / early on a future working day (not tomorrow; skip holidays).
 * Body: { date, kind: leave|late_arrived|early_go, reason, attachmentName }
 */
export async function requestAttendanceFuture(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const date = String(req.body?.date || '').trim();
        const kind = String(req.body?.kind || '').trim();
        const reason = String(req.body?.reason || '').trim();
        const attachmentName = String(req.body?.attachmentName || '').trim();
        const spec = FUTURE_REQUEST_KINDS[kind];

        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'A valid date (yyyy-MM-dd) is required.' });
        }
        if (!spec) {
            return res.status(400).json({ message: 'Choose Leave, Late arrival, or Early go.' });
        }
        if (!reason) {
            return res.status(400).json({ message: 'Description is required.' });
        }
        if (!attachmentName) {
            return res.status(400).json({ message: 'Attachment is required.' });
        }

        const todayKey = getDubaiDateKey();
        if (date <= todayKey) {
            return res.status(400).json({ message: 'This request is only for a future working day.' });
        }

        const employee = await EmployeeBasic.findById(self._id)
            .select(
                '_id employeeId firstName lastName companyEmail workEmail email primaryReportee staffType',
            )
            .populate(
                'primaryReportee',
                'firstName lastName employeeId companyEmail workEmail email',
            )
            .lean();

        if (!employee?.primaryReportee?._id) {
            return res.status(400).json({
                message: 'Primary reportee is required before sending this request.',
            });
        }

        const staffType = normalizeStaffType(employee.staffType);
        const workingTime = await loadWorkingTimeDoc();
        const scheduleWeek = staffType === 'site' ? workingTime.site : workingTime.office;
        const offWeekdays = new Set(getOffWeekdayKeys(scheduleWeek));
        const holidaySet = await loadHolidaySet(todayKey, date);
        const firstEligible = firstEligibleAdvanceRequestDate(todayKey, holidaySet, offWeekdays);

        if (isNonWorkingDate(date, holidaySet, offWeekdays)) {
            return res.status(400).json({ message: 'Cannot request on a holiday or weekly off.' });
        }
        if (!firstEligible || date < firstEligible) {
            return res.status(400).json({
                message: `Cannot request for tomorrow. The earliest date is ${firstEligible || 'the second working day'} (one working day ahead, holidays skipped).`,
            });
        }

        let record = await Attendance.findOne({
            employeeMongoId: String(employee._id),
            date,
        });
        if (record?.leaveRequestStatus === 'pending') {
            return res.status(400).json({
                message: 'A request is already pending for this date.',
                record,
            });
        }
        if (
            record &&
            (record.leaveRequestStatus === 'approved' || record.approvalStatus === 'approved') &&
            ['authorized_leave', 'late_arrived', 'early_go'].includes(
                String(record.statusKey || ''),
            )
        ) {
            return res.status(400).json({
                message: 'This date already has an approved request.',
                record,
            });
        }

        const empName =
            [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() ||
            record?.employeeName ||
            'Employee';

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
        record.requestedStatusKey = spec.requestedStatusKey;
        record.requestedStatusLabel = spec.requestedStatusLabel;
        record.leaveRequestReason = reason;
        record.leaveRequestKind = spec.leaveRequestKind;
        record.attachmentName = attachmentName;
        record.leaveRequestStatus = 'pending';
        record.leaveRequestedAt = new Date();
        record.leaveDecidedAt = null;
        record.leaveDecidedBy = null;
        record.employeeId = employee.employeeId || record.employeeId || '';
        record.employeeName = empName;
        await record.save();

        await syncDashboardAction({
            requestId: record._id,
            requestType: 'Attendance Leave Request',
            assignedTo: employee.primaryReportee._id,
            status: 'Pending',
            subjectEmployee: employee,
            requestedByName: empName,
            extra1: date,
            extra2: `${spec.extra2Prefix}: ${date}`,
            extra3: JSON.stringify({
                attendanceId: String(record._id),
                employeeMongoId: String(employee._id),
                date,
                requestedStatusKey: spec.requestedStatusKey,
                leaveRequestKind: spec.leaveRequestKind,
            }),
        });

        await sendAttendanceLeaveRequestEmail({
            manager: employee.primaryReportee,
            employee,
            date,
            requestedLabel: spec.requestedStatusLabel,
            currentLabel: 'Upcoming',
            reason,
            kind: spec.leaveRequestKind,
            attachmentName,
        });

        return res.status(200).json({
            message: 'Request sent to your primary reportee.',
            record,
        });
    } catch (error) {
        console.error('[requestAttendanceFuture]', error);
        return res.status(500).json({ message: error.message || 'Failed to submit future request.' });
    }
}

/**
 * POST /api/Attendance/me/leave-request/decide
 * Primary reportee approves or rejects.
 * Body: { attendanceId | date + employeeMongoId, decision, approvedStatusKey? }
 */
export async function decideAttendanceLeaveRequest(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveLinkedEmployee(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const decision = String(req.body?.decision || '').trim().toLowerCase();
        if (decision !== 'approved' && decision !== 'rejected') {
            return res.status(400).json({ message: 'decision must be approved or rejected.' });
        }

        const attendanceId = String(req.body?.attendanceId || '').trim();
        const date = String(req.body?.date || '').trim();
        const employeeMongoId = String(req.body?.employeeMongoId || '').trim();
        const approvedStatusKey = String(req.body?.approvedStatusKey || '').trim();

        const result = await decideLeaveRequestInternal({
            attendanceId,
            date,
            employeeMongoId,
            decision,
            approvedStatusKey,
            actor: self,
        });

        if (!result.ok) {
            return res.status(result.status || 400).json({ message: result.message });
        }

        return res.status(200).json({
            message:
                decision === 'approved'
                    ? 'Leave request approved.'
                    : 'Leave request rejected. Previous status kept.',
            record: result.record,
        });
    } catch (error) {
        console.error('[decideAttendanceLeaveRequest]', error);
        return res.status(500).json({ message: error.message || 'Failed to decide leave request.' });
    }
}

async function decideLeaveRequestInternal({
    attendanceId,
    date,
    employeeMongoId,
    decision,
    approvedStatusKey = '',
    actor,
}) {
    let record = null;
    if (attendanceId && mongoose.Types.ObjectId.isValid(attendanceId)) {
        record = await Attendance.findById(attendanceId);
    } else if (isValidDateKey(date) && employeeMongoId) {
        record = await Attendance.findOne({ date, employeeMongoId: String(employeeMongoId) });
    }

    if (!record) {
        return { ok: false, status: 404, message: 'Attendance record not found.' };
    }
    if (record.leaveRequestStatus !== 'pending') {
        return { ok: false, status: 400, message: 'No pending leave request for this day.' };
    }

    const allowed = await isEmployeeInTeamTree(actor._id, record.employeeMongoId);
    if (!allowed) {
        return {
            ok: false,
            status: 403,
            message: 'You can only decide leave requests for your team.',
        };
    }

    const subject = await EmployeeBasic.findById(record.employeeMongoId)
        .select('_id employeeId firstName lastName companyEmail workEmail email primaryReportee')
        .lean();

    const requestedKey = String(record.requestedStatusKey || '').trim();
    const requestedLabel =
        record.requestedStatusLabel || leaveStatusLabel(requestedKey);
    const kind = String(record.leaveRequestKind || '');

    if (decision === 'approved') {
        if (kind === 'yellow' || requestedKey === 'on_office') {
            record.statusKey = 'on_office';
            record.statusLabel = 'Present';
            record.approvalStatus = 'approved';
            if (!String(record.timeOut || '').trim()) {
                record.timeOut = String(record.timeIn || '').trim() || '18:00:00';
            }
            if (record.leaveRequestReason) {
                record.reason = record.leaveRequestReason;
            }
        } else if (kind === 'future_leave') {
            record.statusKey = 'authorized_leave';
            record.statusLabel = 'Authorized Leave';
            record.approvalStatus = 'approved';
            if (record.leaveRequestReason) record.reason = record.leaveRequestReason;
        } else if (kind === 'future_late') {
            record.statusKey = 'late_arrived';
            record.statusLabel = 'Late arrival approved';
            record.approvalStatus = 'approved';
            if (record.leaveRequestReason) record.reason = record.leaveRequestReason;
        } else if (kind === 'future_early') {
            record.statusKey = 'early_go';
            record.statusLabel = 'Early go approved';
            record.approvalStatus = 'approved';
            if (record.leaveRequestReason) record.reason = record.leaveRequestReason;
        } else {
            const chosenKey = String(approvedStatusKey || '').trim() || requestedKey;
            if (!REPORTEE_APPROVE_LEAVE_KEYS.has(chosenKey)) {
                return {
                    ok: false,
                    status: 400,
                    message: 'Choose Authorized, Sick, or Unauthorized leave before approving.',
                };
            }
            record.statusKey = chosenKey;
            record.statusLabel = leaveStatusLabel(chosenKey);
            record.approvalStatus = 'approved';
            if (record.leaveRequestReason && !record.reason) {
                record.reason = record.leaveRequestReason;
            }
        }
    }

    if (
        decision === 'rejected' &&
        kind.startsWith('future_') &&
        (!record.timeIn || record.previousStatusKey === 'not_marked')
    ) {
        const recordId = record._id;
        const dateKey = record.date;
        await Attendance.deleteOne({ _id: recordId });
        await syncDashboardAction({
            requestId: recordId,
            requestType: 'Attendance Leave Request',
            assignedTo: actor._id,
            status: 'Rejected',
            subjectEmployee: subject || {
                _id: record.employeeMongoId,
                employeeId: record.employeeId,
                firstName: record.employeeName,
            },
            actionedBy: actor._id,
            extra1: dateKey,
            extra2: requestedLabel,
        });
        if (subject) {
            await sendAttendanceLeaveDecisionEmail({
                employee: subject,
                date: dateKey,
                decision,
                requestedLabel,
                finalLabel: 'Upcoming',
            });
        }
        return { ok: true, record: null };
    }

    record.leaveRequestStatus = decision;
    record.leaveDecidedAt = new Date();
    record.leaveDecidedBy = actor._id;
    await record.save();

    await syncDashboardAction({
        requestId: record._id,
        requestType: 'Attendance Leave Request',
        assignedTo: actor._id,
        status: decision === 'approved' ? 'Approved' : 'Rejected',
        subjectEmployee: subject || {
            _id: record.employeeMongoId,
            employeeId: record.employeeId,
            firstName: record.employeeName,
        },
        actionedBy: actor._id,
        extra1: record.date,
        extra2: requestedLabel,
    });

    if (subject) {
        await sendAttendanceLeaveDecisionEmail({
            employee: subject,
            date: record.date,
            decision,
            requestedLabel,
            finalLabel: record.statusLabel || leaveStatusLabel(record.statusKey),
        });
    }

    return { ok: true, record };
}
