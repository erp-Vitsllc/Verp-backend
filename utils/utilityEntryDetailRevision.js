import UtilityEntryRevision from '../models/UtilityEntryRevision.js';

const TZ = 'Asia/Dubai';

/** State of the record before any tracked edit. Sorts before every real bill month. */
export const UTILITY_DETAIL_BASELINE_MONTH = '0000-01';

export function dubaiCalendarMonthKey(refDate = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        year: 'numeric',
        month: '2-digit',
    }).formatToParts(refDate);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    if (!year || !month) return '';
    return `${year}-${month}`;
}

export function shiftMonthKey(ym, deltaMonths = 0) {
    if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return '';
    const year = Number(String(ym).slice(0, 4));
    const month = Number(String(ym).slice(5, 7));
    const shifted = new Date(Date.UTC(year, month - 1 + (Number(deltaMonths) || 0), 1));
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Newest bill month that is open. A calendar month opens on the 1st of the next month. */
export function openUtilityBillMonthKey(refDate = new Date()) {
    return shiftMonthKey(dubaiCalendarMonthKey(refDate), -1);
}

function stripAttachmentBytes(values = {}) {
    const next = { ...(values || {}) };
    if (next.attachment && typeof next.attachment === 'object') {
        const { dataUrl, ...rest } = next.attachment;
        next.attachment = rest;
    }
    return next;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .sort()
            .reduce((acc, key) => {
                const child = stable(value[key]);
                if (child !== undefined) acc[key] = child;
                return acc;
            }, {});
    }
    return value;
}

export function snapshotEntryDetails(source = {}) {
    const type = String(source.assignedToType || '').trim();
    return {
        values: stripAttachmentBytes(source.values || {}),
        assignedTo: String(source.assignedTo || '').trim(),
        assignedToType: type === 'Company' || type === 'Employee' ? type : '',
        assignedToId: String(source.assignedToId || '').trim(),
    };
}

export function entryDetailsEqual(a, b) {
    return JSON.stringify(stable(snapshotEntryDetails(a))) === JSON.stringify(stable(snapshotEntryDetails(b)));
}

/**
 * Revisions to write when SIM / utility details change.
 * The first change freezes every earlier month at the previous details.
 * Later changes replace only the open bill month.
 */
export function planUtilityEntryDetailRevisions({
    before,
    after,
    currentMonth,
    hasExistingRevisions = false,
} = {}) {
    const prev = snapshotEntryDetails(before);
    const next = snapshotEntryDetails(after);
    if (!/^\d{4}-\d{2}$/.test(String(currentMonth || ''))) return [];
    if (JSON.stringify(stable(prev)) === JSON.stringify(stable(next))) return [];

    const writes = [];
    if (!hasExistingRevisions) {
        writes.push({ fromMonth: UTILITY_DETAIL_BASELINE_MONTH, ...prev });
    }
    writes.push({ fromMonth: String(currentMonth), ...next });
    return writes;
}

function revisionWrite(entryId, row) {
    return {
        updateOne: {
            filter: { entryId, fromMonth: row.fromMonth },
            update: {
                $set: {
                    entryId,
                    fromMonth: row.fromMonth,
                    values: row.values || {},
                    assignedTo: row.assignedTo || '',
                    assignedToType: row.assignedToType || '',
                    assignedToId: row.assignedToId || '',
                },
            },
            upsert: true,
        },
    };
}

async function applyRevisionWrites(entryId, writes) {
    if (!writes.length) return;
    await UtilityEntryRevision.bulkWrite(writes.map((row) => revisionWrite(entryId, row)));
}

/**
 * Persist detail history before the entry document is saved.
 * Returns a rollback for the case where the entry save then fails.
 */
export async function commitUtilityEntryDetailChange(entryId, before, after, refDate = new Date()) {
    const id = String(entryId || '').trim();
    if (!id) return null;

    const currentMonth = openUtilityBillMonthKey(refDate);
    const existingCount = await UtilityEntryRevision.countDocuments({ entryId: id });
    const writes = planUtilityEntryDetailRevisions({
        before,
        after,
        currentMonth,
        hasExistingRevisions: existingCount > 0,
    });
    if (!writes.length) return null;

    const fromMonths = writes.map((row) => row.fromMonth);
    const prior = await UtilityEntryRevision.find({
        entryId: id,
        fromMonth: { $in: fromMonths },
    }).lean();

    await applyRevisionWrites(id, writes);

    return {
        async rollback() {
            const priorMonths = new Set(prior.map((row) => String(row.fromMonth || '')));
            const created = fromMonths.filter((month) => !priorMonths.has(month));
            if (created.length) {
                await UtilityEntryRevision.deleteMany({ entryId: id, fromMonth: { $in: created } });
            }
            if (prior.length) {
                await applyRevisionWrites(
                    id,
                    prior.map((row) => ({
                        fromMonth: row.fromMonth,
                        ...snapshotEntryDetails(row),
                    })),
                );
            }
        },
    };
}

export function mapEntryRevision(doc) {
    if (!doc) return null;
    const snap = snapshotEntryDetails(doc);
    return {
        fromMonth: String(doc.fromMonth || ''),
        values: snap.values,
        assignedTo: snap.assignedTo,
        assignedToType: snap.assignedToType,
        assignedToId: snap.assignedToId,
    };
}

export async function detailRevisionsByEntryId(entryIds = []) {
    const ids = [...new Set((entryIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const grouped = new Map();
    if (!ids.length) return grouped;

    const rows = await UtilityEntryRevision.find({ entryId: { $in: ids } })
        .sort({ fromMonth: 1 })
        .lean();
    rows.forEach((row) => {
        const id = String(row.entryId || '');
        if (!grouped.has(id)) grouped.set(id, []);
        grouped.get(id).push(mapEntryRevision(row));
    });
    return grouped;
}
