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
 * 1) Close previous calendar day — marks already stored in Attendance stay as-is.
 * 2) Open the new day empty — no statuses are copied forward; users mark again.
 */
export async function processAttendanceDailyRoutine() {
    const timeZone = getScheduledEmailTimeZone();
    const todayParts = getCalendarPartsInTz(new Date(), timeZone);
    const yesterdayParts = shiftCalendarDay(todayParts, -1);

    const todayKey = formatDateKey(todayParts);
    const yesterdayKey = formatDateKey(yesterdayParts);
    const now = new Date();

    const yesterdayMarkedCount = await Attendance.countDocuments({ date: yesterdayKey });

    await AttendanceDay.findOneAndUpdate(
        { date: yesterdayKey },
        {
            $set: {
                date: yesterdayKey,
                status: 'closed',
                closedAt: now,
                markedCount: yesterdayMarkedCount,
                note: 'Closed at midnight — marks remain stored for this date.',
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
    // Any accidental same-day leftover would only exist if users marked today already.
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
        `[AttendanceDailyRoutine] ${timeZone} rollover complete — closed ${yesterdayKey} (marks=${yesterdayMarkedCount}), opened ${todayKey} empty`,
    );

    return {
        timeZone,
        closedDate: yesterdayKey,
        openedDate: todayKey,
        closedMarkedCount: yesterdayMarkedCount,
    };
}
