import Attendance from '../models/Attendance.js';
import AttendanceDay from '../models/AttendanceDay.js';
import {
    getCalendarPartsInTz,
    getScheduledEmailTimeZone,
    zonedWallTimeToUtc,
} from './scheduleDailyAtMidnight.js';

function formatDateKey({ year, month, day }) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftCalendarDay(parts, deltaDays) {
    const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays, 12, 0, 0));
    return getCalendarPartsInTz(probe, getScheduledEmailTimeZone());
}

/**
 * Daily attendance routine (runs at Asia/Dubai midnight):
 * 1) Close previous calendar day.
 * 2) Auto-mark check-in without check-out as mispunched → Unauthorized.
 * 3) Open the new day empty — timers reset on the client.
 */
export async function processAttendanceDailyRoutine() {
    const timeZone = getScheduledEmailTimeZone();
    const todayParts = getCalendarPartsInTz(new Date(), timeZone);
    const yesterdayParts = shiftCalendarDay(todayParts, -1);

    const todayKey = formatDateKey(todayParts);
    const yesterdayKey = formatDateKey(yesterdayParts);
    const now = new Date();

    // Forgot check-out → mispunched / Unauthorized for the closed day
    const mispunchResult = await Attendance.updateMany(
        {
            date: yesterdayKey,
            timeIn: { $exists: true, $nin: ['', null] },
            $or: [{ timeOut: '' }, { timeOut: null }, { timeOut: { $exists: false } }],
        },
        {
            $set: {
                statusKey: 'unauthorized_leave',
                statusLabel: 'Unauthorized',
                reason: 'Mispunched — forgot to check out (auto at midnight)',
            },
        },
    );

    // Checked out days → Present
    await Attendance.updateMany(
        {
            date: yesterdayKey,
            timeIn: { $exists: true, $nin: ['', null] },
            timeOut: { $exists: true, $nin: ['', null] },
            statusKey: { $in: ['not_marked', 'checked_in', ''] },
        },
        {
            $set: {
                statusKey: 'on_office',
                statusLabel: 'On work',
            },
        },
    );

    const yesterdayMarkedCount = await Attendance.countDocuments({ date: yesterdayKey });

    await AttendanceDay.findOneAndUpdate(
        { date: yesterdayKey },
        {
            $set: {
                date: yesterdayKey,
                status: 'closed',
                closedAt: now,
                markedCount: yesterdayMarkedCount,
                note: `Closed at midnight — mispunched without checkout: ${mispunchResult.modifiedCount || 0}.`,
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

    // New day starts empty: do not create / copy employee marks.
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

    console.log(
        `[AttendanceDailyRoutine] ${timeZone} rollover — closed ${yesterdayKey} (marks=${yesterdayMarkedCount}, mispunched=${mispunchResult.modifiedCount || 0}), opened ${todayKey} empty`,
    );

    return {
        timeZone,
        closedDate: yesterdayKey,
        openedDate: todayKey,
        closedMarkedCount: yesterdayMarkedCount,
        mispunchedCount: mispunchResult.modifiedCount || 0,
    };
}
