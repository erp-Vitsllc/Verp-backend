import { GetObjectCommand } from '@aws-sdk/client-s3';
import s3Client, { bucketName } from '../../config/s3Client.js';
import { getS3ReadBucketNames } from '../../config/storageConfig.js';
import { normalizeS3Key } from '../../utils/s3Upload.js';

function isMissingObjectError(error) {
    const status = error?.$metadata?.httpStatusCode;
    return status === 404 || error?.name === 'NoSuchKey' || error?.name === 'NotFound';
}

/**
 * Stream a private object from Wasabi through the API (auth required).
 * Avoids browser presigned-URL CORS/DNS issues. Tries primary + fallback buckets.
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

        const buckets = getS3ReadBucketNames();
        if (!buckets.length) {
            return res.status(500).json({ message: 'Storage bucket is not configured' });
        }

        let response = null;
        let usedBucket = null;
        let lastError = null;

        for (const bucket of buckets) {
            try {
                response = await s3Client.send(
                    new GetObjectCommand({
                        Bucket: bucket,
                        Key: key,
                    }),
                );
                usedBucket = bucket;
                break;
            } catch (error) {
                lastError = error;
                if (isMissingObjectError(error)) continue;
                console.error(
                    `[streamStorageFile] bucket=${bucket} key=${key}`,
                    error?.message || error,
                );
                return res.status(500).json({ message: 'Failed to load file from storage' });
            }
        }

        if (!response) {
            console.warn(
                `[streamStorageFile] missing object buckets=${buckets.join(',')} key=${key || raw || '(none)'}`,
                lastError?.message || '',
            );
            return res.status(404).json({
                message: 'File not found in storage',
                bucket: bucketName || null,
                key: key || null,
            });
        }

        const contentType = response.ContentType || 'application/octet-stream';
        const fileName = (key.split('/').pop() || 'document').replace(/[^\w.\-]/g, '_');

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
        res.setHeader('Cache-Control', 'private, max-age=120');
        if (usedBucket) res.setHeader('X-Storage-Bucket', usedBucket);

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
        const raw = req.query?.key ?? req.query?.url ?? req.query?.publicId;
        const key = typeof raw === 'string' ? normalizeS3Key(raw.trim()) : null;
        console.error(
            `[streamStorageFile] bucket=${bucketName || '(unset)'} key=${key || raw || '(none)'}`,
            error?.message || error,
        );
        return res.status(500).json({ message: 'Failed to load file from storage' });
    }
};
