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

async function runBulkUpserts(Model, bulkOps) {
    if (!bulkOps.length) return;

    for (let index = 0; index < bulkOps.length; index += BULK_UPSERT_BATCH_SIZE) {
        const batch = bulkOps.slice(index, index + BULK_UPSERT_BATCH_SIZE);
        await Model.bulkWrite(batch, { ordered: false });
    }
}

function parseChunkOptions(query = {}) {
    const startPage = Math.max(1, Number(query.zohoPage || query.startPage) || 1);
    const maxRows = Math.max(1, Math.min(1000, Number(query.chunkLimit || query.maxRows) || DEFAULT_CHUNK_LIMIT));
    const syncToken = String(query.syncToken || '').trim();
    return { startPage, maxRows, syncToken };
}

/**
 * Upsert a Zoho chunk. When Refresh finishes (hasMore=false + syncToken),
 * delete local rows Zoho did not return so ERP DB === Zoho for that org.
 */
async function upsertChunkRows({
    Model,
    rows,
    organizationId,
    syncedAt,
    mapToDoc,
    idField,
    toApiShape,
    syncToken,
    hasMore,
    entity = 'rows',
}) {
    const token = String(syncToken || '').trim();
    const syncedIds = [];
    const bulkOps = [];
    const apiRows = [];

    for (const row of rows) {
        const doc = mapToDoc(row, organizationId, syncedAt);
        if (!doc) continue;

        const id = doc[idField];
        syncedIds.push(id);
        apiRows.push(toApiShape(doc));
        bulkOps.push({
            updateOne: {
                filter: { organizationId, [idField]: id },
                update: {
                    $set: {
                        ...doc,
                        isActive: true,
                        ...(token ? { lastSyncToken: token } : {}),
                    },
                },
                upsert: true,
            },
        });
    }

    await runBulkUpserts(Model, bulkOps);

    // Guarantee token stamp even if bulkWrite casting drops unknown paths.
    if (token && syncedIds.length) {
        await Model.updateMany(
            { organizationId, [idField]: { $in: syncedIds } },
            { $set: { lastSyncToken: token, isActive: true, lastSyncedAt: syncedAt } },
        );
    }

    let deactivated = 0;
    if (!hasMore && token) {
        // Keep only rows stamped by this Refresh — delete everything else for the org.
        const result = await Model.deleteMany({
            organizationId,
            $nor: [{ lastSyncToken: token }],
        });
        deactivated = result.deletedCount || 0;
        if (deactivated > 0) {
            console.log(
                `[ZohoSync] ${entity}: removed ${deactivated} local row(s) not in Zoho (org=${organizationId})`,
            );
        }
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
        syncToken,
        hasMore: chunk.hasMore,
        entity: 'expenses',
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
        syncToken,
        hasMore: chunk.hasMore,
        entity: 'bills',
    });

    // Reflect Zoho paid bills onto vehicle service Amount Status.
    try {
        const paidIds = (chunk.rows || [])
            .map((row) => {
                const doc = mapZohoBillToDoc(row, organizationId, syncedAt);
                if (!doc?.zohoBillId) return '';
                const status = String(doc.status || row?.status || '').toLowerCase();
                const balance = Number(doc.balance ?? row?.balance ?? NaN);
                const paid =
                    status === 'paid' ||
                    (Number.isFinite(balance) && Math.abs(balance) < 0.01 && status !== 'draft' && status !== 'void');
                return paid ? doc.zohoBillId : '';
            })
            .filter(Boolean);
        if (paidIds.length) {
            const { markVehicleGarageServicesPaidFromZohoBillIds } = await import(
                '../utils/markVehicleGarageServicesPaidFromZoho.js'
            );
            await markVehicleGarageServicesPaidFromZohoBillIds(paidIds);
        }
    } catch (err) {
        console.warn(
            '[ZohoPurchaseSync] Vehicle service Paid stamp after bills chunk failed:',
            err?.message || err,
        );
    }

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
        syncToken,
        hasMore: chunk.hasMore,
        entity: 'vendorPayments',
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

export async function upsertZohoBillFromApi(bill, extras = {}) {
    const organizationId = getZohoOrganizationId();
    const syncedAt = new Date();
    const doc = mapZohoBillToDoc(bill, organizationId, syncedAt);
    if (!doc) return null;

    const utilityExtras = {};
    if (extras && typeof extras === 'object') {
        if (extras.utilityBillPaymentId != null) {
            utilityExtras.utilityBillPaymentId = String(extras.utilityBillPaymentId || '');
        }
        if (extras.utilityParentBillNumber != null) {
            utilityExtras.utilityParentBillNumber = String(
                extras.utilityParentBillNumber || '',
            );
        }
        if (extras.utilityLineIndex != null && extras.utilityLineIndex !== '') {
            utilityExtras.utilityLineIndex = Number(extras.utilityLineIndex);
        }
        if (extras.utilityDebitAccountId != null) {
            utilityExtras.utilityDebitAccountId = String(extras.utilityDebitAccountId || '');
        }
        if (extras.utilityDebitAccountName != null) {
            utilityExtras.utilityDebitAccountName = String(
                extras.utilityDebitAccountName || '',
            );
        }
        if (extras.utilityItemDescription != null) {
            utilityExtras.utilityItemDescription = String(
                extras.utilityItemDescription || '',
            );
        }
    }

    await ZohoBill.findOneAndUpdate(
        { organizationId, zohoBillId: doc.zohoBillId },
        { $set: { ...doc, ...utilityExtras } },
        { upsert: true, new: true },
    );

    // When Zoho shows the bill as paid, reflect Amount Status on linked vehicle services.
    try {
        const status = String(doc.status || bill?.status || '').toLowerCase();
        const balance = Number(doc.balance ?? bill?.balance ?? NaN);
        const paid =
            status === 'paid' || (Number.isFinite(balance) && Math.abs(balance) < 0.01 && status !== 'draft');
        if (paid && doc.zohoBillId) {
            const { markVehicleGarageServicesPaidFromZohoBillIds } = await import(
                '../utils/markVehicleGarageServicesPaidFromZoho.js'
            );
            await markVehicleGarageServicesPaidFromZohoBillIds([doc.zohoBillId]);
        }
    } catch (err) {
        console.warn(
            '[ZohoPurchaseSync] Vehicle service Paid stamp after bill upsert failed:',
            err?.message || err,
        );
    }

    return { ...doc, ...utilityExtras };
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
        idField: 'zohoBillId',
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
