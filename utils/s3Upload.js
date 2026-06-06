import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import s3Client, { bucketName } from '../config/s3Client.js';
import { randomUUID } from 'crypto';
import { assertAllowedUploadMime } from './allowedUploadMime.js';

const S3_STORAGE_FOLDER_PREFIXES = [
    'admin-deletion-archive',
    'asset-documents',
    'asset-invoices',
    'asset-photos',
    'asset-service-invoices',
    'asset-service-attachments',
    'employee-documents',
    'employee-profiles',
    'employee-signatures',
    'profile-pictures',
    'user-profiles',
    'signatures',
    'rewards',
    'fines',
    'company-documents',
];

/**
 * Resolve a DB value or signed URL to the underlying S3 object key.
 * @param {string} keyOrUrl
 * @returns {string|null}
 */
export function normalizeS3Key(keyOrUrl) {
    if (!keyOrUrl || typeof keyOrUrl !== 'string') return null;
    let key = keyOrUrl.trim();
    if (!key || key.startsWith('data:')) return null;

    if (key.startsWith('http')) {
        for (const folder of S3_STORAGE_FOLDER_PREFIXES) {
            const index = key.indexOf(folder);
            if (index !== -1) {
                key = decodeURIComponent(key.substring(index).split('?')[0]);
                return key;
            }
        }
        try {
            const parsed = new URL(key);
            let pathKey = decodeURIComponent(String(parsed.pathname || '').replace(/^\/+/, ''));
            const bucketPrefix = `${bucketName}/`;
            if (pathKey.startsWith(bucketPrefix)) {
                pathKey = pathKey.substring(bucketPrefix.length);
            }
            if (pathKey && !pathKey.includes(' ')) return pathKey;
        } catch {
            return null;
        }
        return null;
    }

    return key.replace(/^\/+/, '');
}

export async function s3ObjectExists(key) {
    const normalized = normalizeS3Key(key);
    if (!normalized) return false;
    try {
        await s3Client.send(
            new HeadObjectCommand({
                Bucket: bucketName,
                Key: normalized,
            })
        );
        return true;
    } catch (error) {
        if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return false;
        // HeadObject can fail on permissions while GetObject/sign still works — allow signing to proceed.
        console.warn('[s3ObjectExists]', normalized, error?.message || error);
        return true;
    }
}

/**
 * Normalize a DB attachment value to an S3 key (upload inline base64 objects when needed).
 * @param {string|object|null} value
 * @param {string} folder
 * @param {string} fileName
 * @returns {Promise<string|object|null>}
 */
