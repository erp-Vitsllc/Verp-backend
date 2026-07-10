const normType = (t) => String(t || '').toLowerCase().trim();

const dateKey = (value) => {
    if (!value) return '';
    const t = new Date(value);
    if (Number.isNaN(t.getTime())) return String(value).trim().slice(0, 10);
    return t.toISOString().slice(0, 10);
};

function parseDescription(doc) {
    if (!doc?.description) return {};
    try {
        return JSON.parse(doc.description);
    } catch {
        return { text: String(doc.description) };
    }
}

function registrationAttachmentsForDoc(mainDoc, list) {
    if (!mainDoc || normType(mainDoc.type) !== 'registration') return [];
    const issueKey = dateKey(mainDoc.issueDate);
    const expiryKey = dateKey(mainDoc.expiryDate);
    return (list || []).filter((d) => {
        if (normType(d.type) !== 'registration attachment') return false;
        return dateKey(d.issueDate) === issueKey && dateKey(d.expiryDate) === expiryKey;
    });
}

function insuranceAttachmentsForDoc(mainDoc, list) {
    if (!mainDoc || normType(mainDoc.type) !== 'insurance') return [];
    const issueKey = dateKey(mainDoc.issueDate);
    const expiryKey = dateKey(mainDoc.expiryDate);
    return (list || []).filter((d) => {
        if (normType(d.type) !== 'insurance attachment') return false;
        if (String(d.description || '').toLowerCase().includes('invoice')) return false;
        return dateKey(d.issueDate) === issueKey && dateKey(d.expiryDate) === expiryKey;
    });
}

function warrantyAttachmentsForDoc(mainDoc, list) {
    if (!mainDoc || normType(mainDoc.type) !== 'warranty') return [];
    const issueKey = dateKey(mainDoc.issueDate);
    const expiryKey = dateKey(mainDoc.expiryDate);
    return (list || []).filter((d) => {
        if (normType(d.type) !== 'warranty attachment') return false;
        return dateKey(d.issueDate) === issueKey && dateKey(d.expiryDate) === expiryKey;
    });
}

function permitAttachmentsForDoc(mainDoc, list) {
    if (!mainDoc || normType(mainDoc.type) !== 'permit') return [];
    const issueKey = dateKey(mainDoc.issueDate);
    return (list || []).filter((d) => {
        if (normType(d.type) !== 'permit attachment') return false;
        return dateKey(d.issueDate) === issueKey;
    });
}

function resolveParentDocument(doc, allDocs) {
    const t = normType(doc?.type);
    if (t === 'registration attachment') {
        const issueKey = dateKey(doc.issueDate);
        const expiryKey = dateKey(doc.expiryDate);
        return (allDocs || []).find(
            (d) =>
                normType(d.type) === 'registration' &&
                dateKey(d.issueDate) === issueKey &&
                dateKey(d.expiryDate) === expiryKey,
        );
    }
    if (t === 'insurance attachment') {
        const issueKey = dateKey(doc.issueDate);
        const expiryKey = dateKey(doc.expiryDate);
        return (allDocs || []).find(
            (d) =>
                normType(d.type) === 'insurance' &&
                dateKey(d.issueDate) === issueKey &&
                dateKey(d.expiryDate) === expiryKey,
        );
    }
    if (t === 'warranty attachment') {
        const issueKey = dateKey(doc.issueDate);
        const expiryKey = dateKey(doc.expiryDate);
        return (allDocs || []).find(
            (d) =>
                normType(d.type) === 'warranty' &&
                dateKey(d.issueDate) === issueKey &&
                dateKey(d.expiryDate) === expiryKey,
        );
    }
    if (t === 'permit attachment') {
        const issueKey = dateKey(doc.issueDate);
        return (allDocs || []).find(
            (d) =>
                normType(d.type) === 'permit' && dateKey(d.issueDate) === issueKey,
        );
    }
    return null;
}

