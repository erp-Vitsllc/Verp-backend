import UtilityEntry from '../../models/UtilityEntry.js';
import UtilityConfig from '../../models/UtilityConfig.js';
import UtilityBillPaymentDay from '../../models/UtilityBillPaymentDay.js';
import {
    cascadeDeleteUtilityEntry,
    isUtilityAdminSuperUser,
} from '../../utils/utilityBillAdminDelete.js';
import { sendUtilityAssignmentEmail } from '../../utils/sendUtilityAssignmentEmail.js';
import {
    clearUtilityContractExpiryNotifications,
    daysUntilContractEnd,
} from '../../utils/processUtilityContractExpiryReminders.js';

function escapeRegex(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameRegex(name) {
    return new RegExp(`^${escapeRegex(name)}$`, 'i');
}

function userId(req) {
    return req.user?.id || req.user?._id || null;
}

function normalizePaymentDay(values = {}) {
    const next = { ...(values || {}) };
    let day = Number(next.paymentDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
        const legacy = String(next.paymentDate || '').trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(legacy)) {
            const d = new Date(legacy);
            if (!Number.isNaN(d.getTime())) day = d.getDate();
        } else if (/^\d{1,2}$/.test(legacy)) {
            day = Number(legacy);
        }
    }
    if (Number.isInteger(day) && day >= 1 && day <= 31) {
        next.paymentDay = day;
    } else {
        delete next.paymentDay;
    }
    delete next.paymentDate;
    return next;
}

function mapEntry(doc) {
    if (!doc) return null;
    const o = doc.toObject ? doc.toObject() : doc;
    return {
        id: String(o._id),
        type: o.type || '',
        status: o.status === 'Inactive' ? 'Inactive' : 'Active',
        values: normalizePaymentDay(o.values || {}),
        assignedTo: o.assignedTo || '',
        assignedToType: o.assignedToType || '',
        assignedToId: o.assignedToId || '',
        assignedAt: o.assignedAt || null,
        pendingStatusChange: o.pendingStatusChange || null,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
    };
}

