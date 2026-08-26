import Attendance from '../models/Attendance.js';
import AttendanceDay from '../models/AttendanceDay.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Holiday from '../models/Holiday.js';
import {
    getCalendarPartsInTz,
    getScheduledEmailTimeZone,
    zonedWallTimeToUtc,
} from './scheduleDailyAtMidnight.js';
import {
    applyWeeklyOffForDate,
    isWeekOffForStaff,
    holidayAppliesToStaff,
    loadWorkingTimeDoc,
    normalizeStaffType,
    getWeekForStaffType,
} from './workingTimeHelpers.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from './attendanceEmployeeFilters.js';

function formatDateKey({ year, month, day }) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftCalendarDay(parts, deltaDays) {
    const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays, 12, 0, 0));
    return getCalendarPartsInTz(probe, getScheduledEmailTimeZone());
}

function hasPunch(value) {
    return Boolean(value != null && String(value).trim());
}

const PROTECTED_NO_PUNCH_KEYS = new Set([
    'holiday',
    'weekly_off',
    'on_leave',
    'sick_leave',
    'compoff_leave',
    'authorized_leave',
    'work_from_home',
]);

/**
 * Daily attendance routine (runs at Asia/Dubai midnight):
 * Checks PREVIOUS DAY ONLY — never the new day for yesterday's status.
 * 1) Punch-In YES + Punch-Out YES → finalize normally (keep Late / Early Go).
 * 2) Punch-In YES + Punch-Out NO → MISPUNCHED (timer ends with the day).
 * 3) Punch-In NO + Punch-Out NO → UNAUTHORIZED LEAVE (red).
 * 4) Open new day empty; apply weekly offs for today.
 */
