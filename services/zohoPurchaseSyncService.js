import ZohoBill from '../models/ZohoBill.js';
import ZohoExpense from '../models/ZohoExpense.js';
import ZohoVendorPayment from '../models/ZohoVendorPayment.js';
import {
    mapZohoBillToDoc,
    mapZohoExpenseToDoc,
    mapZohoVendorPaymentToDoc,
    toZohoBillApiShape,
    toZohoExpenseApiShape,
    toZohoVendorPaymentApiShape,
} from '../utils/zohoPurchaseMappers.js';
import {
    fetchBillsChunk,
    fetchExpensesChunk,
    fetchVendorPaymentsChunk,
    getZohoOrganizationId,
} from './zohoService.js';
import { getExplicitSyncPreference } from './zohoContactSyncService.js';

const BULK_UPSERT_BATCH_SIZE = 500;
const DEFAULT_CHUNK_LIMIT = 400;
const SESSION_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, { ids: Set<string>, timer: NodeJS.Timeout }>} */
const chunkSessions = new Map();

async function runBulkUpserts(Model, bulkOps) {
    if (!bulkOps.length) return;

    for (let index = 0; index < bulkOps.length; index += BULK_UPSERT_BATCH_SIZE) {
        const batch = bulkOps.slice(index, index + BULK_UPSERT_BATCH_SIZE);
        await Model.bulkWrite(batch, { ordered: false });
    }
}

function latestSyncedAt(docs) {
    return docs.reduce((latest, doc) => {
        const value = doc.lastSyncedAt ? new Date(doc.lastSyncedAt).getTime() : 0;
        return value > latest ? value : latest;
    }, 0);
}

function sessionKey(entity, syncToken) {
    return `${entity}:${String(syncToken || '').trim()}`;
}

function getChunkSession(entity, syncToken) {
    const token = String(syncToken || '').trim();
    if (!token) {
        return { ids: new Set(), timer: null };
    }

    const key = sessionKey(entity, token);
    let session = chunkSessions.get(key);
    if (!session) {
        session = { ids: new Set(), timer: null };
        chunkSessions.set(key, session);
    }
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => chunkSessions.delete(key), SESSION_TTL_MS);
    return session;
}

function clearChunkSession(entity, syncToken) {
    const key = sessionKey(entity, syncToken);
    const session = chunkSessions.get(key);
    if (session?.timer) clearTimeout(session.timer);
    chunkSessions.delete(key);
}

function parseChunkOptions(query = {}) {
    const startPage = Math.max(1, Number(query.zohoPage || query.startPage) || 1);
    const maxRows = Math.max(1, Math.min(1000, Number(query.chunkLimit || query.maxRows) || DEFAULT_CHUNK_LIMIT));
    const syncToken = String(query.syncToken || '').trim();
    return { startPage, maxRows, syncToken };
}

async function upsertChunkRows({
    Model,
    rows,
    organizationId,
    syncedAt,
    mapToDoc,
    idField,
    toApiShape,
    entity,
    syncToken,
    hasMore,
}) {
    const session = getChunkSession(entity, syncToken);
    const syncedIds = [];
    const bulkOps = [];
    const apiRows = [];

    for (const row of rows) {
        const doc = mapToDoc(row, organizationId, syncedAt);
        if (!doc) continue;

        const id = doc[idField];
        syncedIds.push(id);
        session.ids.add(id);
        apiRows.push(toApiShape(doc));
        bulkOps.push({
            updateOne: {
                filter: { organizationId, [idField]: id },
                update: { $set: doc },
                upsert: true,
            },
        });
    }

    await runBulkUpserts(Model, bulkOps);

    let deactivated = 0;
    if (!hasMore && syncToken && session.ids.size > 0) {
        const result = await Model.updateMany(
            {
                organizationId,
                isActive: true,
                [idField]: { $nin: [...session.ids] },
            },
            {
                $set: {
                    isActive: false,
                    lastSyncedAt: syncedAt,
                },
            },
        );
        deactivated = result.modifiedCount || 0;
        clearChunkSession(entity, syncToken);
    }

    return {
        data: apiRows.filter(Boolean),
        upserted: syncedIds.length,
        deactivated,
        syncedAt,
    };
}

export async function syncZohoExpensesChunk(query = {}) {
    const { startPage, maxRows, syncToken } = parseChunkOptions(query);
    const organizationId = getZohoOrganizationId();
    const chunk = await fetchExpensesChunk(query, { startPage, maxRows });
    const syncedAt = new Date();
    const stats = await upsertChunkRows({
        Model: ZohoExpense,
        rows: chunk.rows || [],
        organizationId,
        syncedAt,
        mapToDoc: mapZohoExpenseToDoc,
        idField: 'zohoExpenseId',
        toApiShape: toZohoExpenseApiShape,
        entity: 'expenses',
        syncToken,
        hasMore: chunk.hasMore,
    });

    return {
        organizationId,
        ...stats,
        hasMore: Boolean(chunk.hasMore),
        nextZohoPage: chunk.nextPage,
        zohoPage: startPage,
        chunkLimit: maxRows,
    };
}

