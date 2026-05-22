import { getSignedFileUrl, normalizeS3Key, s3ObjectExists } from './s3Upload.js';
import { listDeletionAttachmentRefs } from './listDeletionAttachmentRefs.js';

function guessFilename(urlOrKey, preferredName, index) {
    if (preferredName && String(preferredName).trim()) {
        return String(preferredName).trim();
    }
    try {
        const base = String(urlOrKey).split('/').filter(Boolean).pop();
        if (base && base.includes('.')) return decodeURIComponent(base);
    } catch {
        /* ignore */
    }
    return `attachment-${index + 1}.pdf`;
}

function humanizeLabel(path) {
    const parts = String(path || '')
        .split('.')
        .filter(Boolean)
        .map((p) =>
            p
                .replace(/([A-Z])/g, ' $1')
                .replace(/[_-]/g, ' ')
                .trim()
        );
    return parts.join(' · ') || 'Attachment';
}

async function signKeyIfExists(storageKey) {
    const key = normalizeS3Key(storageKey);
    if (!key) return null;
    if (!(await s3ObjectExists(key))) return null;
    const signed = await getSignedFileUrl(key);
    return signed && signed.startsWith('https://') ? signed : null;
}

function dedupeSignedAttachments(list) {
    const out = [];
    const seen = new Set();
    for (const item of list) {
        if (!item?.url) {
            out.push(item);
            continue;
        }
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        out.push(item);
    }
    return out;
}

async function signFromSnapshotRefs(snapshot, skipKeys = new Set()) {
    const refs = listDeletionAttachmentRefs(snapshot);
    const out = [];
    let i = 0;
    for (const ref of refs) {
        const key = normalizeS3Key(ref.url);
        if (!key || skipKeys.has(key)) {
            i += 1;
            continue;
        }
        const url = await signKeyIfExists(key);
        if (url) {
            skipKeys.add(key);
            out.push({
                name: ref.name || guessFilename(ref.url, ref.name, i),
                label: ref.label ? humanizeLabel(ref.label) : ref.name || guessFilename(ref.url, ref.name, i),
                url,
                unavailable: false,
            });
        }
        i += 1;
    }
    return out;
}

/**
 * Signed HTTPS URLs for viewing attachments from recovery storage or original S3 keys.
 * Admin live-delete does not remove originals; purge / 60-day retention does.
 */
export async function signDeletionAttachmentUrls(snapshot, preservedAttachments) {
    const signedKeys = new Set();
    const out = [];

    if (Array.isArray(preservedAttachments) && preservedAttachments.length > 0) {
        for (const item of preservedAttachments) {
            let url = null;
            let usedKey = null;
            if (!item.unavailable && item.storageKey) {
                url = await signKeyIfExists(item.storageKey);
                usedKey = normalizeS3Key(item.storageKey);
            }
            if (!url && item.originalKey) {
                url = await signKeyIfExists(item.originalKey);
                usedKey = normalizeS3Key(item.originalKey);
            }
            if (url && usedKey) {
                signedKeys.add(usedKey);
                out.push({
                    name: item.name || guessFilename(usedKey, item.name, out.length),
                    label: item.label || item.name || 'Attachment',
                    url,
                    unavailable: false,
                });
                continue;
            }
            out.push({
                name: item.name || 'Attachment',
                label: item.label || item.name || 'Attachment',
                url: null,
                unavailable: true,
                unavailableReason:
                    item.unavailableReason ||
                    'File is not in storage. Re-upload on the company page, save, then delete again.',
            });
        }
    }

    const fromSnapshot = await signFromSnapshotRefs(snapshot, signedKeys);
    const merged = dedupeSignedAttachments([...out.filter((a) => !a.unavailable && a.url), ...fromSnapshot]);

    if (merged.length) return merged;

    if (out.length) return out;

    return signFromSnapshotRefs(snapshot, new Set());
}