/** Primary + related attachments for a registration or insurance renewal group. */
export function collectVehicleRenewalDocumentGroup(asset, documentId) {
    if (!asset?.documents?.length || !documentId) return [];
    const doc = asset.documents.id(documentId);
    if (!doc) return [];

    const all = asset.documents;
    const t = normType(doc.type);

    if (t === 'insurance' || t === 'insurance attachment') {
        const primary = t === 'insurance' ? doc : resolveParentDocument(doc, all) || doc;
        return [primary, ...insuranceAttachmentsForDoc(primary, all)];
    }
    if (t === 'registration' || t === 'registration attachment') {
        const primary = t === 'registration' ? doc : resolveParentDocument(doc, all) || doc;
        return [primary, ...registrationAttachmentsForDoc(primary, all)];
    }
    if (t === 'warranty' || t === 'warranty attachment') {
        const primary = t === 'warranty' ? doc : resolveParentDocument(doc, all) || doc;
        return [primary, ...warrantyAttachmentsForDoc(primary, all)];
    }
    if (t === 'permit' || t === 'permit attachment') {
        const primary = t === 'permit' ? doc : resolveParentDocument(doc, all) || doc;
        return [primary, ...permitAttachmentsForDoc(primary, all)];
    }
    return [doc];
}

function markSubdocumentRenewed(subdoc, { notRenewed = false } = {}) {
    const meta = parseDescription(subdoc);
    meta.isRenewed = true;
    meta.renewedAt = meta.renewedAt || new Date().toISOString();
    // Match employee oldDocuments archiveReason: Replaced vs Not Renewed
    meta.archiveReason = notRenewed ? 'Not Renewed' : 'Replaced';
    if (notRenewed) {
        meta.notRenewed = true;
        meta.notRenewedAt = meta.notRenewedAt || new Date().toISOString();
    } else {
        delete meta.notRenewed;
        delete meta.notRenewedAt;
    }
    subdoc.description = JSON.stringify(meta);
    subdoc.status = 'old';
}

/** Apply archived status when description JSON marks a row renewed / not renewed. */
export function syncVehicleDocumentStatusFromDescription(doc) {
    if (!doc || doc.description == null) return;
    try {
        const meta = parseDescription(doc);
        if (meta.isRenewed || meta.notRenewed) {
            doc.status = 'old';
        }
    } catch {
        /* non-JSON description */
    }
}

/**
 * After a renew posts new live docs, archive the superseded registration / insurance group.
 */
export function finalizeVehicleDocumentRenewal(asset, oldDocumentId, newDocumentId = null) {
    if (!asset || !oldDocumentId) return;

    const group = collectVehicleRenewalDocumentGroup(asset, oldDocumentId);
    const seen = new Set();

    for (const row of group) {
        const id = String(row?._id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const sub = asset.documents.id(id);
        if (sub) markSubdocumentRenewed(sub);
    }

    if (newDocumentId) {
        const newDoc = asset.documents.id(newDocumentId);
        if (newDoc) {
            const meta = parseDescription(newDoc);
            meta.renewedFrom = String(oldDocumentId);
            meta.renewedAt = meta.renewedAt || new Date().toISOString();
            newDoc.description = JSON.stringify(meta);
        }
    }

    syncVehicleExpiryFieldsFromLiveDocuments(asset);
}

function pickLatestLiveDoc(asset, primaryType) {
    const docs = (asset.documents || []).filter((d) => normType(d.type) === primaryType);
    const live = docs.filter((d) => {
        const status = String(d.status || d.documentStatus || '').toLowerCase();
        if (['old', 'renewed', 'archived', 'inactive'].includes(status)) return false;
        const meta = parseDescription(d);
        return !meta.isRenewed && !meta.notRenewed;
    });
    const pool = live.length ? live : docs;
    if (!pool.length) return null;
    return [...pool].sort((a, b) => {
        const ta = new Date(a.issueDate || a.expiryDate || a.createdAt || 0).getTime();
        const tb = new Date(b.issueDate || b.expiryDate || b.createdAt || 0).getTime();
        return tb - ta;
    })[0];
}

export function syncVehicleExpiryFieldsFromLiveDocuments(asset) {
    if (!asset) return;
    const reg = pickLatestLiveDoc(asset, 'registration');
    const ins = pickLatestLiveDoc(asset, 'insurance');
    if (reg?.expiryDate) asset.registrationExpiryDate = reg.expiryDate;
    if (ins?.expiryDate) asset.insuranceExpiryDate = ins.expiryDate;
}

export function isRenewPrimaryDocumentType(typeName) {
    const t = normType(typeName);
    return t === 'registration' || t === 'insurance';
}
