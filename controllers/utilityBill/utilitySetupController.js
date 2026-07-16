import UtilityTypeCatalog from '../../models/UtilityTypeCatalog.js';
import UtilityProvider from '../../models/UtilityProvider.js';
import UtilityConfig from '../../models/UtilityConfig.js';
import UtilityEntry from '../../models/UtilityEntry.js';
import {
    cascadeDeleteEntriesByType,
    isUtilityAdminSuperUser,
} from '../../utils/utilityBillAdminDelete.js';

const DEFAULT_PROVIDERS = ['Etisalat', 'Du'];

function escapeRegex(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameRegex(name) {
    return new RegExp(`^${escapeRegex(name)}$`, 'i');
}

function isAdminLike(req) {
    return isUtilityAdminSuperUser(req);
}

function userId(req) {
    return req.user?.id || req.user?._id || null;
}

function normalizeFields(fields = {}) {
    const next = { ...(fields && typeof fields === 'object' ? fields : {}) };
    if (next.paymentDetails != null && next.paymentDate == null) {
        next.paymentDate = next.paymentDetails;
    }
    delete next.paymentDetails;
    return next;
}

function mapConfig(doc) {
    if (!doc) return null;
    const o = doc.toObject ? doc.toObject() : doc;
    return {
        id: String(o._id),
        type: o.type || '',
        status: o.status === 'Inactive' ? 'Inactive' : 'Active',
        fields: normalizeFields(o.fields || {}),
        attachment: o.attachment || null,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
    };
}

async function ensureDefaultProviders() {
    for (const name of DEFAULT_PROVIDERS) {
        const exists = await UtilityProvider.findOne({ name: nameRegex(name) }).lean();
        if (!exists) {
            await UtilityProvider.create({ name, active: true });
        }
    }
}

/** GET /api/UtilityBill/types */
export async function listUtilityTypeNames(req, res) {
    try {
        const rows = await UtilityTypeCatalog.find({ active: true })
            .sort({ name: 1 })
            .select('name')
            .lean();
        return res.json({ types: rows.map((r) => r.name) });
    } catch (err) {
        console.error('[listUtilityTypeNames]', err);
        return res.status(500).json({ message: err?.message || 'Failed to load types' });
    }
}

/** POST /api/UtilityBill/types */
export async function addUtilityTypeName(req, res) {
    try {
        if (!isAdminLike(req)) {
            return res.status(403).json({ message: 'Only admin can add utility types.' });
        }
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ message: 'Type name is required.' });

        const existing = await UtilityTypeCatalog.findOne({ name: nameRegex(name) });
        if (existing) {
            if (!existing.active) {
                existing.active = true;
                await existing.save();
            }
            return res.json({ ok: true, name: existing.name, types: await listTypeNames() });
        }
        const created = await UtilityTypeCatalog.create({
            name,
            active: true,
            createdBy: userId(req),
        });
        return res.status(201).json({ ok: true, name: created.name, types: await listTypeNames() });
    } catch (err) {
        console.error('[addUtilityTypeName]', err);
        return res.status(500).json({ message: err?.message || 'Failed to add type' });
    }
}

/** DELETE /api/UtilityBill/types/:name */
export async function removeUtilityTypeName(req, res) {
    try {
        if (!isAdminLike(req)) {
            return res.status(403).json({ message: 'Only admin can remove utility types.' });
        }
        const name = String(req.params?.name || '').trim();
        if (!name) return res.status(400).json({ message: 'Type name is required.' });

        const inConfig = await UtilityConfig.findOne({ type: nameRegex(name) }).lean();
        if (inConfig) {
            // Force: cascade entries + remove the utility tab config, then drop catalog name.
            await cascadeDeleteEntriesByType(name);
            await UtilityConfig.deleteOne({ _id: inConfig._id });
        } else {
            const inEntry = await UtilityEntry.findOne({ type: nameRegex(name) }).lean();
            if (inEntry) {
                await cascadeDeleteEntriesByType(name);
            }
        }

        await UtilityTypeCatalog.findOneAndUpdate(
            { name: nameRegex(name) },
            { active: false },
        );
        return res.json({ ok: true, types: await listTypeNames() });
    } catch (err) {
        console.error('[removeUtilityTypeName]', err);
        return res.status(500).json({ message: err?.message || 'Failed to remove type' });
    }
}

async function listTypeNames() {
    const rows = await UtilityTypeCatalog.find({ active: true })
        .sort({ name: 1 })
        .select('name')
        .lean();
    return rows.map((r) => r.name);
}

/** GET /api/UtilityBill/providers */
export async function listUtilityProviders(req, res) {
    try {
        await ensureDefaultProviders();
        const rows = await UtilityProvider.find({ active: true })
            .sort({ name: 1 })
            .select('name')
            .lean();
        return res.json({ providers: rows.map((r) => r.name) });
    } catch (err) {
        console.error('[listUtilityProviders]', err);
        return res.status(500).json({ message: err?.message || 'Failed to load providers' });
    }
}

