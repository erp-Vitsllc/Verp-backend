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