async function syncPaymentDay(entry) {
    const mapped = mapEntry(entry);
    const paymentDay = Number(mapped?.values?.paymentDay);
    if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31) return null;

    return UtilityBillPaymentDay.findOneAndUpdate(
        { entryId: mapped.id },
        {
            entryId: mapped.id,
            paymentDay,
            utilityType: mapped.type || '',
            accountNo: mapped.values?.accountNumber || '',
            provider: mapped.values?.provider || '',
            status: mapped.status,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

/** GET /api/UtilityBill/entries */
export async function listUtilityEntries(req, res) {
    try {
        const filter = {};
        const type = String(req.query?.type || req.query?.utilityType || '').trim();
        const assignedToId = String(req.query?.assignedToId || '').trim();
        const assignedToType = String(req.query?.assignedToType || '').trim();
        const status = String(req.query?.status || '').trim();

        if (type) filter.type = nameRegex(type);
        if (assignedToId) filter.assignedToId = assignedToId;
        if (assignedToType) filter.assignedToType = assignedToType;
        if (status === 'Active' || status === 'Inactive') filter.status = status;

        const rows = await UtilityEntry.find(filter).sort({ createdAt: -1 }).lean();
        return res.json({ entries: rows.map(mapEntry) });
    } catch (err) {
        console.error('[listUtilityEntries]', err);
        return res.status(500).json({ message: err?.message || 'Failed to load entries' });
    }
}

/** GET /api/UtilityBill/entries/:id */
export async function getUtilityEntry(req, res) {
    try {
        const doc = await UtilityEntry.findById(req.params.id).lean();
        if (!doc) return res.status(404).json({ message: 'Entry not found.' });

        let config = null;
        if (doc.type) {
            config = await UtilityConfig.findOne({ type: nameRegex(doc.type) }).lean();
        }
        return res.json({
            entry: mapEntry(doc),
            config: config
                ? {
                      id: String(config._id),
                      type: config.type,
                      status: config.status,
                      fields: config.fields || {},
                      attachment: config.attachment || null,
                  }
                : null,
        });
    } catch (err) {
        console.error('[getUtilityEntry]', err);
        return res.status(500).json({ message: err?.message || 'Failed to load entry' });
    }
}

/** POST /api/UtilityBill/entries */
export async function createUtilityEntry(req, res) {
    try {
        const type = String(req.body?.type || '').trim();
        if (!type) return res.status(400).json({ message: 'Utility type is required.' });

        const values = normalizePaymentDay(req.body?.values || {});
        const requestedId = String(req.body?.id || req.body?.entryId || '').trim();
        const entryId =
            requestedId ||
            `${Date.now()}${Math.floor(Math.random() * 1000)}`;

        const existing = await UtilityEntry.findById(entryId).lean();
        if (existing) {
            return res.status(409).json({ message: 'Entry already exists.', entry: mapEntry(existing) });
        }

        const doc = await UtilityEntry.create({
            _id: entryId,
            type,
            status: 'Active',
            values,
            assignedTo: '',
            assignedToType: '',
            assignedToId: '',
            createdBy: userId(req),
        });

        await syncPaymentDay(doc);

        return res.status(201).json({ ok: true, entry: mapEntry(doc) });
    } catch (err) {
        console.error('[createUtilityEntry]', err);
        return res.status(500).json({ message: err?.message || 'Failed to create entry' });
    }
}

/** PUT /api/UtilityBill/entries/:id */
export async function updateUtilityEntry(req, res) {
    try {
        const doc = await UtilityEntry.findById(req.params.id);
        if (!doc) return res.status(404).json({ message: 'Entry not found.' });

        const body = req.body || {};
        const prevAssignedToId = String(doc.assignedToId || '').trim();
        const prevAssignedToType = String(doc.assignedToType || '').trim();

        if (body.type != null) doc.type = String(body.type).trim() || doc.type;
        if (body.values != null && typeof body.values === 'object') {
            doc.values = normalizePaymentDay({ ...(doc.values || {}), ...body.values });
            doc.markModified('values');
        }
        if (body.status === 'Active' || body.status === 'Inactive') {
            doc.status = body.status;
        }
        if (body.assignedTo !== undefined) doc.assignedTo = String(body.assignedTo || '').trim();
        if (body.assignedToType !== undefined) {
            const t = String(body.assignedToType || '').trim();
            doc.assignedToType = t === 'Company' || t === 'Employee' ? t : '';
        }
        if (body.assignedToId !== undefined) {
            doc.assignedToId = String(body.assignedToId || '').trim();
        }
        if (body.assignedAt !== undefined) {
            doc.assignedAt = body.assignedAt ? new Date(body.assignedAt) : null;
        }
        if (body.pendingStatusChange !== undefined) {
            doc.pendingStatusChange = body.pendingStatusChange;
            doc.markModified('pendingStatusChange');
        }

        await doc.save();
        await syncPaymentDay(doc);

        const mapped = mapEntry(doc);
        const timing = daysUntilContractEnd(mapped?.values?.contractEnd);
        const contractResolved =
            mapped.status === 'Inactive' || !timing || timing.daysUntil > 0;
        if (contractResolved) {
            await clearUtilityContractExpiryNotifications(
                mapped.id || mapped._id || doc._id,
                mapped.status === 'Inactive'
                    ? 'Utility account deactivated'
                    : 'Contract end renewed / no longer due',
            ).catch((e) =>
                console.error('[updateUtilityEntry] clear contract expiry', e?.message || e),
            );
        }

        const nextAssignedToId = String(mapped.assignedToId || '').trim();
        const nextAssignedToType = String(mapped.assignedToType || '').trim();
        const assignmentChanged =
            nextAssignedToId &&
            (nextAssignedToId !== prevAssignedToId ||
                nextAssignedToType !== prevAssignedToType);

        if (assignmentChanged) {
            const isReassign = Boolean(prevAssignedToId);
            sendUtilityAssignmentEmail({
                entry: mapped,
                assignedToType: nextAssignedToType || 'Employee',
                assignedToId: nextAssignedToId,
                assignedToName: mapped.assignedTo || '',
                isReassign,
            }).catch((e) =>
                console.error('[updateUtilityEntry] assignment email', e?.message || e),
            );
        }

        return res.json({ ok: true, entry: mapped });
    } catch (err) {
        console.error('[updateUtilityEntry]', err);
        return res.status(500).json({ message: err?.message || 'Failed to update entry' });
    }
}

/** DELETE /api/UtilityBill/entries/:id — admin / super user only */
export async function deleteUtilityEntry(req, res) {
    try {
        if (!isUtilityAdminSuperUser(req)) {
            return res.status(403).json({ message: 'Only admin can delete utility records.' });
        }
        const result = await cascadeDeleteUtilityEntry(req.params.id, { req });
        if (!result.ok) {
            return res.status(result.message === 'Entry not found.' ? 404 : 400).json({
                message: result.message || 'Failed to delete entry',
            });
        }
        return res.json(result);
    } catch (err) {
        console.error('[deleteUtilityEntry]', err);
        return res.status(500).json({ message: err?.message || 'Failed to delete entry' });
    }
}
