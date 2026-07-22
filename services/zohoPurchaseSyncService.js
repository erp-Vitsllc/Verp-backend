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
import { runLeanListQuery } from '../utils/zohoListQuery.js';
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

/** @type {Map<string, { ids: Set<string>, startedAt: Date, timer: NodeJS.Timeout }>} */
const chunkSessions = new Map();

async function runBulkUpserts(Model, bulkOps) {
    if (!bulkOps.length) return;

    for (let index = 0; index < bulkOps.length; index += BULK_UPSERT_BATCH_SIZE) {
        const batch = bulkOps.slice(index, index + BULK_UPSERT_BATCH_SIZE);
        await Model.bulkWrite(batch, { ordered: false });
    }
}

function sessionKey(entity, syncToken) {
    return `${entity}:${String(syncToken || '').trim()}`;
}

function getChunkSession(entity, syncToken, syncedAt) {
    const token = String(syncToken || '').trim();
    if (!token) {
        return { ids: new Set(), startedAt: syncedAt, timer: null };
    }

    const key = sessionKey(entity, token);
    let session = chunkSessions.get(key);
    if (!session) {
        session = { ids: new Set(), startedAt: syncedAt, timer: null };
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
    const session = getChunkSession(entity, syncToken, syncedAt);
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
    // Prefer lastSyncedAt cutoff over giant $nin — much faster on large orgs
    if (!hasMore && syncToken && session.startedAt) {
        const result = await Model.updateMany(
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
    if (!doc) {
        console.warn(
            '[ZohoPurchaseSync] Vendor payment upsert skipped — no payment_id in payload. Keys:',
            payment && typeof payment === 'object' ? Object.keys(payment).join(', ') : typeof payment,
        );
        return null;
    }

    await ZohoVendorPayment.findOneAndUpdate(
        { organizationId, zohoPaymentId: doc.zohoPaymentId },
        { $set: doc },
        { upsert: true, new: true },
    );

    return doc;
}

export async function upsertZohoBillFromApi(bill) {
    const organizationId = getZohoOrganizationId();
    const syncedAt = new Date();
    const doc = mapZohoBillToDoc(bill, organizationId, syncedAt);
    if (!doc) return null;

    await ZohoBill.findOneAndUpdate(
        { organizationId, zohoBillId: doc.zohoBillId },
        { $set: doc },
        { upsert: true, new: true },
    );

    return doc;
}

const PURCHASE_SEARCH = {
    expenses: [
        'accountName',
        'vendorName',
        'customerName',
        'referenceNumber',
        'status',
        'locationName',
        'description',
    ],
    bills: ['billNumber', 'referenceNumber', 'vendorName', 'status', 'locationName'],
    payments: [
        'paymentNumber',
        'referenceNumber',
        'vendorName',
        'billNumbers',
        'paymentMode',
        'status',
        'locationName',
    ],
};

const PURCHASE_SORT = {
    expenses: {
        date: 'date',
        accountName: 'accountName',
        vendorName: 'vendorName',
        customerName: 'customerName',
        referenceNumber: 'referenceNumber',
        status: 'status',
        location: 'locationName',
        amount: 'total',
        amountValue: 'total',
    },
    bills: {
        date: 'date',
        billNumber: 'billNumber',
        referenceNumber: 'referenceNumber',
        vendorName: 'vendorName',
        status: 'status',
        dueDate: 'dueDate',
        location: 'locationName',
        amount: 'total',
        amountValue: 'total',
        balanceAmount: 'balance',
        balanceValue: 'balance',
    },
    payments: {
        date: 'date',
        paymentNumber: 'paymentNumber',
        referenceNumber: 'referenceNumber',
        vendorName: 'vendorName',
        billNumber: 'billNumbers',
        mode: 'paymentMode',
        status: 'status',
        location: 'locationName',
        amount: 'amount',
        amountValue: 'amount',
        unusedAmount: 'balance',
        unusedAmountValue: 'balance',
    },
};

export async function listZohoExpensesFromDb({ activeOnly = true, query = {} } = {}) {
    const organizationId = getZohoOrganizationId();
    return runLeanListQuery({
        Model: ZohoExpense,
        organizationId,
        activeOnly,
        query,
        searchFields: PURCHASE_SEARCH.expenses,
        sortMap: PURCHASE_SORT.expenses,
        defaultSort: { date: -1 },
        toApiShape: toZohoExpenseApiShape,
    });
}

export async function listZohoBillsFromDb({ activeOnly = true, query = {} } = {}) {
    const organizationId = getZohoOrganizationId();
    return runLeanListQuery({
        Model: ZohoBill,
        organizationId,
        activeOnly,
        query,
        searchFields: PURCHASE_SEARCH.bills,
        sortMap: PURCHASE_SORT.bills,
        defaultSort: { date: -1 },
        toApiShape: toZohoBillApiShape,
    });
}

export async function listZohoVendorPaymentsFromDb({ activeOnly = true, query = {} } = {}) {
    const organizationId = getZohoOrganizationId();
    return runLeanListQuery({
        Model: ZohoVendorPayment,
        organizationId,
        activeOnly,
        query,
        searchFields: PURCHASE_SEARCH.payments,
        sortMap: PURCHASE_SORT.payments,
        defaultSort: { date: -1 },
        toApiShape: toZohoVendorPaymentApiShape,
    });
}

/** Sync only when sync=true is passed. Default is local DB (fast). */
export function shouldSyncPurchasesOnRead(req) {
    return getExplicitSyncPreference(req) === true;
}
