import { randomUUID } from 'crypto';
import { listDeletionAttachmentRefs } from './listDeletionAttachmentRefs.js';
import {
    normalizeS3Key,
    s3ObjectExists,
    deleteDocumentFromS3,
    uploadDocumentToS3,
    replicateS3ObjectToKey,
} from './s3Upload.js';

function sanitizeArchiveFileName(name, index) {
    const base = String(name || '')
        .replace(/[/\\?%*:|"<>]/g, '-')
        .trim();
    if (base && base.includes('.')) return base;
    return `file-${index + 1}.pdf`;
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

function storageKeyCandidates(ref) {
    const candidates = [];
    const raw = String(ref?.url || '').trim();
    const normalized = normalizeS3Key(raw);
    if (normalized) candidates.push(normalized);
    if (raw && !raw.startsWith('http') && !candidates.includes(raw)) {
        candidates.push(raw.replace(/^\/+/, ''));
    }
    return [...new Set(candidates.filter(Boolean))];
}

async function findFirstExistingStorageKey(candidates) {
    for (const key of candidates) {
        if (await s3ObjectExists(key)) return key;
    }
    return null;
}

async function tryArchiveFromStorageKeys(candidates, destKey) {
    for (const key of candidates) {
        if (!(await s3ObjectExists(key))) continue;
        try {
            await replicateS3ObjectToKey(key, destKey);
            return key;
        } catch (e) {
            console.warn('[preserveDeletionAttachments] replicate failed:', key, e?.message || e);
        }
    }
    return null;
}

/**
 * Copy deleted record files into admin-deletion-archive/{archiveId}/ so recovery links stay valid.
 * @param {string} archiveId
 * @param {object} snapshot
 */
export async function preserveDeletionAttachments(archiveId, snapshot) {
    const refs = listDeletionAttachmentRefs(snapshot);
    const preserved = [];

    for (let i = 0; i < refs.length; i += 1) {
        const ref = refs[i];
        const name = ref.name || sanitizeArchiveFileName(null, i);
        const label = ref.label ? humanizeLabel(ref.label) : name;
        const fileName = sanitizeArchiveFileName(name, i);
        const storageKey = `admin-deletion-archive/${archiveId}/${randomUUID()}-${fileName}`;
        const candidates = storageKeyCandidates(ref);
        const originalKey = candidates[0] || normalizeS3Key(ref.url) || '';

        const copiedFrom = await tryArchiveFromStorageKeys(candidates, storageKey);
        if (copiedFrom) {
            preserved.push({
                name,
                label,
                originalKey: copiedFrom,
                storageKey,
                unavailable: false,
            });
            continue;
        }

        const existingOriginal = await findFirstExistingStorageKey(candidates);
        if (existingOriginal) {
            preserved.push({
                name,
                label,
                originalKey: existingOriginal,
                storageKey: '',
                retainedOriginalOnly: true,
                unavailable: false,
            });
            continue;
        }

        const embeddedData = ref.data && !String(ref.data).startsWith('http') ? ref.data : '';
        if (embeddedData) {
            try {
                const uploaded = await uploadDocumentToS3(
                    embeddedData,
                    `admin-deletion-archive/${archiveId}`,
                    fileName,
                    'raw'
                );
                preserved.push({
                    name,
                    label,
                    originalKey: originalKey || ref.url || 'embedded',
                    storageKey: uploaded.publicId,
                    unavailable: false,
                });
                continue;
            } catch (e) {
                console.warn('[preserveDeletionAttachments] embedded upload failed:', e?.message || e);
            }
        }

        preserved.push({
            name,
            label,
            originalKey: originalKey || ref.url || '',
            unavailable: true,
            unavailableReason: originalKey
                ? 'File could not be copied to recovery storage. Re-delete after backend restart, or upload the file again before deleting.'
                : 'No storage key was saved for this file — re-upload the document, save, then delete again.',
        });
    }

    return preserved;
}

export async function deletePreservedDeletionAttachments(preservedAttachments = []) {
    const seenOriginals = new Set();
    for (const item of preservedAttachments) {
        if (item?.storageKey && !item.unavailable) {
            await deleteDocumentFromS3(item.storageKey);
        }
        const orig = normalizeS3Key(item?.originalKey);
        if (orig && !orig.startsWith('admin-deletion-archive/') && !seenOriginals.has(orig)) {
            seenOriginals.add(orig);
            await deleteDocumentFromS3(orig);
        }
    }
}

/**
 * Remove original uploaded files referenced in the archive snapshot.
 * Called only on permanent purge (Deleted Records) or 60-day retention — not on live admin delete.
 */
export async function deleteDeletionSnapshotSourceAttachments(snapshot) {
    const refs = listDeletionAttachmentRefs(snapshot);
    const seen = new Set();
    for (const ref of refs) {
        for (const key of storageKeyCandidates(ref)) {
            if (!key || key.startsWith('admin-deletion-archive/') || seen.has(key)) continue;
            seen.add(key);
            await deleteDocumentFromS3(key);
        }
    }
}
