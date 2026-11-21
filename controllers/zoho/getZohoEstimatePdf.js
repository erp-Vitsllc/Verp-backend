import { fetchZohoEstimatePdf } from '../../services/zohoService.js';

export const getZohoEstimatePdf = async (req, res) => {
    try {
        const estimateId = String(req.query?.estimateId || req.query?.id || '').trim();
        const number = String(req.query?.number || '').trim();
        if (!estimateId && !number) {
            return res.status(400).json({ success: false, message: 'Quotation number is required.' });
        }

        const { buffer, filename, contentType } = await fetchZohoEstimatePdf({ estimateId, number });
        res.setHeader('Content-Type', contentType || 'application/pdf');
        res.setHeader(
            'Content-Disposition',
            `inline; filename="${String(filename).replace(/"/g, '')}"`,
        );
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).send(buffer);
    } catch (error) {
        console.error('[ZohoEstimatePdf] Failed:', error?.message || error);
        const message = error?.message || 'Failed to download the quotation from Zoho Books';
        const status = error.statusCode || (/not connected|not configured|re-authorize/i.test(message) ? 503 : 502);
        return res.status(status).json({ success: false, message });
    }
};
