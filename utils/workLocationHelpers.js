import WorkLocation from '../models/WorkLocation.js';
import WorkingTime from '../models/WorkingTime.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { escapeRegex } from './regexHelper.js';

export const DEFAULT_WORK_LOCATIONS = [
    { key: 'office', label: 'Office', isSystem: true, sortOrder: 0 },
    { key: 'site', label: 'Site', isSystem: true, sortOrder: 1 },
];

export function slugifyWorkLocationKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

export function normalizeStaffTypeKey(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || raw === 'staff') return raw === 'staff' ? 'site' : 'office';
    return slugifyWorkLocationKey(raw) || 'office';
}

/** Mongo clause so missing/blank staffType still counts as Office. */
export function staffTypeMongoClause(staffType) {
    const key = normalizeStaffTypeKey(staffType);
    if (key === 'office') {
        return {
            $or: [
                { staffType: 'office' },
                { staffType: { $exists: false } },
                { staffType: null },
                { staffType: '' },
            ],
        };
    }
    return { staffType: key };
}

export function serializeWorkLocation(row) {
    if (!row) return row;
    return {
        _id: row._id,
        key: row.key,
        label: row.label,
        status: row.status || 'Active',
        isSystem: Boolean(row.isSystem),
        sortOrder: Number(row.sortOrder) || 0,
    };
}

export async function ensureDefaultWorkLocations() {
    await Promise.all(
        DEFAULT_WORK_LOCATIONS.map((row) =>
            WorkLocation.findOneAndUpdate(
                { key: row.key },
                {
                    $setOnInsert: {
                        key: row.key,
                        label: row.label,
                        isSystem: true,
                        sortOrder: row.sortOrder,
                        status: 'Active',
                    },
                },
                { upsert: true, new: true },
            ),
        ),
    );
}

export async function listActiveWorkLocations() {
    await ensureDefaultWorkLocations();
    const rows = await WorkLocation.find({ status: 'Active' })
        .sort({ sortOrder: 1, label: 1 })
        .lean();
    return rows.map(serializeWorkLocation);
}

export async function isKnownWorkLocationKey(key) {
    const wanted = normalizeStaffTypeKey(key);
    const locations = await listActiveWorkLocations();
    return locations.some((row) => row.key === wanted);
}

export async function resolveStoredStaffType(value) {
    const key = normalizeStaffTypeKey(value);
    if (await isKnownWorkLocationKey(key)) return key;
    return null;
}

async function copyOfficeWeekToExtra(key) {
    if (!key || key === 'office' || key === 'site') return;
    const doc = await WorkingTime.findOne({ key: 'default' });
    if (!doc) return;
    const extra = doc.extra && typeof doc.extra === 'object' && !Array.isArray(doc.extra)
        ? { ...doc.extra }
        : {};
    if (extra[key]) return;
    extra[key] = doc.office ? JSON.parse(JSON.stringify(doc.office)) : undefined;
    doc.extra = extra;
    doc.markModified('extra');
    await doc.save();
}

async function attachNewLocationToCompanyWideHolidays(key) {
    if (!key || key === 'office' || key === 'site') return;
    const Holiday = (await import('../models/Holiday.js')).default;
    const rows = await Holiday.find({}).select('_id appliesTo').lean();
    const ids = [];
    for (const row of rows) {
        const raw = Array.isArray(row.appliesTo) ? row.appliesTo : [];
        const list = raw.length
            ? raw.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
            : ['office', 'site'];
        const companyWide =
            list.includes('office') &&
            list.includes('site') &&
            list.every((item) => item === 'office' || item === 'site');
        if (companyWide) ids.push(row._id);
    }
    if (!ids.length) return;
    await Holiday.updateMany({ _id: { $in: ids } }, { $addToSet: { appliesTo: key } });
}

async function removeExtraWeek(key) {
    if (!key || key === 'office' || key === 'site') return;
    const doc = await WorkingTime.findOne({ key: 'default' });
    if (!doc?.extra || typeof doc.extra !== 'object') return;
    const extra = { ...doc.extra };
    if (!(key in extra)) return;
    delete extra[key];
    doc.extra = extra;
    doc.markModified('extra');
    await doc.save();
}

export async function createWorkLocation({ label }) {
    const name = String(label || '').trim();
    if (!name) {
        const err = new Error('Work location name is required');
        err.status = 400;
        throw err;
    }

    const key = slugifyWorkLocationKey(name);
    if (!key) {
        const err = new Error('Work location name must include letters or numbers');
        err.status = 400;
        throw err;
    }

    if (key === 'extra' || key === 'id' || key === '_id') {
        const err = new Error('That name is reserved. Choose a different work location name.');
        err.status = 400;
        throw err;
    }

    const existing = await WorkLocation.findOne({
        $or: [
            { key },
            { label: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') } },
        ],
    }).lean();
    if (existing) {
        const err = new Error('Work location already exists');
        err.status = 400;
        throw err;
    }

    const last = await WorkLocation.findOne({ isSystem: { $ne: true } })
        .sort({ sortOrder: -1 })
        .select('sortOrder')
        .lean();
    const sortOrder = Math.max(10, Number(last?.sortOrder) || 10) + 1;

    const created = await WorkLocation.create({
        key,
        label: name,
        isSystem: false,
        sortOrder,
        status: 'Active',
    });

    try {
        await copyOfficeWeekToExtra(key);
    } catch (copyErr) {
        console.error('[createWorkLocation] working-time copy failed:', copyErr);
    }

    try {
        await attachNewLocationToCompanyWideHolidays(key);
    } catch (holidayErr) {
        console.error('[createWorkLocation] holiday backfill failed:', holidayErr);
    }

    return serializeWorkLocation(created.toObject());
}

export async function deleteWorkLocation(id) {
    const location = await WorkLocation.findById(id);
    if (!location) {
        const err = new Error('Work location not found');
        err.status = 404;
        throw err;
    }
    if (location.isSystem || location.key === 'office' || location.key === 'site') {
        const err = new Error('Cannot delete the default Office or Site work location');
        err.status = 403;
        throw err;
    }

    const employeeCount = await EmployeeBasic.countDocuments({
        staffType: location.key,
    });
    if (employeeCount > 0) {
        const employees = await EmployeeBasic.find({ staffType: location.key })
            .select('firstName lastName employeeId')
            .limit(50)
            .lean();
        const err = new Error(
            `This work location is assigned to ${employeeCount} employee(s). Reassign them before deleting it.`,
        );
        err.status = 400;
        err.payload = {
            employeeCount,
            employees: employees.map((emp) => ({
                name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim(),
                id: emp.employeeId,
            })),
            workLocationName: location.label,
        };
        throw err;
    }

    await WorkLocation.findByIdAndDelete(id);
    try {
        await removeExtraWeek(location.key);
    } catch (copyErr) {
        console.error('[deleteWorkLocation] working-time cleanup failed:', copyErr);
    }
    try {
        const Holiday = (await import('../models/Holiday.js')).default;
        await Holiday.updateMany({}, { $pull: { appliesTo: location.key } });
    } catch (holidayErr) {
        console.error('[deleteWorkLocation] holiday cleanup failed:', holidayErr);
    }

    return { message: 'Work location deleted successfully' };
}
