import axios from 'axios';
import { getSignedFileUrl, normalizeS3Key, s3ObjectExists } from './s3Upload.js';
import { listDeletionAttachmentRefs } from './listDeletionAttachmentRefs.js';

const MAX_FILE_ATTACHMENTS = 8;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

function isBlockedHost(url) {
    return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url);
}

function isFetchableHttpsUrl(url) {
    if (typeof url !== 'string') return false;
    const u = url.trim();
    if (!u.startsWith('https://')) return false;
    if (isBlockedHost(u)) return false;
    return true;
}

const STORAGE_KEY_HINT =
    /employee-documents|company-documents|asset-|fines\/|rewards\/|signatures|profile-pictures/i;

function looksLikeStorageRef(value) {
    if (typeof value !== 'string') return false;
    const s = value.trim();
    if (!s || s.startsWith('data:')) return false;
    if (isFetchableHttpsUrl(s)) return true;
    return STORAGE_KEY_HINT.test(s) || (s.includes('/') && !s.includes(' '));
}

function guessFilename(urlOrKey, preferredName, index) {
    if (preferredName && String(preferredName).trim()) {
        return String(preferredName).trim();
    }
    try {
        if (urlOrKey.startsWith('http')) {
            const path = new URL(urlOrKey).pathname;
            const base = path.split('/').filter(Boolean).pop();
            if (base && base.includes('.')) return decodeURIComponent(base);
        }
        const base = String(urlOrKey).split('/').filter(Boolean).pop();
        if (base && base.includes('.')) return decodeURIComponent(base);
    } catch {
        /* ignore */
    }
    return `deleted-attachment-${index + 1}.pdf`;
}

async function resolveFetchUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (isFetchableHttpsUrl(s)) return s;
    if (s.startsWith('http://')) return null;
    if (!looksLikeStorageRef(s)) return null;
    try {
        const signed = await getSignedFileUrl(s);
        return isFetchableHttpsUrl(signed) ? signed : null;
    } catch {
        return null;
    }
}

async function fetchAsEmailAttachment(rawUrl, preferredName, index) {
    const fetchUrl = await resolveFetchUrl(rawUrl);
    if (!fetchUrl) return null;
    try {
        const response = await axios.get(fetchUrl, {
            responseType: 'arraybuffer',
            timeout: 12_000,
            maxContentLength: MAX_FETCH_BYTES,
            maxBodyLength: MAX_FETCH_BYTES,
        });
        const content = Buffer.from(response.data);
        if (!content.length) return null;
        return {
            filename: guessFilename(fetchUrl, preferredName, index),
            content,
            contentDisposition: 'attachment',
        };
    } catch (e) {
        console.warn('[buildAdminDeletionEmailAttachments] fetch failed:', e?.message || e);
        return null;
    }
}

function filesFromPreserved(preservedAttachments = []) {
    return preservedAttachments
        .filter((p) => !p.unavailable && p.storageKey)
        .map((p) => ({ url: p.storageKey, name: p.name }));
}

/**
 * Only real uploaded files (PDF/images from storage) — no JSON snapshot.
 * @param {object} deletedPayload - Record snapshot before hard delete
 * @param {object[]} [preservedAttachments] - Recovery copies (preferred when present)
 */
export async function buildAdminDeletionEmailAttachments(deletedPayload, preservedAttachments) {
    if (deletedPayload == null && !preservedAttachments?.length) return [];

    const files = preservedAttachments?.length
        ? filesFromPreserved(preservedAttachments)
        : listDeletionAttachmentRefs(deletedPayload);
    const attachments = [];
    let i = 0;
    for (const file of files) {
        if (attachments.length >= MAX_FILE_ATTACHMENTS) break;
        const key = normalizeS3Key(file.url);
        if (key && !(await s3ObjectExists(key))) continue;
        const att = await fetchAsEmailAttachment(file.url, file.name, i);
        if (att) {
            attachments.push(att);
            i += 1;
        }
    }
    return attachments;
}
