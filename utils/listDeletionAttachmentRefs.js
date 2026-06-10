import { normalizeS3Key } from './s3Upload.js';

const STORAGE_KEY_HINT =
    /employee-documents|company-documents|asset-|fines\/|rewards\/|signatures|profile-pictures/i;

const SKIP_OBJECT_KEYS = new Set([
    '_id',
    '__v',
    'buffer',
    'assignedEmployees',
    'pendingReactivationChanges',
    'attachmentStorageKey',
    'attachmentKeys',
]);

function looksLikeStorageRef(value) {
    if (typeof value !== 'string') return false;
    const s = value.trim();
    if (!s || s.startsWith('data:')) return false;
    if (s.startsWith('https://')) return true;
    return STORAGE_KEY_HINT.test(s) || (s.includes('/') && !s.includes(' '));
}

function resolveDocumentStorageRef(doc) {
    if (!doc || typeof doc !== 'object') return { storageRef: '', data: '' };
    const publicId = typeof doc.publicId === 'string' ? doc.publicId.trim() : '';
    const url = typeof doc.url === 'string' ? doc.url.trim() : '';
    const data = typeof doc.data === 'string' ? doc.data.trim() : '';
    if (publicId && looksLikeStorageRef(publicId)) {
        return { storageRef: publicId, data };
    }
    if (url && looksLikeStorageRef(url) && !url.startsWith('https://')) {
        return { storageRef: url, data };
    }
    if (url && looksLikeStorageRef(url)) {
        return { storageRef: url, data };
    }
    if (data && !data.startsWith('http')) {
        return { storageRef: '', data };
    }
    return { storageRef: '', data: '' };
}

function dedupeKeyForRef(ref) {
    const nk = normalizeS3Key(ref.url);
    if (nk) return nk;
    if (ref.data) return `data:${String(ref.data).slice(0, 80)}`;
    return String(ref.url || '').trim();
}

/** Field paths like `visa.document.url` must not become email filenames (Gmail treats `.url` as a shortcut). */
function looksLikeFieldPathName(name) {
    const s = String(name || '').trim();
    if (!s || !s.includes('.')) return false;
    return /\.(url|publicId|data)$/i.test(s);
}

function basenameFromStorageRef(storageRef) {
    try {
        const s = String(storageRef || '').trim();
        if (!s) return '';
        if (s.startsWith('http')) {
            const path = new URL(s).pathname;
            const base = path.split('/').filter(Boolean).pop();
            if (base) return decodeURIComponent(base);
        }
        const base = s.split('/').filter(Boolean).pop();
        if (base) return decodeURIComponent(base);
    } catch {
        /* ignore */
    }
    return '';
}

function resolveNameFromSnapshot(snapshot, fieldPath) {
    if (!snapshot || !fieldPath || typeof fieldPath !== 'string') return '';
    const parts = fieldPath.split('.').filter(Boolean);
    const leaf = parts[parts.length - 1]?.toLowerCase();
    if (leaf === 'url' || leaf === 'publicid' || leaf === 'data') {
        parts.pop();
    }
    let obj = snapshot;
    for (const p of parts) {
        if (obj == null || typeof obj !== 'object') return '';
        obj = obj[p];
    }
    if (obj && typeof obj === 'object') {
        return String(obj.name || obj.fileName || '').trim();
    }
    return '';
}

/**
 * Resolve a safe attachment filename for admin-deletion emails and recovery copies.
 */
export function resolveDeletionAttachmentFileName(fieldPath, storageRef, snapshot = null, index = 0) {
    const fromDoc = snapshot ? resolveNameFromSnapshot(snapshot, fieldPath) : '';
    if (fromDoc && !looksLikeFieldPathName(fromDoc)) return fromDoc;

    const fromKey = basenameFromStorageRef(storageRef);
    if (fromKey && fromKey.includes('.')) return fromKey;

    const field = String(fieldPath || '').trim();
    if (field && /attachment$/i.test(field) && !field.includes('.')) {
        return field;
    }

    if (fromKey) return fromKey.includes('.') ? fromKey : `${fromKey}.pdf`;
    return `deleted-attachment-${index + 1}.pdf`;
}

export { looksLikeFieldPathName, basenameFromStorageRef };

