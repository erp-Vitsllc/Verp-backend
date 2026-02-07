import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import s3Client, { bucketName } from '../config/s3Client.js';
import { randomUUID } from 'crypto';

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
        // Clean base64 string
        const cleanBase64 = base64Data.replace(/^data:[\w/]+;base64,/, "");
        const buffer = Buffer.from(cleanBase64, 'base64');

        // Determine Content-Type and Extension
        let contentType = 'application/octet-stream';
        let extension = 'bin';

        const typeMatch = base64Data.match(/^data:([\w/]+);base64,/);
        if (typeMatch) {
            contentType = typeMatch[1];
            extension = contentType.split('/')[1];
        } else if (fileName) {
            // Fallback: Infer from filename extension
            const lowerName = fileName.toLowerCase();
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
        } else {
            // Further fallback based on resourceType
            if (resourceType === 'image') {
                contentType = 'image/jpeg';
                extension = 'jpg';
            }
        }

        // Handle specific extension clarity
        if (contentType === 'application/pdf') extension = 'pdf';
        if (contentType === 'image/jpeg') extension = 'jpg';
        if (contentType === 'image/png') extension = 'png';

        // Generate final filename
        const finalFileName = fileName ? fileName : `${randomUUID()}.${extension}`;

        // Ensure folder doesn't have leading/trailing slashes if it's not empty
        const cleanFolder = folder.replace(/^\/+|\/+$/g, '');
        const key = cleanFolder ? `${cleanFolder}/${finalFileName}` : finalFileName;

        // Upload to S3
        const uploadParams = {
            Bucket: bucketName,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            ACL: 'private' // Secure: Private access only
        };

        await s3Client.send(new PutObjectCommand(uploadParams));

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

        // If key is already a full URL, try to extract the Key
        if (typeof key === 'string' && key.startsWith('http')) {
            // Check if it's our storage URL and extract the key part
            // Match against common folders to find where the key starts
            const folders = ['asset-invoices', 'asset-photos', 'employee-documents', 'profile-pictures', 'signatures', 'rewards', 'fines', 'company-documents'];
            for (const folder of folders) {
                const index = key.indexOf(folder);
                if (index !== -1) {
                    // Extract the key part (folder/filename) and strip query params
                    const extractedKey = key.substring(index).split('?')[0];
                    key = decodeURIComponent(extractedKey);
                    console.log(`[S3Upload] Extracted and decoded key "${key}" from URL`);
                    break;
                }
            }

            // If we still have a URL (wasn't one of ours or couldn't extract), return as is
            if (key.startsWith('http')) return key;
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
        return typeof key === 'string' && key.startsWith('http') ? key : null;
    }
};

/**
 * Delete document from IDrive e2
 * @param {string} key - The S3 key (file path)
 * @returns {Promise<void>}
 */
export const deleteDocumentFromS3 = async (key) => {
    try {
        if (!key) return;

        const deleteParams = {
            Bucket: bucketName,
            Key: key,
        };

        await s3Client.send(new DeleteObjectCommand(deleteParams));
        console.log(`Successfully deleted ${key} from S3`);
    } catch (error) {
        console.error('Error deleting from S3:', error);
        // Don't throw for delete errors to avoid breaking main flows
    }
};
