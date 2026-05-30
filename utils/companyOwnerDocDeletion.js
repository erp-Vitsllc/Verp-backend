import { awaitAdminDeletionArchive } from './adminDeletionArchiveRun.js';
import { normalizeS3Key } from './s3Upload.js';

const OWNER_DOC_LABELS = {
    passport: 'Passport',
    visa: 'Visa',
    visitVisa: 'Visit Visa',
    employmentVisa: 'Employment Visa',
    spouseVisa: 'Spouse Visa',
    emiratesId: 'Emirates ID',
    medical: 'Medical Insurance',
    drivingLicense: 'Driving License',
    labourCard: 'Labour Card',
    attachment: 'Owner attachment',
};

function cloneJson(value) {
    if (value == null) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
}

function withAttachmentStorageKey(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    const att = doc.attachment;
    if (typeof att === 'string' && att.trim()) {
        const key = normalizeS3Key(att);
        if (key) doc.attachmentStorageKey = key;
    }
    return doc;
}

export function ownerDocSnapshot(ownerRow, docKey) {
    if (!ownerRow || !docKey) return null;
    if (docKey === 'attachment') {
        const att = ownerRow.attachment;
        if (att == null || att === '') return null;
        if (typeof att === 'string') {
            return withAttachmentStorageKey({ attachment: att });
        }
        return withAttachmentStorageKey(cloneJson(att));
    }
    const sub = ownerRow[docKey];
    if (!sub || typeof sub !== 'object') return null;
    return withAttachmentStorageKey(cloneJson(sub));
}

function buildOwnerDocDeletionPayload(company, ownerRow, docKey, ownerTarget = 'owners') {
    const companyId = company.companyId || String(company._id);
    const companyName = company.name || companyId;
    const ownerName = ownerRow.name || 'Owner';
    const document = ownerDocSnapshot(ownerRow, docKey);
    const attachmentKeys = {};
    if (document?.attachmentStorageKey) {
        attachmentKeys[docKey] = document.attachmentStorageKey;
    }
    return {
        companyId,
        companyName,
        ownerTarget,
        ownerId: ownerRow._id != null ? String(ownerRow._id) : '',
        ownerName,
        docKey,
        document,
        attachmentKeys,
    };
}

/** Copy files to admin-deletion-archive before the live owner doc is removed from MongoDB. */
export async function archiveAdminOwnerDocCardDeletion(req, company, ownerRow, docKey, ownerTarget = 'owners') {
    if (!company || !ownerRow || !docKey) return null;
    const label = OWNER_DOC_LABELS[docKey] || docKey;
    const companyId = company.companyId || String(company._id);
    const companyName = company.name || companyId;
    const ownerName = ownerRow.name || 'Owner';

    return awaitAdminDeletionArchive(req, {
        moduleName: 'Company Owner Document',
        recordId: companyId,
        details: `${label} removed from ${ownerName} (${companyName})`,
        deletedPayload: buildOwnerDocDeletionPayload(company, ownerRow, docKey, ownerTarget),
    });
}

/** Remove a cleared owner doc from queued HR reactivation proposals so UI does not resurrect it. */
export function stripOwnerDocFromPendingReactivation(entries = [], ownerId, docKey) {
    if (!docKey || !Array.isArray(entries)) return entries;
    const oid = ownerId != null ? String(ownerId) : '';
    const sectionKey = `owner${String(docKey).toLowerCase()}`;

    return entries
        .filter((entry) => String(entry?.section || '').toLowerCase() !== sectionKey)
        .map((entry) => {
            if (!oid || !entry?.proposedData || typeof entry.proposedData !== 'object') return entry;
            let pd;
            try {
                pd = JSON.parse(JSON.stringify(entry.proposedData));
            } catch {
                return entry;
            }
            if (!Array.isArray(pd.owners)) return entry;
            let touched = false;
            pd.owners = pd.owners.map((o) => {
                if (String(o?._id || o?.id || '') !== oid) return o;
                touched = true;
                const next = { ...o };
                if (docKey === 'attachment') {
                    delete next.attachment;
                } else {
                    delete next[docKey];
                }
                return next;
            });
            if (!touched) return entry;
            return { ...entry, proposedData: pd };
        });
}

export function ownerDocUnsetPath(ownerTarget, docKey) {
    const prefix = ownerTarget === 'oldOwners' ? 'oldOwners.$[o]' : 'owners.$[live]';
    if (docKey === 'attachment') return `${prefix}.attachment`;
    return `${prefix}.${docKey}`;
}
