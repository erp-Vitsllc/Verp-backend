import ZohoCustomer from '../models/ZohoCustomer.js';
import ZohoVendor from '../models/ZohoVendor.js';
import {
    mapZohoCustomerToDoc,
    mapZohoVendorToDoc,
    toZohoCustomerApiShape,
    toZohoVendorApiShape,
} from '../utils/zohoContactMappers.js';
import {
    fetchCustomers,
    fetchVendors,
    getZohoOrganizationId,
} from './zohoService.js';

const BULK_UPSERT_BATCH_SIZE = 500;

async function runBulkUpserts(Model, bulkOps) {
    if (!bulkOps.length) return;

    for (let index = 0; index < bulkOps.length; index += BULK_UPSERT_BATCH_SIZE) {
        const batch = bulkOps.slice(index, index + BULK_UPSERT_BATCH_SIZE);
        await Model.bulkWrite(batch, { ordered: false });
    }
}

async function upsertZohoCustomers(contacts, organizationId, syncedAt) {
    const syncedIds = [];
    const bulkOps = [];

    for (const contact of contacts) {
        const doc = mapZohoCustomerToDoc(contact, organizationId, syncedAt);
        if (!doc) continue;

        syncedIds.push(doc.zohoContactId);
        bulkOps.push({
            updateOne: {
                filter: { organizationId, zohoContactId: doc.zohoContactId },
                update: { $set: doc },
                upsert: true,
            },
        });
    }

    await runBulkUpserts(ZohoCustomer, bulkOps);

    let deactivated = 0;
    if (syncedIds.length > 0) {
        const result = await ZohoCustomer.updateMany(
            {
                organizationId,
                isActive: true,
                zohoContactId: { $nin: syncedIds },
            },
            {
                $set: {
                    isActive: false,
                    lastSyncedAt: syncedAt,
                },
            },
        );
        deactivated = result.modifiedCount || 0;
    }

    return { upserted: syncedIds.length, deactivated, syncedAt };
}

async function upsertZohoVendors(contacts, organizationId, syncedAt) {
    const syncedIds = [];
    const bulkOps = [];

    for (const contact of contacts) {
        const doc = mapZohoVendorToDoc(contact, organizationId, syncedAt);
        if (!doc) continue;

        syncedIds.push(doc.zohoContactId);
        bulkOps.push({
            updateOne: {
                filter: { organizationId, zohoContactId: doc.zohoContactId },
                update: { $set: doc },
                upsert: true,
            },
        });
    }

    await runBulkUpserts(ZohoVendor, bulkOps);

    let deactivated = 0;
    if (syncedIds.length > 0) {
        const result = await ZohoVendor.updateMany(
            {
                organizationId,
                isActive: true,
                zohoContactId: { $nin: syncedIds },
            },
            {
                $set: {
                    isActive: false,
                    lastSyncedAt: syncedAt,
                },
            },
        );
        deactivated = result.modifiedCount || 0;
    }

    return { upserted: syncedIds.length, deactivated, syncedAt };
}

export async function syncZohoCustomersFromApi() {
    const organizationId = getZohoOrganizationId();
    const contacts = await fetchCustomers();
    const syncedAt = new Date();
    const stats = await upsertZohoCustomers(contacts, organizationId, syncedAt);

    return {
        organizationId,
        ...stats,
    };
}

export async function syncZohoVendorsFromApi() {
    const organizationId = getZohoOrganizationId();
    const contacts = await fetchVendors();
    const syncedAt = new Date();
    const stats = await upsertZohoVendors(contacts, organizationId, syncedAt);

    return {
        organizationId,
        ...stats,
    };
}

export async function syncZohoContactsFromApi({ type = 'all' } = {}) {
    const normalizedType = String(type || 'all').trim().toLowerCase();
    const result = {
        customers: null,
        vendors: null,
    };

    if (normalizedType === 'all' || normalizedType === 'customers') {
        result.customers = await syncZohoCustomersFromApi();
    }

    if (normalizedType === 'all' || normalizedType === 'vendors') {
        result.vendors = await syncZohoVendorsFromApi();
    }

    if (!result.customers && !result.vendors) {
        throw new Error('Invalid sync type. Use customers, vendors, or all.');
    }

    return result;
}

export async function listZohoCustomersFromDb({ activeOnly = true } = {}) {
    const organizationId = getZohoOrganizationId();
    const query = { organizationId };
    if (activeOnly) {
        query.isActive = true;
    }

    const docs = await ZohoCustomer.find(query).sort({ contactName: 1 }).lean();
    const syncedAt = docs.reduce((latest, doc) => {
        const value = doc.lastSyncedAt ? new Date(doc.lastSyncedAt).getTime() : 0;
        return value > latest ? value : latest;
    }, 0);

    return {
        data: docs.map(toZohoCustomerApiShape).filter(Boolean),
        meta: {
            count: docs.length,
            syncedAt: syncedAt ? new Date(syncedAt).toISOString() : null,
            source: 'database',
        },
    };
}

export async function listZohoVendorsFromDb({ activeOnly = true } = {}) {
    const organizationId = getZohoOrganizationId();
    const query = { organizationId };
    if (activeOnly) {
        query.isActive = true;
    }

    const docs = await ZohoVendor.find(query).sort({ contactName: 1 }).lean();
    const syncedAt = docs.reduce((latest, doc) => {
        const value = doc.lastSyncedAt ? new Date(doc.lastSyncedAt).getTime() : 0;
        return value > latest ? value : latest;
    }, 0);

    return {
        data: docs.map(toZohoVendorApiShape).filter(Boolean),
        meta: {
            count: docs.length,
            syncedAt: syncedAt ? new Date(syncedAt).toISOString() : null,
            source: 'database',
        },
    };
}

export function getExplicitSyncPreference(req) {
    const syncParam = String(req?.query?.sync ?? '').trim().toLowerCase();
    if (syncParam === 'true' || syncParam === '1') return true;
    if (syncParam === 'false' || syncParam === '0') return false;
    return null;
}

/** @deprecated Use getExplicitSyncPreference — kept for callers that only need forced sync. */
export function shouldSyncOnRead(req) {
    return getExplicitSyncPreference(req) === true;
}

export function shouldSyncContactsOnRead(req, cachedCount = 0) {
    const preference = getExplicitSyncPreference(req);
    if (preference === true) return true;
    if (preference === false) return false;
    return cachedCount === 0;
}
