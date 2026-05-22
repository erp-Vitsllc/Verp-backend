import { getSignedFileUrl, attachmentValueForDatabase } from './s3Upload.js';

const OWNER_DOC_KEYS = ['passport', 'visa', 'emiratesId', 'medical', 'drivingLicense', 'labourCard'];

/** Persist S3 keys in DB — strip expiring signed URLs from company PATCH payloads. */
export function normalizeCompanyUpdateAttachments(updateData) {
    if (!updateData || typeof updateData !== 'object') return updateData;

    for (const field of ['tradeLicenseAttachment', 'establishmentCardAttachment']) {
        if (typeof updateData[field] === 'string') {
            updateData[field] = attachmentValueForDatabase(updateData[field]);
        }
    }

    const normalizeDocList = (list) => {
        if (!Array.isArray(list)) return;
        for (let i = 0; i < list.length; i += 1) {
            const doc = list[i];
            if (!doc || typeof doc !== 'object') continue;
            if (typeof doc.attachment === 'string') {
                doc.attachment = attachmentValueForDatabase(doc.attachment);
            }
            if (doc.document?.url) {
                doc.document.url = attachmentValueForDatabase(doc.document.url);
            }
        }
    };

    normalizeDocList(updateData.documents);
    normalizeDocList(updateData.oldDocuments);
    normalizeDocList(updateData.insurance);
    normalizeDocList(updateData.ejari);

    if (Array.isArray(updateData.owners)) {
        for (const owner of updateData.owners) {
            if (!owner || typeof owner !== 'object') continue;
            if (typeof owner.attachment === 'string') {
                owner.attachment = attachmentValueForDatabase(owner.attachment);
            }
            for (const key of OWNER_DOC_KEYS) {
                if (typeof owner[key]?.attachment === 'string') {
                    owner[key].attachment = attachmentValueForDatabase(owner[key].attachment);
                }
            }
        }
    }

    return updateData;
}

/** Sign `document.url` and legacy `attachment` on a company document row (live, old, memo, etc.). */
export async function signCompanyDocumentArrayEntry(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    if (doc.document?.url) {
        doc.document.url = await getSignedFileUrl(doc.document.url);
    }
    if (typeof doc.attachment === 'string' && doc.attachment.trim()) {
        doc.attachment = await getSignedFileUrl(doc.attachment);
    }
    return doc;
}

export async function signCompanyDocumentArray(list) {
    if (!Array.isArray(list)) return list;
    return Promise.all(list.map((doc) => signCompanyDocumentArrayEntry(doc)));
}
