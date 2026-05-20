import axios from 'axios';
import { getSignedFileUrl } from './s3Upload.js';

const MAX_FILE_ATTACHMENTS = 8;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

const STORAGE_KEY_HINT =
    /employee-documents|company-documents|asset-|fines\/|rewards\/|signatures|profile-pictures/i;

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

/** Push one uploaded file candidate (deduped by url/key). */
function pushFileCandidate(files, seen, { url, name }) {
    const u = String(url || '').trim();
    if (!u || seen.has(u)) return;
    if (!looksLikeStorageRef(u)) return;
    seen.add(u);
    files.push({ url: u, name: name ? String(name).trim() : '' });
}

function collectUploadedFiles(obj, files, seen, depth = 0) {
    if (depth > 16 || obj == null) return;

    if (typeof obj === 'string') {
        if (looksLikeStorageRef(obj)) {
            pushFileCandidate(files, seen, { url: obj });
        }
        return;
    }

    if (typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
        obj.forEach((item) => collectUploadedFiles(item, files, seen, depth + 1));
        return;
    }

    // { url, name, publicId, mimeType } — fine/reward attachment blob
    if (obj.url || obj.publicId) {
        pushFileCandidate(files, seen, {
            url: obj.url || obj.publicId,
            name: obj.name || obj.fileName,
        });
    }

    // { document: { url, publicId, name } }
    if (obj.document && typeof obj.document === 'object') {
        const d = obj.document;
        pushFileCandidate(files, seen, {
            url: d.url || d.publicId,
            name: d.name,
        });
    }

    // Legacy string attachment field on company/employee cards
    if (typeof obj.attachment === 'string' && looksLikeStorageRef(obj.attachment)) {
        pushFileCandidate(files, seen, { url: obj.attachment });
    } else if (obj.attachment && typeof obj.attachment === 'object') {
        pushFileCandidate(files, seen, {
            url: obj.attachment.url || obj.attachment.publicId,
            name: obj.attachment.name,
        });
    }

    for (const [key, val] of Object.entries(obj)) {
        if (['_id', '__v', 'buffer', 'assignedEmployees', 'pendingReactivationChanges'].includes(key)) {
            continue;
        }
        const k = key.toLowerCase();
        if (k.endsWith('attachment') && typeof val === 'string') {
            pushFileCandidate(files, seen, { url: val });
            continue;
        }
        if (typeof val === 'object' && val !== null) {
            collectUploadedFiles(val, files, seen, depth + 1);
        }
    }
}

/**
 * Only real uploaded files (PDF/images from storage) — no JSON snapshot.
 * @param {object} deletedPayload - Record snapshot before hard delete
 */
export async function buildAdminDeletionEmailAttachments(deletedPayload) {
    if (deletedPayload == null) return [];

    const files = [];
    const seen = new Set();
    collectUploadedFiles(deletedPayload, files, seen);

    const attachments = [];
    let i = 0;
    for (const file of files) {
        if (attachments.length >= MAX_FILE_ATTACHMENTS) break;
        const att = await fetchAsEmailAttachment(file.url, file.name, i);
        if (att) {
            attachments.push(att);
            i += 1;
        }
    }
    return attachments;
}
