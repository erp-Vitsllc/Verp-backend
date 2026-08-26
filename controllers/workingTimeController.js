import WorkingTime from '../models/WorkingTime.js';
import { syncWeeklyOffFromToday } from '../utils/workingTimeHelpers.js';
import { slugifyWorkLocationKey } from '../utils/workLocationHelpers.js';

const DAY_KEYS = [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
];
const MERIDIEMS = new Set(['AM', 'PM']);
const VALID_HOURS = new Set(
    Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')),
);
const VALID_MINUTES = new Set(['00', '15', '30', '45']);

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

function defaultWeek() {
    return DAY_KEYS.reduce((acc, key, index) => {
        acc[key] = defaultDay(index >= 5);
        return acc;
    }, {});
}

function sanitizeDay(raw, fallbackWeekend) {
    const base = defaultDay(fallbackWeekend);
    if (!raw || typeof raw !== 'object') return base;

    const startHour = String(raw.startHour || base.startHour).padStart(2, '0');
    const startMinute = String(raw.startMinute || base.startMinute).padStart(2, '0');
    const endHour = String(raw.endHour || base.endHour).padStart(2, '0');
    const endMinute = String(raw.endMinute || base.endMinute).padStart(2, '0');
    const startMeridiem = MERIDIEMS.has(raw.startMeridiem) ? raw.startMeridiem : base.startMeridiem;
    const endMeridiem = MERIDIEMS.has(raw.endMeridiem) ? raw.endMeridiem : base.endMeridiem;

    return {
        isOffDay: Boolean(raw.isOffDay),
        startHour: VALID_HOURS.has(startHour) ? startHour : base.startHour,
        startMinute: VALID_MINUTES.has(startMinute) ? startMinute : base.startMinute,
        startMeridiem,
        endHour: VALID_HOURS.has(endHour) ? endHour : base.endHour,
        endMinute: VALID_MINUTES.has(endMinute) ? endMinute : base.endMinute,
        endMeridiem,
    };
}

function sanitizeWeek(raw) {
    const base = defaultWeek();
    if (!raw || typeof raw !== 'object') return base;
    DAY_KEYS.forEach((key, index) => {
        base[key] = sanitizeDay(raw[key], index >= 5);
    });
    return base;
}

function sanitizeExtra(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const extra = {};
    Object.entries(raw).forEach(([key, week]) => {
        const locKey = slugifyWorkLocationKey(key);
        if (!locKey || locKey === 'office' || locKey === 'site') return;
        extra[locKey] = sanitizeWeek(week);
    });
    return extra;
}

/**
 * GET /api/WorkingTime
 */
export async function getWorkingTime(req, res) {
    try {
        let doc = await WorkingTime.findOne({ key: 'default' }).lean();
        if (!doc) {
            const created = await WorkingTime.create({
                key: 'default',
                site: defaultWeek(),
                office: defaultWeek(),
            });
            doc = created.toObject();
        }

        return res.status(200).json({
            message: 'Working time fetched successfully',
            workingTime: {
                site: sanitizeWeek(doc.site),
                office: sanitizeWeek(doc.office),
                extra: sanitizeExtra(doc.extra),
            },
        });
    } catch (error) {
        console.error('[getWorkingTime]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch working time.' });
    }
}

/**
 * PUT /api/WorkingTime
 * Body: { site: week, office: week }
 * After save, marks matching Site/Office staff weekly off days on attendance
 * (repeating every week until this schedule changes).
 */
export async function upsertWorkingTime(req, res) {
    try {
        const site = sanitizeWeek(req.body?.site);
        const office = sanitizeWeek(req.body?.office);
        const extraProvided = req.body?.extra != null;
        const extra = extraProvided ? sanitizeExtra(req.body.extra) : null;

        const setPayload = {
            site,
            office,
            updatedBy: req.user?.id || null,
        };
        if (extraProvided) setPayload.extra = extra;

        const doc = await WorkingTime.findOneAndUpdate(
            { key: 'default' },
            { $set: setPayload },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        ).lean();

        let syncResult = { upserted: 0, cleared: 0 };
        try {
            syncResult = await syncWeeklyOffFromToday({
                siteWeek: site,
                officeWeek: office,
                extra: extraProvided ? extra : sanitizeExtra(doc.extra),
                updatedBy: req.user?.id || null,
            });
        } catch (syncErr) {
            console.error('[upsertWorkingTime] weekly-off sync failed:', syncErr);
        }

        return res.status(200).json({
            message: 'Working time saved successfully',
            workingTime: {
                site: sanitizeWeek(doc.site),
                office: sanitizeWeek(doc.office),
                extra: sanitizeExtra(doc.extra),
            },
            weeklyOffSync: syncResult,
        });
    } catch (error) {
        console.error('[upsertWorkingTime]', error);
        return res.status(500).json({ message: error.message || 'Failed to save working time.' });
    }
}
