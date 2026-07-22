import multer from 'multer';
import { uploadBillAttachment } from '../../services/zohoService.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
});

export const uploadZohoBillAttachmentMiddleware = upload.single('attachment');

/**
 * POST /zoho/bills/:billId/attachment
 * Upload a supporting file onto the Zoho bill (used by Record Payment form).
 */
export async function postZohoBillAttachment(req, res) {
    try {
        const billId = String(req.params?.billId || '').trim();
        if (!billId) {
            return res.status(400).json({ message: 'Bill id is required.' });
        }

        const file = req.file;
        if (!file?.buffer?.length) {
            return res.status(400).json({ message: 'Attachment file is required.' });
        }

        const result = await uploadBillAttachment(billId, {
            buffer: file.buffer,
            filename: file.originalname || 'attachment.pdf',
            mimeType: file.mimetype || 'application/pdf',
        });

        return res.status(200).json({
            success: true,
            message: 'Attachment uploaded to Zoho bill.',
            data: result || {},
        });
    } catch (error) {
        const status = mapZohoErrorStatus(error) || error?.statusCode || 502;
        return res.status(status).json({
            message: error?.message || 'Failed to upload attachment to Zoho bill.',
        });
    }
}
