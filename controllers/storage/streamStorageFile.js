import { GetObjectCommand } from '@aws-sdk/client-s3';
import s3Client, { bucketName } from '../../config/s3Client.js';
import { normalizeS3Key } from '../../utils/s3Upload.js';

/**
 * Stream a private object from iDrive through the API (auth required).
 * Avoids browser presigned-URL CORS/signature issues.
 */
export const streamStorageFile = async (req, res) => {
    try {
        const raw = req.query?.key ?? req.query?.url ?? req.query?.publicId;
        if (!raw || typeof raw !== 'string') {
            return res.status(400).json({ message: 'key is required' });
        }

        const key = normalizeS3Key(raw.trim());
        if (!key) {
            return res.status(400).json({ message: 'Invalid storage key' });
        }

        const response = await s3Client.send(
            new GetObjectCommand({
                Bucket: bucketName,
                Key: key,
            }),
        );

        const contentType = response.ContentType || 'application/octet-stream';
        const fileName = (key.split('/').pop() || 'document').replace(/[^\w.\-]/g, '_');

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
        res.setHeader('Cache-Control', 'private, max-age=120');

        const body = response.Body;
        if (body && typeof body.pipe === 'function') {
            body.pipe(res);
            return;
        }

        if (body && typeof body.transformToByteArray === 'function') {
            const bytes = await body.transformToByteArray();
            return res.send(Buffer.from(bytes));
        }

        return res.status(500).json({ message: 'Empty file in storage' });
    } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        if (status === 404 || error?.name === 'NoSuchKey' || error?.name === 'NotFound') {
            return res.status(404).json({ message: 'File not found in storage' });
        }
        console.error('[streamStorageFile]', error?.message || error);
        return res.status(500).json({ message: 'Failed to load file from storage' });
    }
};
