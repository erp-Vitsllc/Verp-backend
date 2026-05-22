/**
 * Resolve asset subdocument ids to delete together (parent + linked attachments).
 */

function normDocType(t) {
    return String(t || '').toLowerCase().trim();
}

function docDateKey(value) {
    if (!value) return '';
    const t = new Date(value);
    if (Number.isNaN(t.getTime())) return String(value).trim().slice(0, 10);
    return t.toISOString().slice(0, 10);
}

function isInsuranceInvoiceAttachmentLabel(doc) {
    return String(doc?.description || doc?.name || '').toLowerCase().includes('invoice');
}

function documentMatchesParent(mainDoc, childDoc) {
    const parentType = normDocType(mainDoc?.type);
    const childType = normDocType(childDoc?.type);

    if (parentType === 'permit' && childType === 'permit attachment') {
        return String(childDoc.issueDate || '') === String(mainDoc.issueDate || '');
    }
    if (parentType === 'registration' && childType === 'registration attachment') {
        return (
            String(childDoc.issueDate || '') === String(mainDoc.issueDate || '') &&
            String(childDoc.expiryDate || '') === String(mainDoc.expiryDate || '')
        );
    }
    if (parentType === 'insurance' && childType === 'insurance attachment') {
        if (isInsuranceInvoiceAttachmentLabel(childDoc)) return false;
        if (!childDoc.attachment) return false;
        if (!String(childDoc.description || '').trim()) return false;
        return (
            docDateKey(childDoc.issueDate) === docDateKey(mainDoc.issueDate) &&
            docDateKey(childDoc.expiryDate) === docDateKey(mainDoc.expiryDate)
        );
    }
    if (parentType === 'warranty' && childType === 'warranty attachment') {
        if (!childDoc.attachment) return false;
        if (!String(childDoc.description || '').trim()) return false;
        return (
            docDateKey(childDoc.issueDate) === docDateKey(mainDoc.issueDate) &&
            docDateKey(childDoc.expiryDate) === docDateKey(mainDoc.expiryDate)
        );
    }
    if (parentType === 'petrol' && childType === 'petrol attachment') {
        return true;
    }
    if (parentType === 'toll' && childType === 'toll attachment') {
        return true;
    }
    return false;
}

/**
 * @param {import('mongoose').Document[]} documents
 * @param {string} primaryDocId
 * @returns {string[]} Mongo ids to pull (primary first, then attachments)
 */
export function collectAssetDocumentIdsForDeletion(documents, primaryDocId) {
    const primaryId = String(primaryDocId || '').trim();
    if (!primaryId) return [];

    const list = Array.isArray(documents) ? documents : [];
    const mainDoc = list.find((d) => String(d?._id || '') === primaryId);
    if (!mainDoc) return [primaryId];

    const ids = new Set([primaryId]);
    for (const d of list) {
        const id = String(d?._id || '');
        if (!id || ids.has(id)) continue;
        if (documentMatchesParent(mainDoc, d)) {
            ids.add(id);
        }
    }
    return [...ids];
}
