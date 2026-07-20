import {
    createVendorComment,
    fetchVendorComments,
} from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

function mapComment(row = {}) {
    return {
        id: String(row.comment_id || row.id || '').trim(),
        description: String(row.description || row.comment || '').trim(),
        commentedBy: String(row.commented_by || row.created_by || '').trim(),
        date: String(row.date || '').trim(),
        dateDescription: String(row.date_description || '').trim(),
        time: String(row.time || '').trim(),
        transactionId: String(row.transaction_id || '').trim(),
        transactionType: String(row.transaction_type || '').trim(),
        operationType: String(row.operation_type || '').trim(),
        isEntityDeleted: Boolean(row.is_entity_deleted),
        raw: row,
    };
}

export const getZohoVendorComments = async (req, res) => {
    try {
        const vendorId = String(req.params?.vendorId || '').trim();
        if (!vendorId) {
            return res.status(400).json({ success: false, message: 'Vendor id is required.' });
        }

        const rows = await fetchVendorComments(vendorId);
        const data = rows.map(mapComment).filter((row) => row.id || row.description || row.transactionType);

        return res.status(200).json({
            success: true,
            data,
            meta: { count: data.length, source: 'zoho' },
        });
    } catch (error) {
        console.error('[ZohoVendorComments] Failed:', error?.message || error);
        const message = error?.message || 'Failed to fetch vendor activity from Zoho Books';
        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};

export const postZohoVendorComment = async (req, res) => {
    try {
        const vendorId = String(req.params?.vendorId || '').trim();
        const description = String(req.body?.description || req.body?.comment || '').trim();
        if (!vendorId) {
            return res.status(400).json({ success: false, message: 'Vendor id is required.' });
        }
        if (!description) {
            return res.status(400).json({ success: false, message: 'Comment text is required.' });
        }

        const created = await createVendorComment(vendorId, description);
        return res.status(201).json({
            success: true,
            data: mapComment(created),
            message: 'Comment added.',
        });
    } catch (error) {
        console.error('[ZohoVendorCommentCreate] Failed:', error?.message || error);
        const message = error?.message || 'Failed to add vendor comment in Zoho Books';
        const isValidationError = /required/i.test(message);
        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
