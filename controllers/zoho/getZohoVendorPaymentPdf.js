import { fetchVendorPaymentPdf } from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

export const getZohoVendorPaymentPdf = async (req, res) => {
    try {
        const paymentId = String(req.params?.paymentId || '').trim();
        if (!paymentId) {
            return res.status(400).json({ success: false, message: 'Payment id is required.' });
        }

        const { buffer, filename, contentType } = await fetchVendorPaymentPdf(paymentId);

        res.setHeader('Content-Type', contentType || 'application/pdf');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${String(filename).replace(/"/g, '')}"`,
        );
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).send(buffer);
    } catch (error) {
        console.error('[ZohoVendorPaymentPdf] Failed:', error?.message || error);
        const message = error?.message || 'Failed to download payment PDF from Zoho Books';
        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
