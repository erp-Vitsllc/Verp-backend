import { fetchZohoEstimateByNumber, fetchZohoEstimates } from '../../services/zohoService.js';

function mapZohoErrorStatus(message) {
    return /not connected|not configured|re-authorize/i.test(message) ? 503 : 502;
}

export const getZohoEstimates = async (_req, res) => {
    try {
        const data = await fetchZohoEstimates();
        return res.status(200).json({ success: true, data });
    } catch (error) {
        console.error('[ZohoEstimates] Failed:', error?.message || error);
        const message = error?.message || 'Failed to fetch quotations from Zoho Books';
        return res.status(mapZohoErrorStatus(message)).json({ success: false, message });
    }
};

export const getZohoEstimateByNumber = async (req, res) => {
    try {
        const data = await fetchZohoEstimateByNumber(req.query.number);
        return res.status(200).json({ success: true, data });
    } catch (error) {
        console.error('[ZohoEstimates] Lookup failed:', error?.message || error);
        const message = error?.message || 'Failed to fetch the quotation from Zoho Books';
        const status = error.statusCode || mapZohoErrorStatus(message);
        return res.status(status).json({ success: false, message });
    }
};
