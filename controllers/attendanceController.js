import mongoose from 'mongoose';
import Attendance, { ATTENDANCE_STATUS_KEYS } from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getScheduledEmailTimeZone, getZonedParts } from '../utils/scheduleDailyAtMidnight.js';

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

/** Exact local clock time HH:mm:ss in company TZ */
function getDubaiClockTime(date = new Date()) {
    const p = getZonedParts(date, getScheduledEmailTimeZone());
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

async function resolveLinkedEmployee(req) {
    let employee = null;

    const selectFields = '_id employeeId firstName lastName companyEmail workEmail email';

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
function buildDayStatsFromRecords(records, totalStaff = 0) {
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
    };

    for (const row of rows) {
        const key = String(row?.statusKey || '').trim();
        if (Object.prototype.hasOwnProperty.call(counts, key)) {
            counts[key] += 1;
        }
    }

    const markedCount = rows.length;
    const implicitNotMarked = Math.max(0, totalStaff - markedCount);
    const notMarked = counts.not_marked + counts.unauthorized_leave + implicitNotMarked;
    const authorizedLeaveTotal = counts.on_leave + counts.authorized_leave;

    return {
        activeEmployees: totalStaff,
        present: counts.on_office,
        onLeave: authorizedLeaveTotal,
        lateArrived: counts.late_arrived,
        sickLeave: counts.sick_leave,
        workFromHome: counts.work_from_home,
        notMarked,
        officePresent: counts.on_office,
        officeTotal: totalStaff,
        sitePresent: 0,
        siteTotal: 0,
        totalPresent: counts.on_office,
        absentAuthorized: authorizedLeaveTotal,
        // Same value as notMarked — unauthorized and not marked are one category.
        absentUnauthorized: notMarked,
    };
}

function resolveStaffTypeFilter(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'site') return 'site';
    if (value === 'office') return 'office';
    return null;
}

async function getActiveEmployeeIdsByStaffType(staffType) {
    const filter = { profileStatus: 'active' };
    if (staffType === 'site') {
        filter.staffType = 'site';
    } else if (staffType === 'office') {
        // Default missing staffType to office so existing employees stay on Office tab.
        filter.$or = [{ staffType: 'office' }, { staffType: { $exists: false } }, { staffType: null }, { staffType: '' }];
    }
    const rows = await EmployeeBasic.find(filter).select('_id').lean();
    return rows.map((r) => String(r._id));
}

async function countActiveEmployees(staffType = null) {
    if (!staffType) {
        return EmployeeBasic.countDocuments({ profileStatus: 'active' });
    }
    const ids = await getActiveEmployeeIdsByStaffType(staffType);
    return ids.length;
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

        const records = await Attendance.find({ date }).sort({ employeeName: 1 }).lean();
        return res.status(200).json({
            message: 'Attendance fetched successfully',
            date,
            records,
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

        const [staffIds, totalStaff, records] = await Promise.all([
            staffType ? getActiveEmployeeIdsByStaffType(staffType) : Promise.resolve(null),
            countActiveEmployees(staffType),
            Attendance.find({ date: { $gte: from, $lte: to } }).lean(),
        ]);

        const staffIdSet = staffIds ? new Set(staffIds) : null;

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
            const stats =
                dayRecords.length > 0
                    ? buildDayStatsFromRecords(dayRecords, totalStaff)
                    : emptyDayStats(totalStaff);

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

            const doc = await Attendance.findOneAndUpdate(
                { date, employeeMongoId },
                {
                    $set: {
                        date,
                        employeeMongoId,
                        employeeId: String(raw?.employeeId || raw?.empNo || '').trim(),
                        employeeName: String(raw?.employeeName || raw?.name || '').trim(),
                        statusKey,
                        statusLabel,
                        timeIn,
                        timeOut,
                        reason: String(raw?.reason || '').trim(),
                        attachmentName: String(raw?.attachmentName || '').trim(),
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
                .select('_id employeeId firstName lastName')
                .lean();
            if (!target) {
                return res.status(404).json({ message: 'Employee not found.' });
            }
            employee = target;
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

        const records = await Attendance.find({
            employeeMongoId,
            date: { $gte: from, $lte: to },
        }).lean();

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
            },
            records,
            todayRecord,
        });
    } catch (error) {
        console.error('[getMyAttendanceMonth]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch attendance.' });
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
        .select('_id employeeId firstName lastName')
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
                    // Present only after check-out; provisional until then.
                    statusKey: 'not_marked',
                    statusLabel: 'Checked in',
                    timeIn,
                    timeOut: '',
                    reason: '',
                    attachmentName: existing?.attachmentName || '',
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
        // Complete day → Present (On work)
        existing.statusKey = 'on_office';
        existing.statusLabel = 'On work';
        if (String(existing.reason || '').toLowerCase().includes('mispunch')) {
            existing.reason = '';
        }
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
                .select('_id employeeId firstName lastName')
                .lean();
            if (!emp) continue;

            const doc = await Attendance.findOneAndUpdate(
                { date, employeeMongoId },
                {
                    $set: {
                        date,
                        employeeMongoId,
                        employeeId: String(emp.employeeId || ''),
                        employeeName: [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim(),
                        statusKey,
                        statusLabel,
                        timeIn,
                        timeOut,
                        reason,
                        attachmentName,
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
