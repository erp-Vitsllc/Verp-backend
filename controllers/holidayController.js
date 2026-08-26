import Holiday from '../models/Holiday.js';
import Attendance from '../models/Attendance.js';
import {
    applyWeeklyOffForDate,
    getActiveEmployeesByStaffType,
    holidayAppliesToList,
    holidayAppliesToStaff,
    isLegacyCompanyWideAppliesTo,
    resolveAppliesToInput,
} from '../utils/workingTimeHelpers.js';
import { listActiveWorkLocations } from '../utils/workLocationHelpers.js';

function isValidDateKey(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const PROTECT_FROM_HOLIDAY_OVERWRITE = new Set([
    'on_leave',
    'sick_leave',
    'compoff_leave',
    'authorized_leave',
    'unauthorized_leave',
]);

async function expandStaffTypesForHolidayMark(staffTypes) {
    const types = Array.isArray(staffTypes) && staffTypes.length ? [...staffTypes] : ['office', 'site'];
    const locations = await listActiveWorkLocations();
    const customKeys = locations
        .map((loc) => loc.key)
        .filter((key) => key !== 'office' && key !== 'site');
    if (isLegacyCompanyWideAppliesTo(types) && customKeys.length) {
        return [...new Set([...types, ...customKeys])];
    }
    return types;
}

async function markHolidayAttendance(date, name, staffTypes, markedBy) {
    const types = await expandStaffTypesForHolidayMark(staffTypes);
    let markedCount = 0;

    for (const staffType of types) {
        const employees = await getActiveEmployeesByStaffType(staffType);
        if (!employees.length) continue;

        const ids = employees.map((e) => String(e._id));
        const existing = await Attendance.find({
            date,
            employeeMongoId: { $in: ids },
        })
            .select('employeeMongoId statusKey')
            .lean();
        const skip = new Set(
            existing
                .filter((row) => PROTECT_FROM_HOLIDAY_OVERWRITE.has(String(row.statusKey || '')))
                .map((row) => String(row.employeeMongoId)),
        );

        const bulk = [];
        for (const emp of employees) {
            const employeeMongoId = String(emp._id);
            if (skip.has(employeeMongoId)) continue;
            const employeeName = [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim();
            bulk.push({
                updateOne: {
                    filter: { date, employeeMongoId },
                    update: {
                        $set: {
                            date,
                            employeeMongoId,
                            employeeId: String(emp.employeeId || ''),
                            employeeName,
                            statusKey: 'holiday',
                            statusLabel: 'Holiday',
                            reason: name,
                            markedBy: markedBy || null,
                        },
                    },
                    upsert: true,
                },
            });
        }

        if (bulk.length) {
            const result = await Attendance.bulkWrite(bulk, { ordered: false });
            markedCount += (result.upsertedCount || 0) + (result.modifiedCount || 0);
        }
    }

    return markedCount;
}

async function clearHolidayAttendance(date, staffTypes) {
    const types = await expandStaffTypesForHolidayMark(staffTypes);
    let cleared = 0;

    for (const staffType of types) {
        const employees = await getActiveEmployeesByStaffType(staffType);
        if (!employees.length) continue;
        const result = await Attendance.deleteMany({
            date,
            employeeMongoId: { $in: employees.map((e) => String(e._id)) },
            statusKey: 'holiday',
        });
        cleared += result.deletedCount || 0;
    }

    return cleared;
}

function serializeHoliday(holiday) {
    if (!holiday) return holiday;
    const appliesTo = holidayAppliesToList(holiday);
    return {
        ...holiday,
        appliesTo,
        sourceDate: holiday.sourceDate || holiday.date || '',
        isCustomDate: Boolean(holiday.isCustomDate),
    };
}

function nextDateKey(dateKey) {
    const cursor = new Date(`${dateKey}T12:00:00.000Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    return cursor.toISOString().slice(0, 10);
}

function eachDateKeyInclusive(from, to) {
    const keys = [];
    for (let cursor = from; cursor <= to; cursor = nextDateKey(cursor)) {
        keys.push(cursor);
        if (keys.length > 31) break;
    }
    return keys;
}

async function scopeLabel(types) {
    const locations = await listActiveWorkLocations();
    const labelByKey = Object.fromEntries(locations.map((loc) => [loc.key, loc.label]));
    if (!types?.length || types.length >= locations.length) return 'all work locations';
    return types.map((key) => labelByKey[key] || key).join(' and ');
}

async function upsertHolidayOnDate({
    date,
    name,
    appliesTo,
    sourceDate,
    isCustomDate,
    note,
    markedBy,
}) {
    const year = Number(date.slice(0, 4));
    const existing = await Holiday.findOne({ date }).lean();

    if (existing) {
        const current = holidayAppliesToList(existing);
        const toAdd = appliesTo.filter((t) => !current.includes(t));
        if (!toAdd.length) {
            return { status: 'exists', holiday: existing, markedCount: 0 };
        }
        const merged = [...new Set([...current, ...toAdd])];
        const holiday = await Holiday.findOneAndUpdate(
            { date },
            { $set: { appliesTo: merged } },
            { new: true },
        ).lean();
        const markedCount = await markHolidayAttendance(
            date,
            holiday.name,
            toAdd,
            markedBy,
        );
        return { status: 'merged', holiday, markedCount };
    }

    const holiday = await Holiday.create({
        date,
        name,
        year,
        appliesTo,
        sourceDate,
        isCustomDate,
        addedBy: markedBy || null,
        note,
    });
    const markedCount = await markHolidayAttendance(date, name, appliesTo, markedBy);
    return { status: 'created', holiday: holiday.toObject(), markedCount };
}

/**
 * GET /api/Holiday?year=2026&staffType=office|site
 */
export async function listHolidays(req, res) {
    try {
        const yearRaw = req.query.year;
        const filter = {};
        if (yearRaw != null && String(yearRaw).trim() !== '') {
            const year = Number(yearRaw);
            if (!Number.isFinite(year)) {
                return res.status(400).json({ message: 'Valid year is required.' });
            }
            filter.year = year;
        }

        let holidays = await Holiday.find(filter).sort({ date: 1 }).lean();
        const staffRaw = String(req.query.staffType || '').trim().toLowerCase();
        if (staffRaw) {
            holidays = holidays.filter((h) => holidayAppliesToStaff(h, staffRaw));
        }

        const list = holidays.map(serializeHoliday);
        return res.status(200).json({
            message: 'Holidays fetched successfully',
            holidays: list,
            dates: list.map((h) => h.date),
        });
    } catch (error) {
        console.error('[listHolidays]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch holidays.' });
    }
}

/**
 * POST /api/Holiday
 * Body: { date | fromDate, toDate?, name, appliesTo: 'both'|'office'|'site', sourceDate?, custom? }
 */
export async function createHoliday(req, res) {
    try {
        const fromDate = String(req.body?.fromDate || req.body?.date || '').trim();
        const toRaw = String(req.body?.toDate || '').trim();
        const toDate = isValidDateKey(toRaw) ? toRaw : fromDate;
        const name = String(req.body?.name || '').trim();
        const appliesTo = await resolveAppliesToInput(req.body?.appliesTo);
        const sourceRaw = String(req.body?.sourceDate || '').trim();
        const sourceDate = isValidDateKey(sourceRaw) ? sourceRaw : fromDate;
        const note = String(req.body?.note || '').trim();
        const markedBy = req.user?.id || null;

        if (!isValidDateKey(fromDate) || !isValidDateKey(toDate)) {
            return res.status(400).json({ message: 'Valid from and to dates (yyyy-MM-dd) are required.' });
        }
        if (toDate < fromDate) {
            return res.status(400).json({ message: 'To date must be on or after from date.' });
        }
        if (!name) {
            return res.status(400).json({ message: 'Holiday name is required.' });
        }

        const dates = eachDateKeyInclusive(fromDate, toDate);
        if (dates.length > 31) {
            return res.status(400).json({ message: 'A holiday range can be at most 31 days.' });
        }

        const created = [];
        const merged = [];
        const already = [];
        let markedCount = 0;

        for (const date of dates) {
            const isCustomDate =
                date !== sourceDate || dates.length > 1 || Boolean(req.body?.custom);
            const result = await upsertHolidayOnDate({
                date,
                name,
                appliesTo,
                sourceDate,
                isCustomDate,
                note,
                markedBy,
            });
            markedCount += result.markedCount || 0;
            if (result.status === 'created') created.push(result.holiday);
            else if (result.status === 'merged') merged.push(result.holiday);
            else already.push(result.holiday);
        }

        if (!created.length && !merged.length) {
            return res.status(400).json({
                message:
                    dates.length === 1
                        ? `This holiday date is already added for ${await scopeLabel(appliesTo)}.`
                        : `These dates are already added for ${await scopeLabel(appliesTo)}.`,
                holidays: already.map(serializeHoliday),
            });
        }

        const dayLabel = dates.length === 1 ? dates[0] : `${fromDate} to ${toDate}`;
        const status = created.length ? 201 : 200;
        const appliesLabel = await scopeLabel(appliesTo);
        return res.status(status).json({
            message: `Holiday added for ${appliesLabel} (${dayLabel}).`,
            holiday: serializeHoliday(created[0] || merged[0]),
            holidays: [...created, ...merged].map(serializeHoliday),
            markedCount,
            dayCount: dates.length,
        });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(400).json({ message: 'This holiday date is already added.' });
        }
        console.error('[createHoliday]', error);
        return res.status(500).json({ message: error.message || 'Failed to add holiday.' });
    }
}

/**
 * DELETE /api/Holiday/:date?appliesTo=office|site|both
 * Remove the holiday for the given group. The other group keeps the day as holiday.
 */
export async function deleteHoliday(req, res) {
    try {
        const date = String(req.params.date || '').trim();
        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'Valid date (yyyy-MM-dd) is required.' });
        }

        const scope = await resolveAppliesToInput(req.query.appliesTo || req.body?.appliesTo, {
            emptyMeansAll: false,
        });
        if (!scope.length) {
            return res.status(400).json({ message: 'Work location group is required.' });
        }
        const existing = await Holiday.findOne({ date }).lean();
        if (!existing) {
            return res.status(404).json({ message: 'Holiday not found.' });
        }

        const currentRaw = holidayAppliesToList(existing);
        const locations = await listActiveWorkLocations();
        const current = isLegacyCompanyWideAppliesTo(currentRaw)
            ? locations.map((loc) => loc.key)
            : currentRaw;
        const removing = scope.filter((t) => current.includes(t));
        if (!removing.length) {
            return res.status(400).json({
                message: 'This holiday is not assigned to that group.',
                holiday: serializeHoliday(existing),
            });
        }

        const remaining = current.filter((t) => !removing.includes(t));
        await clearHolidayAttendance(date, removing);

        let holiday = existing;
        if (!remaining.length) {
            await Holiday.findOneAndDelete({ date });
            holiday = null;
        } else {
            holiday = await Holiday.findOneAndUpdate(
                { date },
                { $set: { appliesTo: remaining } },
                { new: true },
            ).lean();
        }

        try {
            await applyWeeklyOffForDate(date, req.user?.id || null);
        } catch (syncErr) {
            console.error('[deleteHoliday] weekly-off restore failed:', syncErr);
        }

        const removedLabel = await scopeLabel(removing);
        return res.status(200).json({
            message: remaining.length
                ? `Holiday removed from ${removedLabel}.`
                : 'Holiday removed.',
            holiday: holiday ? serializeHoliday(holiday) : null,
        });
    } catch (error) {
        console.error('[deleteHoliday]', error);
        return res.status(500).json({ message: error.message || 'Failed to delete holiday.' });
    }
}