export async function syncZohoBillsChunk(query = {}) {
    const { startPage, maxRows, syncToken } = parseChunkOptions(query);
    const organizationId = getZohoOrganizationId();
    const chunk = await fetchBillsChunk(query, { startPage, maxRows });
    const syncedAt = new Date();
    const stats = await upsertChunkRows({
        Model: ZohoBill,
        rows: chunk.rows || [],
        organizationId,
        syncedAt,
        mapToDoc: mapZohoBillToDoc,
        idField: 'zohoBillId',
        toApiShape: toZohoBillApiShape,
        entity: 'bills',
        syncToken,
        hasMore: chunk.hasMore,
    });

    return {
        organizationId,
        ...stats,
        hasMore: Boolean(chunk.hasMore),
        nextZohoPage: chunk.nextPage,
        zohoPage: startPage,
        chunkLimit: maxRows,
    };
}

export async function syncZohoVendorPaymentsChunk(query = {}) {
    const { startPage, maxRows, syncToken } = parseChunkOptions(query);
    const organizationId = getZohoOrganizationId();
    const chunk = await fetchVendorPaymentsChunk(query, { startPage, maxRows });
    const syncedAt = new Date();
    const stats = await upsertChunkRows({
        Model: ZohoVendorPayment,
        rows: chunk.rows || [],
        organizationId,
        syncedAt,
        mapToDoc: mapZohoVendorPaymentToDoc,
        idField: 'zohoPaymentId',
        toApiShape: toZohoVendorPaymentApiShape,
        entity: 'vendorPayments',
        syncToken,
        hasMore: chunk.hasMore,
    });

    return {
        organizationId,
        ...stats,
        hasMore: Boolean(chunk.hasMore),
        nextZohoPage: chunk.nextPage,
        zohoPage: startPage,
        chunkLimit: maxRows,
    };
}

export async function upsertZohoVendorPaymentFromApi(payment) {
    const organizationId = getZohoOrganizationId();
    const syncedAt = new Date();
    const doc = mapZohoVendorPaymentToDoc(payment, organizationId, syncedAt);
    if (!doc) return null;

    await ZohoVendorPayment.findOneAndUpdate(
        { organizationId, zohoPaymentId: doc.zohoPaymentId },
        { $set: doc },
        { upsert: true, new: true },
    );

    return doc;
}

export async function listZohoExpensesFromDb({ activeOnly = true } = {}) {
    const organizationId = getZohoOrganizationId();
    const query = { organizationId };
    if (activeOnly) query.isActive = true;

    const docs = await ZohoExpense.find(query).sort({ date: -1, createdAt: -1 }).lean();
    const syncedAt = latestSyncedAt(docs);

    return {
        data: docs.map(toZohoExpenseApiShape).filter(Boolean),
        meta: {
            count: docs.length,
            syncedAt: syncedAt ? new Date(syncedAt).toISOString() : null,
            source: 'database',
        },
    };
}

export async function listZohoBillsFromDb({ activeOnly = true } = {}) {
    const organizationId = getZohoOrganizationId();
    const query = { organizationId };
    if (activeOnly) query.isActive = true;

    const docs = await ZohoBill.find(query).sort({ date: -1, createdAt: -1 }).lean();
    const syncedAt = latestSyncedAt(docs);

    return {
        data: docs.map(toZohoBillApiShape).filter(Boolean),
        meta: {
            count: docs.length,
            syncedAt: syncedAt ? new Date(syncedAt).toISOString() : null,
            source: 'database',
        },
    };
}

export async function listZohoVendorPaymentsFromDb({ activeOnly = true } = {}) {
    const organizationId = getZohoOrganizationId();
    const query = { organizationId };
    if (activeOnly) query.isActive = true;

    const docs = await ZohoVendorPayment.find(query).sort({ date: -1, createdAt: -1 }).lean();
    const syncedAt = latestSyncedAt(docs);

    return {
        data: docs.map(toZohoVendorPaymentApiShape).filter(Boolean),
        meta: {
            count: docs.length,
            syncedAt: syncedAt ? new Date(syncedAt).toISOString() : null,
            source: 'database',
        },
    };
}

/** Sync on every list load unless sync=false is passed (e.g. dropdowns). */
export function shouldSyncPurchasesOnRead(req) {
    const preference = getExplicitSyncPreference(req);
    if (preference === false) return false;
    return true;
}
