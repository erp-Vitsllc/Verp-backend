import {
    fetchVendorPaymentById,
    getZohoOrganizationId,
} from '../../services/zohoService.js';
import { upsertZohoVendorPaymentFromApi } from '../../services/zohoPurchaseSyncService.js';
import ZohoVendorPayment from '../../models/ZohoVendorPayment.js';
import { toZohoVendorPaymentApiShape } from '../../utils/zohoPurchaseMappers.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

async function findLocalVendorPayment(paymentId) {
    const organizationId = getZohoOrganizationId();
    const doc = await ZohoVendorPayment.findOne({
        organizationId,
        zohoPaymentId: paymentId,
    }).lean();

    if (!doc) return null;
    return toZohoVendorPaymentApiShape(doc);
}

export const getZohoVendorPaymentById = async (req, res) => {
    try {
        const paymentId = String(req.params?.paymentId || '').trim();
        if (!paymentId) {
            return res.status(400).json({ success: false, message: 'Payment id is required.' });
        }

        try {
            const payment = await fetchVendorPaymentById(paymentId);
            if (payment) {
                try {
                    await upsertZohoVendorPaymentFromApi(payment);
                } catch (syncError) {
                    console.warn(
                        '[ZohoVendorPaymentById] Zoho fetch ok; local DB upsert failed:',
                        syncError?.message || syncError,
                    );
                }

                return res.status(200).json({ success: true, data: payment, meta: { source: 'zoho' } });
            }
        } catch (zohoError) {
            console.warn(
                '[ZohoVendorPaymentById] Zoho fetch failed, trying local cache:',
                zohoError?.message || zohoError,
            );

            const cached = await findLocalVendorPayment(paymentId);
            if (cached) {
                return res.status(200).json({
                    success: true,
                    data: cached,
                    meta: {
                        source: 'database',
                        syncError: zohoError?.message || 'Zoho vendor payment fetch failed',
                    },
                });
            }

            const message = zohoError?.message || 'Failed to fetch payment from Zoho Books';
            return res.status(mapZohoErrorStatus(message)).json({
                success: false,
                message,
            });
        }

        const cached = await findLocalVendorPayment(paymentId);
        if (cached) {
            return res.status(200).json({
                success: true,
                data: cached,
                meta: { source: 'database' },
            });
        }

        return res.status(404).json({ success: false, message: 'Payment not found in Zoho Books.' });
    } catch (error) {
        console.error('[ZohoVendorPaymentById] Failed:', error?.message || error);
        const message = error?.message || 'Failed to fetch payment from Zoho Books';
        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