export async function processAttendanceDailyRoutine() {
    const timeZone = getScheduledEmailTimeZone();
    const todayParts = getCalendarPartsInTz(new Date(), timeZone);
    const yesterdayParts = shiftCalendarDay(todayParts, -1);

    const todayKey = formatDateKey(todayParts);
    const yesterdayKey = formatDateKey(yesterdayParts);
    const now = new Date();

    // Drop any attendance rows wrongly created for company shell accounts
    try {
        const companyShells = await EmployeeBasic.find({
            lastName: /^\(company\)$/i,
        })
            .select('_id')
            .lean();
        const companyIds = (companyShells || []).map((e) => String(e._id));
        if (companyIds.length) {
            await Attendance.deleteMany({ employeeMongoId: { $in: companyIds } });
        }
        await Attendance.deleteMany({ employeeName: /\(company\)\s*$/i });
    } catch (err) {
        console.warn('[AttendanceDailyRoutine] company shell cleanup failed:', err?.message || err);
    }

    // 1) Previous day: check-in without check-out → MISPUNCHED
    const mispunchResult = await Attendance.updateMany(
        {
            date: yesterdayKey,
            timeIn: { $exists: true, $nin: ['', null] },
            $or: [{ timeOut: '' }, { timeOut: null }, { timeOut: { $exists: false } }],
            statusKey: { $nin: ['holiday', 'weekly_off'] },
        },
        {
            $set: {
                statusKey: 'mispunch',
                statusLabel: 'Mispunched',
                reason: 'Mispunched — forgot to check out (auto at midnight)',
                approvalStatus: 'pending',
            },
        },
    );

    // 2) Previous day: both punches → finalize provisional rows (do not overwrite Late / Early Go)
    await Attendance.updateMany(
        {
            date: yesterdayKey,
            timeIn: { $exists: true, $nin: ['', null] },
            timeOut: { $exists: true, $nin: ['', null] },
            statusKey: { $in: ['not_marked', ''] },
        },
        {
            $set: {
                statusKey: 'on_office',
                statusLabel: 'On work',
            },
        },
    );

    // 3) Previous day: no punch-in and no punch-out → UNAUTHORIZED LEAVE (red)
    let unauthorizedCount = 0;
    try {
        const [workingTime, holidayDoc, activeEmployees, yesterdayRecords] = await Promise.all([
            loadWorkingTimeDoc(),
            Holiday.findOne({ date: yesterdayKey }).select('_id date name appliesTo').lean(),
            EmployeeBasic.find({
                profileStatus: 'active',
                status: { $ne: 'Left User' },
                ...REAL_EMPLOYEE_MONGO_FILTER,
            })
                .select('_id employeeId firstName lastName staffType')
                .lean(),
            Attendance.find({ date: yesterdayKey }).lean(),
        ]);

        const isHoliday = Boolean(holidayDoc);
        const byEmp = new Map(
            (yesterdayRecords || []).map((r) => [String(r.employeeMongoId), r]),
        );
        const bulk = [];

        for (const emp of activeEmployees || []) {
            if (isCompanyShellEmployee(emp)) continue;
            const employeeMongoId = String(emp._id);
            const staffType = normalizeStaffType(emp.staffType);
            const week = getWeekForStaffType(workingTime, staffType);

            if ((isHoliday && holidayAppliesToStaff(holidayDoc, staffType)) || isWeekOffForStaff(week, yesterdayKey)) {
                continue;
            }

            const rec = byEmp.get(employeeMongoId);
            if (rec && PROTECTED_NO_PUNCH_KEYS.has(String(rec.statusKey || ''))) {
                continue;
            }

            const punchedIn = hasPunch(rec?.timeIn);
            const punchedOut = hasPunch(rec?.timeOut);
            if (punchedIn || punchedOut) {
                continue;
            }

            const employeeName = [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim();
            bulk.push({
                updateOne: {
                    filter: { date: yesterdayKey, employeeMongoId },
                    update: {
                        $set: {
                            date: yesterdayKey,
                            employeeMongoId,
                            employeeId: String(emp.employeeId || ''),
                            employeeName,
                            statusKey: 'unauthorized_leave',
                            statusLabel: 'Unauthorized Leave',
                            reason: 'No punch-in or punch-out (auto at midnight)',
                            timeIn: '',
                            timeOut: '',
                            attachmentName: '',
                            approvalStatus: 'pending',
                        },
                    },
                    upsert: true,
                },
            });
        }

        if (bulk.length) {
            const result = await Attendance.bulkWrite(bulk, { ordered: false });
            unauthorizedCount =
                (result.upsertedCount || 0) + (result.modifiedCount || 0) + (result.nUpserted || 0);
        }
    } catch (err) {
        console.error('[AttendanceDailyRoutine] unauthorized leave apply failed:', err);
    }

    const yesterdayMarkedCount = await Attendance.countDocuments({ date: yesterdayKey });

    await AttendanceDay.findOneAndUpdate(
        { date: yesterdayKey },
        {
            $set: {
                date: yesterdayKey,
                status: 'closed',
                closedAt: now,
                markedCount: yesterdayMarkedCount,
                note: `Closed at midnight — mispunched=${mispunchResult.modifiedCount || 0}, unauthorized=${unauthorizedCount}.`,
            },
            $setOnInsert: {
                openedAt: zonedWallTimeToUtc(
                    { ...yesterdayParts, hour: 0, minute: 0, second: 0 },
                    timeZone,
                ),
            },
        },
        { upsert: true, new: true },
    );

    // New day starts empty — previous day timer must not continue.
    await AttendanceDay.findOneAndUpdate(
        { date: todayKey },
        {
            $set: {
                date: todayKey,
                status: 'open',
                openedAt: now,
                closedAt: null,
                markedCount: 0,
                note: 'Opened at midnight — status empty until attendance is marked.',
            },
        },
        { upsert: true, new: true },
    );

    let weeklyOffSync = { upserted: 0, cleared: 0 };
    try {
        weeklyOffSync = await applyWeeklyOffForDate(todayKey);
    } catch (err) {
        console.error('[AttendanceDailyRoutine] weekly-off apply failed:', err);
    }

    console.log(
        `[AttendanceDailyRoutine] ${timeZone} rollover — closed ${yesterdayKey} only (marks=${yesterdayMarkedCount}, mispunched=${mispunchResult.modifiedCount || 0}, unauthorized=${unauthorizedCount}), opened ${todayKey} empty, weeklyOff=${weeklyOffSync.upserted || 0}`,
    );

    return {
        timeZone,
        closedDate: yesterdayKey,
        openedDate: todayKey,
        closedMarkedCount: yesterdayMarkedCount,
        mispunchedCount: mispunchResult.modifiedCount || 0,
        unauthorizedCount,
        weeklyOffSync,
    };
}
