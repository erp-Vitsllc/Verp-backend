import {
    createBillComment,
    fetchBillComments,
} from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

function mapComment(row = {}) {
    return {
        id: String(row.comment_id || row.id || '').trim(),
        description: String(row.description || row.comment || '').trim(),
        commentedBy: String(row.commented_by || row.created_by || '').trim(),
        date: String(row.date || row.created_time || '').trim(),
        dateDescription: String(row.date_description || '').trim(),
        time: String(row.time || '').trim(),
        operationType: String(row.operation_type || '').trim(),
        transactionType: String(row.transaction_type || '').trim(),
        raw: row,
    };
}

export const getZohoBillComments = async (req, res) => {
    try {
        const billId = String(req.params?.billId || '').trim();
        if (!billId) {
            return res.status(400).json({ success: false, message: 'Bill id is required.' });
        }

        const rows = await fetchBillComments(billId);
        const data = rows.map(mapComment).filter((row) => row.id || row.description || row.operationType);

        return res.status(200).json({
            success: true,
            data,
            meta: { count: data.length, source: 'zoho' },
        });
    } catch (error) {
        console.error('[ZohoBillComments] Failed:', error?.message || error);
        const message = error?.message || 'Failed to fetch bill activity from Zoho Books';
        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};

export const postZohoBillComment = async (req, res) => {
    try {
        const billId = String(req.params?.billId || '').trim();
        const description = String(req.body?.description || req.body?.comment || '').trim();
        if (!billId) {
            return res.status(400).json({ success: false, message: 'Bill id is required.' });
        }
        if (!description) {
            return res.status(400).json({ success: false, message: 'Comment text is required.' });
        }

        const created = await createBillComment(billId, description);
        return res.status(201).json({
            success: true,
            data: mapComment(created),
            message: 'Comment added.',
        });
    } catch (error) {
        console.error('[ZohoBillCommentCreate] Failed:', error?.message || error);
        const message = error?.message || 'Failed to add bill comment in Zoho Books';
        const isValidationError = /required/i.test(message);
        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};