/** POST /api/UtilityBill/providers */
export async function addUtilityProvider(req, res) {
    try {
        if (!isAdminLike(req)) {
            return res.status(403).json({ message: 'Only admin can add providers.' });
        }
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ message: 'Provider name is required.' });

        const existing = await UtilityProvider.findOne({ name: nameRegex(name) });
        if (existing) {
            if (!existing.active) {
                existing.active = true;
                await existing.save();
            }
            return res.json({ ok: true, providers: await listProviderNames() });
        }
        await UtilityProvider.create({ name, active: true, createdBy: userId(req) });
        return res.status(201).json({ ok: true, providers: await listProviderNames() });
    } catch (err) {
        console.error('[addUtilityProvider]', err);
        return res.status(500).json({ message: err?.message || 'Failed to add provider' });
    }
}

/** DELETE /api/UtilityBill/providers/:name */
export async function removeUtilityProvider(req, res) {
    try {
        if (!isAdminLike(req)) {
            return res.status(403).json({ message: 'Only admin can remove providers.' });
        }
        const name = String(req.params?.name || '').trim();
        if (!name) return res.status(400).json({ message: 'Provider name is required.' });

        // Admin may remove from dropdown even when referenced on existing records.
        await UtilityProvider.findOneAndUpdate({ name: nameRegex(name) }, { active: false });
        return res.json({ ok: true, providers: await listProviderNames() });
    } catch (err) {
        console.error('[removeUtilityProvider]', err);
        return res.status(500).json({ message: err?.message || 'Failed to remove provider' });
    }
}

async function listProviderNames() {
    await ensureDefaultProviders();
    const rows = await UtilityProvider.find({ active: true })
        .sort({ name: 1 })
        .select('name')
        .lean();
    return rows.map((r) => r.name);
}

/** GET /api/UtilityBill/configs */
export async function listUtilityConfigs(req, res) {
    try {
        const rows = await UtilityConfig.find().sort({ createdAt: -1 }).lean();
        return res.json({ configs: rows.map(mapConfig) });
    } catch (err) {
        console.error('[listUtilityConfigs]', err);
        return res.status(500).json({ message: err?.message || 'Failed to load utility configs' });
    }
}

/** POST /api/UtilityBill/configs — create or upsert by type */
export async function upsertUtilityConfig(req, res) {
    try {
        const type = String(req.body?.type || '').trim();
        if (!type) return res.status(400).json({ message: 'Utility type is required.' });

        const fields = normalizeFields(req.body?.fields || {});
        const attachment = req.body?.attachment || null;
        const status =
            String(req.body?.status || 'Active').toLowerCase() === 'inactive'
                ? 'Inactive'
                : 'Active';

        // Ensure type exists in catalog
        const catalog = await UtilityTypeCatalog.findOne({ name: nameRegex(type) });
        if (!catalog) {
            await UtilityTypeCatalog.create({
                name: type,
                active: true,
                createdBy: userId(req),
            });
        } else if (!catalog.active) {
            catalog.active = true;
            await catalog.save();
        }

        const existing = await UtilityConfig.findOne({ type: nameRegex(type) });
        if (existing) {
            existing.fields = fields;
            existing.attachment = attachment;
            if (req.body?.status != null) existing.status = status;
            await existing.save();
            return res.json({ ok: true, config: mapConfig(existing) });
        }

        const created = await UtilityConfig.create({
            type,
            fields,
            attachment,
            status,
            createdBy: userId(req),
        });
        return res.status(201).json({ ok: true, config: mapConfig(created) });
    } catch (err) {
        console.error('[upsertUtilityConfig]', err);
        return res.status(500).json({ message: err?.message || 'Failed to save utility' });
    }
}

/** DELETE /api/UtilityBill/configs/:id */
export async function deleteUtilityConfig(req, res) {
    try {
        if (!isAdminLike(req)) {
            return res.status(403).json({ message: 'Only admin can delete utility tabs.' });
        }
        const id = String(req.params?.id || '').trim();
        const doc = await UtilityConfig.findById(id);
        if (!doc) return res.status(404).json({ message: 'Utility not found.' });

        const entryCount = await UtilityEntry.countDocuments({ type: nameRegex(doc.type) });
        if (entryCount > 0) {
            // Admin may force-delete the tab and cascade all related records.
            await cascadeDeleteEntriesByType(doc.type);
        }

        await UtilityConfig.deleteOne({ _id: doc._id });
        return res.json({ ok: true, deletedEntries: entryCount });
    } catch (err) {
        console.error('[deleteUtilityConfig]', err);
        return res.status(500).json({ message: err?.message || 'Failed to delete utility' });
    }
}
