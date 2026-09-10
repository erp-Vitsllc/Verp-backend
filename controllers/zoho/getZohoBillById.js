import { fetchBillById } from '../../services/zohoService.js';
import {
    deleteCachedZohoBills,
    upsertZohoBillFromApi,
} from '../../services/zohoPurchaseSyncService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

async function purgeMissingZohoBill(billId) {
    const id = String(billId || '').trim();
    if (!id) return;
    try {
        await deleteCachedZohoBills([id]);
    } catch (syncError) {
        console.warn(
            '[ZohoBillById] Local cache delete after missing Zoho bill failed:',
            syncError?.message || syncError,
        );
    }
}

export const getZohoBillById = async (req, res) => {
    try {
        const billId = String(req.params?.billId || '').trim();
        if (!billId) {
            return res.status(400).json({ success: false, message: 'Bill id is required.' });
        }

        const bill = await fetchBillById(billId);
        if (!bill) {
            await purgeMissingZohoBill(billId);
            return res.status(404).json({ success: false, message: 'Bill not found in Zoho Books.' });
        }

        try {
            await upsertZohoBillFromApi(bill);
        } catch (syncError) {
            console.warn(
                '[ZohoBillById] Zoho fetch ok; local DB upsert failed:',
                syncError?.message || syncError,
            );
        }

        return res.status(200).json({ success: true, data: bill });
    } catch (error) {
        console.error('[ZohoBillById] Failed:', error?.message || error);
        const message = error?.message || 'Failed to fetch bill from Zoho Books';
        if (/not found|does not exist|deleted|invalid.*bill/i.test(message)) {
            await purgeMissingZohoBill(req.params?.billId);
        }
        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
