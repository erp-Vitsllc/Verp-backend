import { getSignedFileUrl, normalizeS3Key } from '../../utils/s3Upload.js';

/**
 * Resolve a DB attachment value (S3 key, publicId, or prior signed URL) to a fresh signed URL.
 */
export const getSignedAttachmentUrl = async (req, res) => {
    try {
        const key = req.body?.key ?? req.query?.key;
        const url = req.body?.url ?? req.query?.url;
        const publicId = req.body?.publicId ?? req.query?.publicId;
        const raw = key || publicId || url;

        if (!raw || typeof raw !== 'string') {
            return res.status(400).json({ message: 'key, url, or publicId is required' });
        }

        const trimmed = raw.trim();
        if (trimmed.startsWith('data:')) {
            return res.status(400).json({ message: 'Inline data cannot be signed. Use the document directly.' });
        }

        const signedUrl = await getSignedFileUrl(trimmed);
        if (!signedUrl) {
            return res.status(404).json({
                message: 'Could not load file from storage.',
            });
        }

        return res.status(200).json({
            url: signedUrl,
            key: normalizeS3Key(trimmed) || null,
        });
    } catch (error) {
        console.error('[getSignedAttachmentUrl]', error);
        return res.status(500).json({
            message: error.message || 'Failed to resolve attachment URL',
        });
    }
};
