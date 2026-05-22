export const ALLOWED_UPLOAD_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const IMAGE_ONLY_FOLDER_HINTS = [
    'profile-pictures',
    'employee-signatures',
    'signatures',
    'asset-photos',
];

/**
 * Resolve and validate MIME for document uploads. Throws if not PDF/JPEG/PNG.
 * @param {string} folder - S3 folder path (image-only folders reject PDF)
 */
export function assertAllowedUploadMime(contentType, fileName, folder = '') {
    let ct = String(contentType || '')
        .toLowerCase()
        .split(';')[0]
        .trim();

    const lowerName = String(fileName || '').toLowerCase();
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(ct)) {
        if (lowerName.endsWith('.pdf')) ct = 'application/pdf';
        else if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) ct = 'image/jpeg';
        else if (lowerName.endsWith('.png')) ct = 'image/png';
    }

    if (!ALLOWED_UPLOAD_MIME_TYPES.has(ct)) {
        throw new Error('Only PDF, JPG, and PNG files are allowed.');
    }

    const folderStr = String(folder || '').toLowerCase();
    const imageOnly = IMAGE_ONLY_FOLDER_HINTS.some((hint) => folderStr.includes(hint));
    if (imageOnly && ct === 'application/pdf') {
        throw new Error('This upload only allows JPG and PNG images.');
    }

    return ct;
}
