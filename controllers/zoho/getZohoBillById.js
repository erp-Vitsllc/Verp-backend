import { fetchBillById } from '../../services/zohoService.js';
import { upsertZohoBillFromApi } from '../../services/zohoPurchaseSyncService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

export const getZohoBillById = async (req, res) => {
    try {
        const billId = String(req.params?.billId || '').trim();
        if (!billId) {
            return res.status(400).json({ success: false, message: 'Bill id is required.' });
        }

        const bill = await fetchBillById(billId);
        if (!bill) {
            try {
                const { deleteUtilityBillsForRemovedZohoBills } = await import(
                    '../../utils/deleteUtilityBillsForRemovedZohoBills.js'
                );
                await deleteUtilityBillsForRemovedZohoBills([billId]);
            } catch (syncError) {
                console.warn(
                    '[ZohoBillById] Utility delete after missing Zoho bill failed:',
                    syncError?.message || syncError,
                );
            }
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
            try {
                const { deleteUtilityBillsForRemovedZohoBills } = await import(
                    '../../utils/deleteUtilityBillsForRemovedZohoBills.js'
                );
                await deleteUtilityBillsForRemovedZohoBills([String(req.params?.billId || '').trim()]);
            } catch (syncError) {
                console.warn(
                    '[ZohoBillById] Utility delete after Zoho bill error failed:',
                    syncError?.message || syncError,
                );
            }
        }
        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