/** Push one uploaded file candidate (deduped by normalized storage key). */
function pushFileCandidate(files, seen, { url, name, label, data }) {
    const storageRef = String(url || '').trim();
    const embedded = String(data || '').trim();
    const candidate = {
        url: storageRef,
        data: embedded,
        name: name ? String(name).trim() : '',
        label: label ? String(label).trim() : '',
    };
    const dedupeKey = dedupeKeyForRef(candidate);
    if (!dedupeKey || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    files.push(candidate);
}

function pushExplicitAttachmentStorageKeys(payload, files, seen) {
    if (!payload || typeof payload !== 'object') return;

    const doc = payload.document;
    const storageKey =
        typeof doc?.attachmentStorageKey === 'string' ? doc.attachmentStorageKey.trim() : '';
    if (storageKey && looksLikeStorageRef(storageKey)) {
        pushFileCandidate(files, seen, {
            url: storageKey,
            name: doc?.fileName || doc?.name || `${payload.docKey || 'document'}-attachment`,
            label: payload.docKey ? `${payload.docKey} attachment` : 'document attachment',
        });
    }

    const attachmentKeys = payload.attachmentKeys;
    if (attachmentKeys && typeof attachmentKeys === 'object') {
        let keyIndex = 0;
        for (const [field, key] of Object.entries(attachmentKeys)) {
            if (typeof key !== 'string' || !key.trim()) continue;
            pushFileCandidate(files, seen, {
                url: key,
                name: resolveDeletionAttachmentFileName(field, key, payload, keyIndex),
                label: field.replace(/Attachment$/i, ' attachment'),
            });
            keyIndex += 1;
        }
    }

    const fields = payload.fields;
    if (fields && typeof fields === 'object') {
        for (const [key, val] of Object.entries(fields)) {
            if (!/Attachment$/i.test(key) || typeof val !== 'string' || !val.trim()) continue;
            const normalized = normalizeS3Key(val);
            if (!normalized) continue;
            pushFileCandidate(files, seen, {
                url: normalized,
                name: key,
                label: key.replace(/Attachment$/i, ' attachment'),
            });
        }
    }
}

function collectUploadedFiles(obj, files, seen, depth = 0, pathPrefix = '') {
    if (depth > 16 || obj == null) return;

    if (typeof obj === 'string') {
        if (looksLikeStorageRef(obj)) {
            pushFileCandidate(files, seen, { url: obj, label: pathPrefix });
        }
        return;
    }

    if (typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
        obj.forEach((item, i) =>
            collectUploadedFiles(item, files, seen, depth + 1, pathPrefix ? `${pathPrefix}[${i}]` : `[${i}]`)
        );
        return;
    }

    if (obj.url || obj.publicId || obj.data) {
        const { storageRef, data } = resolveDocumentStorageRef(obj);
        if (storageRef || data) {
            pushFileCandidate(files, seen, {
                url: storageRef,
                data,
                name: obj.name || obj.fileName,
                label: pathPrefix,
            });
        }
    }

    if (obj.document && typeof obj.document === 'object') {
        const d = obj.document;
        const { storageRef, data } = resolveDocumentStorageRef(d);
        if (storageRef || data) {
            pushFileCandidate(files, seen, {
                url: storageRef,
                data,
                name: d.name,
                label: pathPrefix ? `${pathPrefix} document` : 'document',
            });
        }
    }

    if (typeof obj.attachment === 'string' && looksLikeStorageRef(obj.attachment)) {
        pushFileCandidate(files, seen, { url: obj.attachment, label: pathPrefix || 'attachment' });
    } else if (obj.attachment && typeof obj.attachment === 'object') {
        const { storageRef, data } = resolveDocumentStorageRef(obj.attachment);
        if (storageRef || data) {
            pushFileCandidate(files, seen, {
                url: storageRef,
                data,
                name: obj.attachment.name,
                label: pathPrefix || 'attachment',
            });
        }
    }

    for (const [key, val] of Object.entries(obj)) {
        if (SKIP_OBJECT_KEYS.has(key)) continue;
        const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
        const k = key.toLowerCase();
        if (k.endsWith('attachment') && typeof val === 'string') {
            pushFileCandidate(files, seen, { url: val, label: nextPath });
            continue;
        }
        if (typeof val === 'object' && val !== null) {
            collectUploadedFiles(val, files, seen, depth + 1, nextPath);
        }
    }
}

/**
 * List uploaded file references from a deleted record snapshot (no signing/fetch).
 * @param {object} deletedPayload
 * @returns {{ url: string, name: string, label: string, data?: string }[]}
 */
export function listDeletionAttachmentRefs(deletedPayload) {
    if (deletedPayload == null) return [];
    const files = [];
    const seen = new Set();
    pushExplicitAttachmentStorageKeys(deletedPayload, files, seen);
    collectUploadedFiles(deletedPayload, files, seen);
    return files;
}

export function countDeletionAttachments(deletedPayload) {
    return listDeletionAttachmentRefs(deletedPayload).length;
}

export function buildAttachmentKeysMap(fields = {}) {
    if (!fields || typeof fields !== 'object') return {};
    const out = {};
    for (const [key, val] of Object.entries(fields)) {
        if (!/Attachment$/i.test(key) || typeof val !== 'string' || !val.trim()) continue;
        const normalized = normalizeS3Key(val);
        if (normalized) out[key] = normalized;
    }
    return out;
}
