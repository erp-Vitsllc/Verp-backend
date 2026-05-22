import { runManagementAdminDeletionArchive } from './sendAdminDeletionNotificationEmails.js';
import { buildAttachmentKeysMap } from './listDeletionAttachmentRefs.js';
import { normalizeS3Key } from './s3Upload.js';

const OWNER_DOC_KEYS = [
    'passport',
    'visa',
    'emiratesId',
    'medical',
    'drivingLicense',
    'labourCard',
    'attachment',
];

const COMPANY_ROOT_ATTACHMENT_FIELDS = [
    'tradeLicenseAttachment',
    'establishmentCardAttachment',
    'logo',
];

/**
 * Normalize attachment keys on every admin-deletion snapshot so recovery can find files.
 */
export function enrichDeletionPayloadAttachmentKeys(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const out = { ...payload };
    const keys = { ...(out.attachmentKeys || {}) };

    if (out.fields && typeof out.fields === 'object') {
        Object.assign(keys, buildAttachmentKeysMap(out.fields));
    }

    for (const field of COMPANY_ROOT_ATTACHMENT_FIELDS) {
        if (typeof out[field] === 'string' && out[field].trim()) {
            const k = normalizeS3Key(out[field]);
            if (k) keys[field] = k;
        }
    }

    if (out.document && typeof out.document === 'object') {
        const d = out.document;
        const raw =
            d?.document?.publicId ||
            d?.document?.url ||
            (typeof d?.attachment === 'string' ? d.attachment : null);
        const k = typeof raw === 'string' ? normalizeS3Key(raw) : null;
        if (k) keys.document = k;
    }

    if (out.item && typeof out.item === 'object') {
        const d = out.item;
        const raw = d?.document?.url || d?.document?.publicId;
        const k = typeof raw === 'string' ? normalizeS3Key(raw) : null;
        const fieldKey = out.field ? String(out.field) : 'item';
        if (k) keys[fieldKey] = k;
    }

    if (out.owner && typeof out.owner === 'object') {
        for (const docKey of OWNER_DOC_KEYS) {
            const sub = docKey === 'attachment' ? out.owner.attachment : out.owner[docKey];
            if (typeof sub === 'string') {
                const k = normalizeS3Key(sub);
                if (k) keys[docKey] = k;
            } else if (sub && typeof sub === 'object' && sub.attachment) {
                const k = normalizeS3Key(sub.attachment);
                if (k) keys[docKey] = k;
            }
        }
    }

    collectNestedAttachmentKeys(out, keys);

    if (Object.keys(keys).length) out.attachmentKeys = keys;
    return out;
}

/** Walk snapshot (employee cards, asset docs, collections, etc.) for publicId / attachment fields. */
function collectNestedAttachmentKeys(obj, keys, depth = 0, pathPrefix = '') {
    if (depth > 12 || obj == null) return;
    if (Array.isArray(obj)) {
        obj.forEach((item, i) =>
            collectNestedAttachmentKeys(item, keys, depth + 1, pathPrefix ? `${pathPrefix}[${i}]` : `[${i}]`)
        );
        return;
    }
    if (typeof obj !== 'object') return;

    for (const [key, val] of Object.entries(obj)) {
        if (key === 'attachmentKeys') continue;
        const path = pathPrefix ? `${pathPrefix}.${key}` : key;
        if (typeof val === 'string' && val.trim()) {
            const isRefKey =
                key === 'publicId' ||
                key === 'url' ||
                /attachment$/i.test(key) ||
                key === 'profileImage' ||
                key === 'signature';
            if (isRefKey) {
                const k = normalizeS3Key(val);
                if (k && !keys[path]) keys[path] = k;
            }
        }
        if (val && typeof val === 'object') {
            collectNestedAttachmentKeys(val, keys, depth + 1, path);
        }
    }
}

/** Archive + preserve attachments before live data is removed (never deletes originals). */
export async function awaitAdminDeletionArchive(req, opts = {}) {
    const deletedPayload = enrichDeletionPayloadAttachmentKeys(
        opts.deletedPayload != null ? opts.deletedPayload : {}
    );
    return runManagementAdminDeletionArchive(req, {
        ...opts,
        deletedPayload,
    });
}
