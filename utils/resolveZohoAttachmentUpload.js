import axios from 'axios';
import { downloadS3ObjectBytes } from './s3Upload.js';

function bufferFromBase64(data) {
    const raw = String(data || '').trim();
    if (!raw) return null;
    let base64 = raw;
    let mimeType = '';
    const dataMatch = raw.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/is);
    if (dataMatch) {
        if (dataMatch[1]) mimeType = String(dataMatch[1]).trim();
        base64 = dataMatch[2];
    } else if (raw.includes(',')) {
        base64 = raw.split(',').pop();
    }
    try {
        const buffer = Buffer.from(String(base64 || '').replace(/\s/g, ''), 'base64');
        if (!buffer.length) return null;
        return { buffer, mimeType };
    } catch {
        return null;
    }
}

function ensureZohoSafeFilename(name, mimeType = '') {
    const raw = String(name || '').trim() || 'attachment';
    const stem = raw.replace(/\.[^.]+$/, '').replace(/[^\w.\-() ]+/g, '_').slice(0, 160) || 'attachment';
    const hasExt = /\.[a-z0-9]{2,5}$/i.test(raw);
    if (hasExt) return raw.slice(0, 200);
    const ext =
        /pdf/i.test(mimeType)
            ? 'pdf'
            : /png/i.test(mimeType)
              ? 'png'
              : /jpe?g/i.test(mimeType)
                ? 'jpg'
                : /gif/i.test(mimeType)
                  ? 'gif'
                  : /webp/i.test(mimeType)
                    ? 'webp'
                    : 'pdf';
    return `${stem}.${ext}`.slice(0, 200);
}

/**
 * Resolve an ERP attachment (base64 / S3 publicId / http(s) url) into Zoho upload bytes.
 */
export async function resolveZohoAttachmentUpload(attachment = {}, fallbackName = 'attachment.pdf') {
    if (!attachment || typeof attachment !== 'object') return null;

    const mimeHint = String(attachment.mimeType || attachment.mime || '').trim();
    const nameHint = String(attachment.name || attachment.filename || '').trim();
    let buffer = null;
    let mimeType = mimeHint;

    const s3Key = String(attachment.publicId || '').trim();
    if (s3Key) {
        try {
            buffer = await downloadS3ObjectBytes(s3Key);
        } catch (err) {
            console.warn('[resolveZohoAttachmentUpload] S3 download failed:', err?.message || err);
        }
    }

    if (!buffer?.length && attachment.data) {
        const parsed = bufferFromBase64(attachment.data);
        if (parsed?.buffer?.length) {
            buffer = parsed.buffer;
            if (!mimeType && parsed.mimeType) mimeType = parsed.mimeType;
        }
    }

    if (!buffer?.length && attachment.base64) {
        const parsed = bufferFromBase64(attachment.base64);
        if (parsed?.buffer?.length) {
            buffer = parsed.buffer;
            if (!mimeType && parsed.mimeType) mimeType = parsed.mimeType;
        }
    }

    const url = String(attachment.url || '').trim();
    if (!buffer?.length && url && /^https?:\/\//i.test(url)) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 60000,
                maxContentLength: 25 * 1024 * 1024,
            });
            buffer = Buffer.from(response.data);
            if (!mimeType && response.headers?.['content-type']) {
                mimeType = String(response.headers['content-type']).split(';')[0].trim();
            }
        } catch (err) {
            console.warn('[resolveZohoAttachmentUpload] URL download failed:', err?.message || err);
        }
    }

    if (!buffer?.length && url && !/^https?:\/\//i.test(url)) {
        try {
            buffer = await downloadS3ObjectBytes(url);
        } catch {
            /* ignore */
        }
    }

    if (!buffer?.length && !s3Key && url) {
        try {
            buffer = await downloadS3ObjectBytes(url);
        } catch {
            /* ignore */
        }
    }

    if (!buffer?.length) return null;

    return {
        buffer,
        filename: ensureZohoSafeFilename(nameHint || fallbackName, mimeType),
        mimeType: mimeType || 'application/pdf',
    };
}

export function attachmentLooksPresent(attachment) {
    if (!attachment || typeof attachment !== 'object') return false;
    return Boolean(
        attachment.data ||
            attachment.base64 ||
            attachment.url ||
            attachment.publicId ||
            attachment.name ||
            attachment.filename,
    );
}
