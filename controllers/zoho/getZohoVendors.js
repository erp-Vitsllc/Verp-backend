import { fetchVendors } from '../../services/zohoService.js';

export const getZohoVendors = async (req, res) => {
    try {
        const vendors = await fetchVendors();

        return res.status(200).json({
            success: true,
            data: vendors,
        });
    } catch (error) {
        console.error('[ZohoVendors] Failed:', error?.message || error);

        const message = error?.message || 'Failed to fetch vendors from Zoho Books';
        const status = /not connected|not configured|re-authorize/i.test(message) ? 503 : 502;

        return res.status(status).json({
            success: false,
            message,
        });
    }
};
