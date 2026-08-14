import WorkingTime from '../models/WorkingTime.js';
import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Holiday from '../models/Holiday.js';

export const WEEKDAY_KEYS = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
];

export function normalizeStaffType(value) {
    return String(value || '').trim().toLowerCase() === 'site' ? 'site' : 'office';
}

export function weekdayKeyFromDateKey(dateKey) {
    const date = String(dateKey || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    // Noon UTC keeps the calendar day stable for Asia/Dubai (UTC+4).
    const dayIndex = new Date(`${date}T12:00:00.000Z`).getUTCDay();
    return WEEKDAY_KEYS[dayIndex] || null;
}

function defaultDay(isWeekend) {
    return {
        isOffDay: Boolean(isWeekend),
        startHour: '09',
        startMinute: '00',
        startMeridiem: 'AM',
        endHour: '06',
        endMinute: '00',
        endMeridiem: 'PM',
    };
}

export function defaultWeek() {
    return {
        monday: defaultDay(false),
        tuesday: defaultDay(false),
        wednesday: defaultDay(false),
        thursday: defaultDay(false),
        friday: defaultDay(false),
        saturday: defaultDay(true),
        sunday: defaultDay(true),
    };
}

export function getOffWeekdayKeys(week) {
    const source = week && typeof week === 'object' ? week : defaultWeek();
    return WEEKDAY_KEYS.filter((key) => Boolean(source?.[key]?.isOffDay));
}

export function isWeekOffForStaff(week, dateKey) {
    const dayKey = weekdayKeyFromDateKey(dateKey);
    if (!dayKey) return false;
    const source = week && typeof week === 'object' ? week : defaultWeek();
    return Boolean(source?.[dayKey]?.isOffDay);
}

/** Parse HH:mm or HH:mm:ss → minutes since midnight (or null). */
export function clockTimeToMinutes(clock) {
    if (clock == null || clock === '') return null;
    const parts = String(clock)
        .trim()
        .split(':')
        .map((n) => Number(n));
    if (parts.length < 2 || parts.slice(0, 2).some((n) => Number.isNaN(n))) return null;
    const [h, m] = parts;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
}

/** Convert Flowchart WorkingTime day start/end (12h + meridiem) → minutes since midnight. */
export function dayScheduleToMinutes(day, which = 'start') {
    if (!day || typeof day !== 'object') return null;
    const isStart = which !== 'end';
    let hour = Number(isStart ? day.startHour : day.endHour);
    let minute = Number(isStart ? day.startMinute : day.endMinute);
    const meridiem = String(isStart ? day.startMeridiem : day.endMeridiem || 'AM')
        .trim()
        .toUpperCase();
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    if (meridiem === 'AM') {
        if (hour === 12) hour = 0;
    } else if (meridiem === 'PM') {
        if (hour !== 12) hour += 12;
    }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
}

/** Scheduled punch-in / punch-out minutes for a staff week + date (yyyy-MM-dd). */
export function getScheduledPunchMinutes(week, dateKey) {
    const dayKey = weekdayKeyFromDateKey(dateKey);
    if (!dayKey) return { startMinutes: null, endMinutes: null, isOffDay: false };
    const source = week && typeof week === 'object' ? week : defaultWeek();
    const day = source?.[dayKey] || null;
    return {
        startMinutes: dayScheduleToMinutes(day, 'start'),
        endMinutes: dayScheduleToMinutes(day, 'end'),
        isOffDay: Boolean(day?.isOffDay),
    };
}

const PUNCH_RULE_SKIP_KEYS = new Set([
    'on_leave',
    'sick_leave',
    'authorized_leave',
    'unauthorized_leave',
    'holiday',
    'weekly_off',
    'mispunch',
]);

/**
 * Apply Flowchart HR Working Time punch rules (15-min grace / early go)
 * when timeIn/timeOut are present. Leave/holiday marks are left unchanged.
 */
export function resolveStatusFromPunches({
    timeIn,
    timeOut,
    startMinutes,
    endMinutes,
    isOffDay = false,
    baseStatusKey = 'on_office',
    baseStatusLabel = 'On work',
    baseReason = '',
} = {}) {
    const key = String(baseStatusKey || '').trim();
    if (PUNCH_RULE_SKIP_KEYS.has(key)) {
        return {
            statusKey: key,
            statusLabel: baseStatusLabel,
            reason: baseReason,
        };
    }

    const actualIn = clockTimeToMinutes(timeIn);
    const actualOut = clockTimeToMinutes(timeOut);
    let late = false;
    let lateMinutes = 0;
    let earlyGo = false;

    if (!isOffDay && startMinutes != null && actualIn != null) {
        const graceLimit = startMinutes + 15;
        if (actualIn > graceLimit) {
            late = true;
            // Minutes past grace (09:16 with 09:00 schedule → 1 minute late)
            lateMinutes = actualIn - graceLimit;
        }
    }
    if (!isOffDay && endMinutes != null && actualOut != null && actualOut < endMinutes) {
        earlyGo = true;
    }

    const lateReason = late
        ? `${lateMinutes} minute${lateMinutes === 1 ? '' : 's'} late`
        : '';

    if (actualIn != null && actualOut != null) {
        if (earlyGo) {
            return {
                statusKey: 'early_go',
                statusLabel: 'Early Go',
                reason: lateReason ? `${lateReason}; Early go` : 'Punched out before scheduled punch-out',
            };
        }
        if (late) {
            return {
                statusKey: 'late_arrived',
                statusLabel: 'Late Arrival',
                reason: lateReason,
            };
        }
        if (key === 'work_from_home') {
            return {
                statusKey: 'work_from_home',
                statusLabel: baseStatusLabel || 'Work from home',
                reason: '',
            };
        }
        return {
            statusKey: 'on_office',
            statusLabel: 'On work',
            reason: '',
        };
    }

    if (actualIn != null && actualOut == null) {
        if (late) {
            return {
                statusKey: 'late_arrived',
                statusLabel: 'Late Arrival',
                reason: lateReason,
            };
        }
        return {
            statusKey: 'not_marked',
            statusLabel: 'On time',
            reason: '',
        };
    }

    return {
        statusKey: key || 'on_office',
        statusLabel: baseStatusLabel || 'On work',
        reason: baseReason,
    };
}

export async function loadWorkingTimeDoc() {
    let doc = await WorkingTime.findOne({ key: 'default' }).lean();
    if (!doc) {
        const created = await WorkingTime.create({
            key: 'default',
            site: defaultWeek(),
            office: defaultWeek(),
        });
        doc = created.toObject();
    }
    return {
        site: doc.site && typeof doc.site === 'object' ? doc.site : defaultWeek(),
        office: doc.office && typeof doc.office === 'object' ? doc.office : defaultWeek(),
    };
}

async function getActiveEmployeesByStaffType(staffType) {
    const wanted = normalizeStaffType(staffType);
    const filter = { profileStatus: 'active' };
    if (wanted === 'site') {
        filter.staffType = 'site';
    } else {
        filter.$or = [
            { staffType: 'office' },
            { staffType: { $exists: false } },
            { staffType: null },
            { staffType: '' },
        ];
    }
    return EmployeeBasic.find(filter)
        .select('_id employeeId firstName lastName staffType')
        .lean();
}

function eachDateKey(from, to) {
    const keys = [];
    const start = new Date(`${from}T12:00:00.000Z`);
    const end = new Date(`${to}T12:00:00.000Z`);
    for (let cursor = start; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        keys.push(cursor.toISOString().slice(0, 10));
    }
    return keys;
}

/**
 * Upsert weekly-off attendance for Site/Office staff from WorkingTime.
 * - Does not overwrite real marks (present, leave, UAE holiday, etc.)
 * - Removes stale weekly_off marks when a weekday is no longer an off day
 * Repeats every matching weekday until the schedule changes.
 */
export async function syncWeeklyOffAttendanceMarks({
    from,
    to,
    siteWeek,
    officeWeek,
    updatedBy = null,
} = {}) {
    const workingTime =
        siteWeek && officeWeek
            ? { site: siteWeek, office: officeWeek }
            : await loadWorkingTimeDoc();

    const fromKey = String(from || '').trim();
    const toKey = String(to || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey) || fromKey > toKey) {
        return { upserted: 0, cleared: 0 };
    }

    const holidayDates = new Set(
        (
            await Holiday.find({
                date: { $gte: fromKey, $lte: toKey },
            })
                .select('date')
                .lean()
        ).map((h) => h.date),
    );

    const [siteEmployees, officeEmployees] = await Promise.all([
        getActiveEmployeesByStaffType('site'),
        getActiveEmployeesByStaffType('office'),
    ]);

    const groups = [
        { staffType: 'site', week: workingTime.site, employees: siteEmployees },
        { staffType: 'office', week: workingTime.office, employees: officeEmployees },
    ];

    const dateKeys = eachDateKey(fromKey, toKey);
    let upserted = 0;
    let cleared = 0;

    for (const group of groups) {
        const offWeekdays = new Set(getOffWeekdayKeys(group.week));
        if (!group.employees.length) continue;

        const employeeIds = group.employees.map((e) => String(e._id));
        const offDates = dateKeys.filter((dateKey) => {
            const dayKey = weekdayKeyFromDateKey(dateKey);
            return dayKey && offWeekdays.has(dayKey) && !holidayDates.has(dateKey);
        });
        const clearDates = dateKeys.filter((dateKey) => {
            const dayKey = weekdayKeyFromDateKey(dateKey);
            const isOff = dayKey ? offWeekdays.has(dayKey) : false;
            return !isOff || holidayDates.has(dateKey);
        });

        if (offDates.length) {
            const existing = await Attendance.find({
                date: { $in: offDates },
                employeeMongoId: { $in: employeeIds },
            })
                .select('date employeeMongoId statusKey')
                .lean();

            const existingMap = new Map(
                existing.map((r) => [`${r.date}::${r.employeeMongoId}`, r.statusKey]),
            );

            const bulk = [];
            for (const dateKey of offDates) {
                for (const emp of group.employees) {
                    const employeeMongoId = String(emp._id);
                    const statusKey = existingMap.get(`${dateKey}::${employeeMongoId}`);
                    if (statusKey && statusKey !== 'weekly_off') continue;

                    const employeeName = [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim();
                    bulk.push({
                        updateOne: {
                            filter: { date: dateKey, employeeMongoId },
                            update: {
                                $set: {
                                    date: dateKey,
                                    employeeMongoId,
                                    employeeId: String(emp.employeeId || ''),
                                    employeeName,
                                    statusKey: 'weekly_off',
                                    statusLabel: 'Off Day',
                                    reason: `Weekly off — ${group.staffType === 'site' ? 'Site' : 'Office'} schedule`,
                                    timeIn: '',
                                    timeOut: '',
                                    attachmentName: '',
                                    markedBy: updatedBy || null,
                                },
                            },
                            upsert: true,
                        },
                    });
                }
            }

            if (bulk.length) {
                const result = await Attendance.bulkWrite(bulk, { ordered: false });
                upserted += (result.upsertedCount || 0) + (result.modifiedCount || 0);
            }
        }

        if (clearDates.length) {
            const result = await Attendance.deleteMany({
                date: { $in: clearDates },
                employeeMongoId: { $in: employeeIds },
                statusKey: 'weekly_off',
            });
            cleared += result.deletedCount || 0;
        }
    }

    return { upserted, cleared };
}

/** Sync from today through ~6 months ahead (Asia/Dubai date keys expected). */
export async function syncWeeklyOffFromToday(options = {}) {
    const today =
        String(options.from || '').trim() ||
        new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Dubai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date());

    const start = new Date(`${today}T12:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 180);
    const to = end.toISOString().slice(0, 10);

    return syncWeeklyOffAttendanceMarks({
        from: today,
        to,
        siteWeek: options.siteWeek,
        officeWeek: options.officeWeek,
        updatedBy: options.updatedBy || null,
    });
}

/** Apply weekly offs for a single date (daily midnight routine). */
export async function applyWeeklyOffForDate(dateKey, updatedBy = null) {
    const key = String(dateKey || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
        return { upserted: 0, cleared: 0 };
    }
    return syncWeeklyOffAttendanceMarks({ from: key, to: key, updatedBy });
}
