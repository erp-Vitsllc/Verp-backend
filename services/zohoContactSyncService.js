import ZohoCustomer from '../models/ZohoCustomer.js';
import ZohoVendor from '../models/ZohoVendor.js';
import {
    mapZohoCustomerToDoc,
    mapZohoVendorToDoc,
    toZohoCustomerApiShape,
    toZohoVendorApiShape,
} from '../utils/zohoContactMappers.js';
import { runLeanListQuery } from '../utils/zohoListQuery.js';
import {
    fetchCustomers,
    fetchVendors,
    fetchVendorsChunk,
    getZohoOrganizationId,
} from './zohoService.js';

const BULK_UPSERT_BATCH_SIZE = 500;
const DEFAULT_CHUNK_LIMIT = 400;
const SESSION_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, { ids: Set<string>, startedAt: Date, timer: NodeJS.Timeout }>} */
const vendorChunkSessions = new Map();

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
                lastSyncedAt: { $lt: syncedAt },
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
                lastSyncedAt: { $lt: syncedAt },
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

export async function syncZohoVendorsChunk(query = {}) {
    const startPage = Math.max(1, Number(query.zohoPage || query.startPage) || 1);
    const maxRows = Math.max(
        1,
        Math.min(1000, Number(query.chunkLimit || query.maxRows) || DEFAULT_CHUNK_LIMIT),
    );
    const syncToken = String(query.syncToken || '').trim();
    const organizationId = getZohoOrganizationId();
    const chunk = await fetchVendorsChunk({ startPage, maxRows });
    const syncedAt = new Date();

    const key = syncToken ? `vendors:${syncToken}` : '';
    let session = key ? vendorChunkSessions.get(key) : null;
    if (key && !session) {
        session = { ids: new Set(), startedAt: syncedAt, timer: null };
        vendorChunkSessions.set(key, session);
    }
    if (session) {
        if (session.timer) clearTimeout(session.timer);
        session.timer = setTimeout(() => vendorChunkSessions.delete(key), SESSION_TTL_MS);
    }

    const syncedIds = [];
    const bulkOps = [];
    const apiRows = [];

    for (const contact of chunk.rows || []) {
        const doc = mapZohoVendorToDoc(contact, organizationId, syncedAt);
        if (!doc) continue;

        syncedIds.push(doc.zohoContactId);
        session?.ids.add(doc.zohoContactId);
        apiRows.push(toZohoVendorApiShape(doc));
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
    if (!chunk.hasMore && session?.startedAt) {
        const result = await ZohoVendor.updateMany(
            {
                organizationId,
                isActive: true,
                $or: [
                    { lastSyncedAt: { $lt: session.startedAt } },
                    { lastSyncedAt: null },
                    { lastSyncedAt: { $exists: false } },
                ],
            },
            {
                $set: {
                    isActive: false,
                    lastSyncedAt: syncedAt,
                },
            },
        );
        deactivated = result.modifiedCount || 0;
        if (session.timer) clearTimeout(session.timer);
        vendorChunkSessions.delete(key);
    }

    return {
        organizationId,
        data: apiRows.filter(Boolean),
        upserted: syncedIds.length,
        deactivated,
        syncedAt,
        hasMore: Boolean(chunk.hasMore),
        nextZohoPage: chunk.nextPage,
        zohoPage: startPage,
        chunkLimit: maxRows,
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
    const filter = { organizationId };
    if (activeOnly) {
        filter.isActive = true;
    }

    const docs = await ZohoCustomer.find(filter).select('-zohoRaw').sort({ contactName: 1 }).lean();
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

export async function listZohoVendorsFromDb({ activeOnly = true, query = {} } = {}) {
    const organizationId = getZohoOrganizationId();
    return runLeanListQuery({
        Model: ZohoVendor,
        organizationId,
        activeOnly,
        query,
        searchFields: ['contactName', 'companyName', 'email', 'phone', 'mobile'],
        sortMap: {
            name: 'contactName',
            companyName: 'companyName',
            email: 'email',
            workPhone: 'phone',
            payables: 'outstandingPayableAmount',
        },
        defaultSort: { contactName: 1 },
        toApiShape: toZohoVendorApiShape,
    });
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

/**
 * Sync when sync=true/1, skip when sync=false/0,
 * otherwise sync only if the local cache is empty.
 */
export function shouldSyncContactsOnRead(req, cachedCount = 0) {
    const preference = getExplicitSyncPreference(req);
    if (preference === true) return true;
    if (preference === false) return false;
    return cachedCount === 0;
}