export async function persistStoredAttachmentValue(value, folder = 'asset-documents', fileName = 'attachment') {
    if (value == null || value === '') return null;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('data:')) {
            const uploadResult = await uploadDocumentToS3(trimmed, folder, fileName);
            return uploadResult.publicId;
        }
        const fromUrl = normalizeS3Key(trimmed);
        if (fromUrl) return fromUrl;
        if (
            trimmed.startsWith('http') ||
            S3_STORAGE_FOLDER_PREFIXES.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix}/`))
        ) {
            return trimmed;
        }
        if (trimmed.length > 80 && !trimmed.includes('/') && !trimmed.includes(' ')) {
            const uploadResult = await uploadDocumentToS3(trimmed, folder, fileName);
            return uploadResult.publicId;
        }
        return trimmed;
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
        if (value.publicId) return String(value.publicId).trim();
        if (value.data) {
            const uploadResult = await uploadDocumentToS3(
                value.data,
                folder,
                value.name || value.fileName || fileName,
            );
            return uploadResult.publicId;
        }
        const url = value.url || value.href;
        if (url) {
            const fromUrl = normalizeS3Key(String(url));
            if (fromUrl) return fromUrl;
        }
    }

    return value;
}

function sanitizeS3FileName(name, fallbackExt = 'pdf') {
    const raw = String(name || '').trim();
    let base = raw.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '-');
    if (!base || base === 'Existing-file-—-click-to-replace') {
        base = `file-${randomUUID()}.${fallbackExt}`;
    }
    if (!base.includes('.')) {
        base = `${base}.${fallbackExt}`;
    }
    return base.slice(0, 180);
}

function inferMimeAndExtension(base64Data, fileName, resourceType) {
    let contentType = 'application/octet-stream';
    let extension = 'bin';

    const typeMatch = String(base64Data || '').match(/^data:([\w/+.+-]+);base64,/i);
    if (typeMatch) {
        contentType = typeMatch[1];
        if (contentType === 'application/pdf') extension = 'pdf';
        else if (contentType === 'image/jpeg') extension = 'jpg';
        else if (contentType === 'image/png') extension = 'png';
        else {
            const tail = contentType.split('/').pop() || '';
            extension = tail.includes('.') ? tail.split('.').pop() : tail || 'bin';
        }
    } else if (fileName) {
        const lowerName = String(fileName).toLowerCase();
        if (lowerName.endsWith('.pdf')) {
            contentType = 'application/pdf';
            extension = 'pdf';
        } else if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
            contentType = 'image/jpeg';
            extension = 'jpg';
        } else if (lowerName.endsWith('.png')) {
            contentType = 'image/png';
            extension = 'png';
        }
    } else if (resourceType === 'image') {
        contentType = 'image/jpeg';
        extension = 'jpg';
    } else if (resourceType === 'raw') {
        contentType = 'application/pdf';
        extension = 'pdf';
    }

    return { contentType, extension };
}

async function putObjectCompat(uploadParams) {
    try {
        await s3Client.send(new PutObjectCommand(uploadParams));
    } catch (error) {
        const msg = String(error?.message || '');
        if (uploadParams.ACL && /ACL|AccessControlList|not supported/i.test(msg)) {
            const { ACL, ...withoutAcl } = uploadParams;
            await s3Client.send(new PutObjectCommand(withoutAcl));
            return;
        }
        throw error;
    }
}

export async function copyS3Object(sourceKey, destKey) {
    const source = normalizeS3Key(sourceKey);
    const dest = normalizeS3Key(destKey);
    if (!source || !dest) throw new Error('Invalid S3 keys for copy.');
    await s3Client.send(
        new CopyObjectCommand({
            Bucket: bucketName,
            CopySource: `${bucketName}/${source}`,
            Key: dest,
        })
    );
    return dest;
}

async function streamToBuffer(body) {
    if (!body) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body.transformToByteArray === 'function') {
        const bytes = await body.transformToByteArray();
        return Buffer.from(bytes);
    }
    const chunks = [];
    for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

/** Copy object into archive folder; falls back to download+upload if server-side copy fails. */
export async function replicateS3ObjectToKey(sourceKey, destKey) {
    const source = normalizeS3Key(sourceKey);
    const dest = normalizeS3Key(destKey);
    if (!source || !dest) throw new Error('Invalid S3 keys for replicate.');

    if (await s3ObjectExists(source)) {
        try {
            await copyS3Object(source, dest);
            return dest;
        } catch (copyErr) {
            console.warn('[replicateS3ObjectToKey] copy failed, trying get/put:', source, copyErr?.message || copyErr);
        }
        const response = await s3Client.send(
            new GetObjectCommand({ Bucket: bucketName, Key: source })
        );
        const buffer = await streamToBuffer(response.Body);
        if (!buffer.length) throw new Error('Source object is empty.');
        await putObjectCompat({
            Bucket: bucketName,
            Key: dest,
            Body: buffer,
            ContentType: response.ContentType || 'application/octet-stream',
        });
        return dest;
    }

    throw new Error(`Source not found in storage: ${source}`);
}

/**
 * Upload document to IDrive e2 (S3 compatible)
 * @param {string} base64Data - Base64 encoded document data
 * @param {string} folder - Folder path (e.g., 'employee-documents/123')
 * @param {string} fileName - Optional file name
 * @param {string} resourceType - 'auto', 'image', 'raw' (used for extension inference)
 * @returns {Promise<{url: string, publicId: string, format: string, resourceType: string}>}
 */
export const uploadDocumentToS3 = async (base64Data, folder = 'employee-documents', fileName = null, resourceType = 'auto') => {
    try {
        if (!base64Data || typeof base64Data !== 'string') {
            throw new Error('No file data provided.');
        }

        let { contentType, extension } = inferMimeAndExtension(base64Data, fileName, resourceType);
        contentType = assertAllowedUploadMime(contentType, fileName, folder);
        if (contentType === 'application/pdf') extension = 'pdf';
        else if (contentType === 'image/jpeg') extension = 'jpg';
        else if (contentType === 'image/png') extension = 'png';

        // Clean base64 string (supports raw base64 or full data: URL)
        const cleanBase64 = String(base64Data)
            .replace(/^data:[\w/+.+-]+;base64,/i, '')
            .replace(/\s/g, '');
        if (!cleanBase64) {
            throw new Error('File data is empty.');
        }

        const buffer = Buffer.from(cleanBase64, 'base64');
        if (!buffer.length) {
            throw new Error('File data is invalid or empty.');
        }

        const safeName = sanitizeS3FileName(fileName, extension);
        const finalFileName = `${randomUUID()}-${safeName}`;

        const cleanFolder = String(folder || '').replace(/^\/+|\/+$/g, '');
        const key = cleanFolder ? `${cleanFolder}/${finalFileName}` : finalFileName;

        const uploadParams = {
            Bucket: bucketName,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            ACL: 'private',
        };

        await putObjectCompat(uploadParams);

        // Generate a temporary signed URL for immediate display
        const signedUrl = await getSignedFileUrl(key);

        return {
            url: signedUrl, // Return signed URL for immediate use
            publicId: key,  // Store this Key in DB for future reference
            format: extension,
            resourceType: resourceType || 'auto'
        };

    } catch (error) {
        console.error('Error uploading to S3:', error);
        throw new Error(`Failed to upload to storage: ${error.message}`);
    }
};

/**
 * Generate a signed URL for a private file
 * @param {string} key - The S3 key (file path) or an existing URL
 * @param {number} expiresIn - Expiration time in seconds (default 86400 = 24 hours)
 * @returns {Promise<string>} Signed URL
 */
export const getSignedFileUrl = async (key, expiresIn = 86400) => {
    try {
        if (!key) return null;

        // If key is already a full URL, try to extract the object key
        const normalizedFromUrl = normalizeS3Key(key);
        if (normalizedFromUrl) {
            key = normalizedFromUrl;
        } else if (typeof key === 'string' && key.startsWith('http')) {
            return null;
        }

        // Handle base64 fallbacks (if any old data exists)
        if (typeof key === 'string' && key.startsWith('data:image')) {
            return key;
        }

        const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: key,
        });

        const url = await getSignedUrl(s3Client, command, { expiresIn });
        return url;
    } catch (error) {
        console.error('Error generating signed URL:', error);
        return null;
    }
};

/** Store S3 object key in DB — never persist expiring signed URLs when the key can be extracted. */
export function attachmentValueForDatabase(value) {
    if (value == null || value === '') return value;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('data:')) return value;
    const key = normalizeS3Key(trimmed);
    return key || trimmed;
}

/**
 * Delete document from IDrive e2
 * @param {string} key - The S3 key (file path)
 * @returns {Promise<void>}
 */
export const deleteDocumentFromS3 = async (key) => {
    try {
        const normalized = normalizeS3Key(key);
        if (!normalized) return;

        const deleteParams = {
            Bucket: bucketName,
            Key: normalized,
        };

        await s3Client.send(new DeleteObjectCommand(deleteParams));
        console.log(`Successfully deleted ${normalized} from S3`);
    } catch (error) {
        console.error('Error deleting from S3:', error);
        // Don't throw for delete errors to avoid breaking main flows
    }
};
