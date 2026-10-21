import { syncZohoContactsFromApi } from './zohoContactSyncService.js';
import {
    syncZohoBillsChunk,
    syncZohoExpensesChunk,
    syncZohoVendorPaymentsChunk,
} from './zohoPurchaseSyncService.js';

const HOUR_MS = 60 * 60 * 1000;
let running = false;

async function drainChunks(label, syncChunk) {
    const syncToken = `hourly-${Date.now()}-${label}`;
    let zohoPage = 1;
    let upserted = 0;
    let removed = 0;

    for (let step = 0; step < 500; step += 1) {
        const chunk = await syncChunk({
            sync: 'true',
            zohoPage,
            chunkLimit: 400,
            syncToken,
        });
        upserted += Number(chunk?.upserted) || 0;
        removed += Number(chunk?.deactivated) || 0;
        if (!chunk?.hasMore) break;
        const next = Number(chunk.nextZohoPage);
        zohoPage = Number.isFinite(next) && next > zohoPage ? next : zohoPage + 1;
    }

    return { upserted, removed };
}

/** Pull Zoho Books into ERP, then the open screens can reload from ERP. */
export async function syncZohoIntoErp() {
    if (running) {
        console.log('[ZohoSync] hourly refresh already running');
        return;
    }
    running = true;
    const started = Date.now();
    try {
        const contacts = await syncZohoContactsFromApi({ type: 'all' });
        const bills = await drainChunks('bills', syncZohoBillsChunk);
        const expenses = await drainChunks('expenses', syncZohoExpensesChunk);
        const payments = await drainChunks('payments', syncZohoVendorPaymentsChunk);
        console.log(
            `[ZohoSync] hourly refresh done in ${Math.round((Date.now() - started) / 1000)}s`,
            {
                customers: contacts?.customers?.upserted ?? contacts?.customers?.count,
                vendors: contacts?.vendors?.upserted ?? contacts?.vendors?.count,
                bills,
                expenses,
                payments,
            },
        );
    } finally {
        running = false;
    }
}

export const ZOHO_ERP_SYNC_MS = HOUR_MS;
