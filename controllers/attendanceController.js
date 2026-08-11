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
    if (req.user?.employeeObjectId) {
        employee = await EmployeeBasic.findById(req.user.employeeObjectId)
            .select('_id employeeId firstName lastName')
            .lean();
    }
    if (!employee && req.user?.employeeId) {
        employee = await EmployeeBasic.findOne({ employeeId: req.user.employeeId })
            .select('_id employeeId firstName lastName')
            .lean();
    }
    if (!employee && req.user?.companyEmail) {
        employee = await EmployeeBasic.findOne({ companyEmail: req.user.companyEmail })
            .select('_id employeeId firstName lastName')
            .lean();
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

        const leaveKeys = new Set(['on_leave', 'sick_leave', 'unauthorized_leave']);
        if (existing && leaveKeys.has(existing.statusKey)) {
            return res.status(400).json({
                message: 'Cannot check in — leave is already marked for today.',
                record: existing,
            });
        }

        const doc = await Attendance.findOneAndUpdate(
            { date, employeeMongoId },
            {
                $set: {
                    date,
                    employeeMongoId,
                    employeeId: String(employee.employeeId || ''),
                    employeeName,
                    statusKey: 'on_office',
                    statusLabel: 'On office',
                    timeIn,
                    timeOut: existing?.timeOut || '',
                    reason: existing?.reason || '',
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
        if (!existing.statusKey || existing.statusKey === 'not_marked') {
            existing.statusKey = 'on_office';
            existing.statusLabel = 'On office';
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
        if (!ATTENDANCE_STATUS_KEYS.includes(statusKey) || !statusLabel) {
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
            message: 'Team attendance marked successfully',
            date,
            count: saved.length,
            records: saved,
        });
    } catch (error) {
        console.error('[markTeamAttendance]', error);
        return res.status(500).json({ message: error.message || 'Failed to mark team attendance.' });
    }
}
