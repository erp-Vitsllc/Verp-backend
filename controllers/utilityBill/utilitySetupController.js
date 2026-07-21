import UtilityTypeCatalog from '../../models/UtilityTypeCatalog.js';
import UtilityProvider from '../../models/UtilityProvider.js';
import UtilityConfig from '../../models/UtilityConfig.js';
import UtilityEntry from '../../models/UtilityEntry.js';
import UtilityBillPayment from '../../models/UtilityBillPayment.js';
import UtilityBillPaymentDay from '../../models/UtilityBillPaymentDay.js';
import UtilityEntryStatusChange from '../../models/UtilityEntryStatusChange.js';
import {
    cascadeDeleteEntriesByType,
    isUtilityAdminSuperUser,
} from '../../utils/utilityBillAdminDelete.js';
import { listZohoVendorsFromDb } from '../../services/zohoContactSyncService.js';

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

async function loadZohoVendorNames() {
    try {
        const { data } = await listZohoVendorsFromDb({ activeOnly: true });
        const names = [];
        (Array.isArray(data) ? data : []).forEach((vendor) => {
            const name = String(
                vendor?.contact_name || vendor?.vendor_name || vendor?.company_name || '',
            ).trim();
            if (name) names.push(name);
        });
        return names;
    } catch (error) {
        console.warn('[UtilityProviders] Zoho vendor list unavailable:', error?.message || error);
        return [];
    }
}

function uniqueSortedNames(names = []) {
    const byKey = new Map();
    names.forEach((name) => {
        const trimmed = String(name || '').trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, trimmed);
    });
    return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
}

/**
 * Select provider = only active providers admin added.
 * Add provider vendor list = full Zoho vendor names (never reduced by delete).
 */
async function buildProviderLists() {
    await ensureDefaultProviders();

    const [activeRows, vendorNames] = await Promise.all([
        UtilityProvider.find({ active: true }).select('name').lean(),
        loadZohoVendorNames(),
    ]);

    const providers = uniqueSortedNames(activeRows.map((row) => row.name));
    // Always the full vendor list — delete only affects `providers`, never this list.
    const vendorOptions = uniqueSortedNames(vendorNames);

    return { providers, vendorOptions };
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

/** PUT /api/UtilityBill/types/:name — rename a utility type (admin). Cascades to configs/entries/bills. */
export async function renameUtilityTypeName(req, res) {
    try {
        if (!isAdminLike(req)) {
            return res.status(403).json({ message: 'Only admin can rename utility types.' });
        }
        const oldName = String(req.params?.name || '').trim();
        const newName = String(req.body?.name || req.body?.newName || '').trim();
        if (!oldName) return res.status(400).json({ message: 'Current type name is required.' });
        if (!newName) return res.status(400).json({ message: 'New type name is required.' });
        if (oldName.toLowerCase() === newName.toLowerCase() && oldName !== newName) {
            // Case-only rename — still update stored spelling.
        } else if (oldName.toLowerCase() === newName.toLowerCase()) {
            return res.json({ ok: true, name: oldName, types: await listTypeNames() });
        }

        const clash = await UtilityTypeCatalog.findOne({
            name: nameRegex(newName),
            active: true,
        }).lean();
        if (clash && String(clash.name).toLowerCase() !== oldName.toLowerCase()) {
            return res.status(400).json({ message: `Type “${clash.name}” already exists.` });
        }

        const catalog = await UtilityTypeCatalog.findOne({ name: nameRegex(oldName) });
        if (!catalog || !catalog.active) {
            return res.status(404).json({ message: `Type “${oldName}” was not found.` });
        }

        // Soft-deactivate any inactive row that already holds the new name (unique index).
        const inactiveClash = await UtilityTypeCatalog.findOne({
            name: nameRegex(newName),
            active: false,
        });
        if (inactiveClash) {
            await UtilityTypeCatalog.deleteOne({ _id: inactiveClash._id });
        }

        catalog.name = newName;
        await catalog.save();

        await Promise.all([
            UtilityConfig.updateMany({ type: nameRegex(oldName) }, { $set: { type: newName } }),
            UtilityEntry.updateMany({ type: nameRegex(oldName) }, { $set: { type: newName } }),
            UtilityBillPayment.updateMany(
                { utilityType: nameRegex(oldName) },
                { $set: { utilityType: newName } },
            ),
            UtilityBillPaymentDay.updateMany(
                { utilityType: nameRegex(oldName) },
                { $set: { utilityType: newName } },
            ),
            UtilityEntryStatusChange.updateMany(
                { utilityType: nameRegex(oldName) },
                { $set: { utilityType: newName } },
            ),
        ]);

        return res.json({ ok: true, name: newName, types: await listTypeNames() });
    } catch (err) {
        console.error('[renameUtilityTypeName]', err);
        return res.status(500).json({ message: err?.message || 'Failed to rename type' });
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
        const { providers, hiddenProviders } = await buildProviderLists();
        return res.json({ providers, hiddenProviders });
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
            const lists = await buildProviderLists();
            return res.json({ ok: true, ...lists });
        }
        await UtilityProvider.create({ name, active: true, createdBy: userId(req) });
        const lists = await buildProviderLists();
        return res.status(201).json({ ok: true, ...lists });
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

        // Soft-remove from Select provider only. Vendor / Add provider list is never deleted.
        const existing = await UtilityProvider.findOne({ name: nameRegex(name) });
        if (existing) {
            existing.active = false;
            await existing.save();
        } else {
            await UtilityProvider.create({
                name,
                active: false,
                createdBy: userId(req),
            });
        }

        const lists = await buildProviderLists();
        return res.json({ ok: true, ...lists });
    } catch (err) {
        console.error('[removeUtilityProvider]', err);
        return res.status(500).json({ message: err?.message || 'Failed to remove provider' });
    }
}

async function listProviderNames() {
    const { providers } = await buildProviderLists();
    return providers;
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
