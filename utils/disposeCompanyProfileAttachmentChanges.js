import {
    COMPANY_ACTIVATION_PROGRESS_KEYS,
    isInformativeCompanySectionKey,
} from "./profileFileChangeHrNotify.js";
import {
    disposeCompanyProfileAttachment,
    resolveProfileAttachmentKey,
} from "./profileAttachmentDisposition.js";

const SCALAR_ATTACHMENT_FIELDS = [
    { field: "tradeLicenseAttachment", sectionKey: "tradeLicense", label: "Trade License" },
    { field: "establishmentCardAttachment", sectionKey: "establishmentCard", label: "Establishment Card" },
    { field: "logo", sectionKey: "basicDetails", label: "Company Logo" },
];

const normalizeAttachmentKeyForCompare = (value) => {
    const key = resolveProfileAttachmentKey(value);
    return key ? key.toLowerCase() : "";
};

const attachmentChanged = (beforeValue, afterValue) => {
    const beforeKey = normalizeAttachmentKeyForCompare(beforeValue);
    const afterKey = normalizeAttachmentKeyForCompare(afterValue);
    if (!beforeKey) return false;
    // Explicit clear only — do not treat unparseable signed URLs as removals
    // (that falsely scheduled originals for 60-day S3 purge while still on the live card).
    if (!afterKey) {
        return afterValue == null || afterValue === '';
    }
    return beforeKey !== afterKey;
};

const rowAttachment = (row) => row?.document?.url || row?.document?.publicId || row?.attachment || null;

const disposeScalarField = async (req, company, beforeCompany, updateData, fieldMeta, options) => {
    const { field, sectionKey, label } = fieldMeta;
    if (!Object.prototype.hasOwnProperty.call(updateData, field)) return;

    const beforeValue = beforeCompany?.[field];
    const afterValue = updateData[field];
    if (!attachmentChanged(beforeValue, afterValue)) return;

    // Replacement with a new file: keep the previous object in storage.
    // Renew already moves history into Old Documents — do not put live replacements
    // into Deleted Records (that previously led to Wasabi originals being wiped).
    const afterKey = normalizeAttachmentKeyForCompare(afterValue);
    if (afterKey) return;

    const isActivationSection = COMPANY_ACTIVATION_PROGRESS_KEYS.has(sectionKey);
    const isInformative = isInformativeCompanySectionKey(sectionKey);
    const isActivationDocumentChange =
        options.queueForApproval && (isActivationSection || !isInformative);

    await disposeCompanyProfileAttachment(req, {
        company: beforeCompany,
        attachment: beforeValue,
        isActivationDocumentChange,
        movedToOldDocuments: options.isRenewal === true && isActivationSection,
        archive: {
            moduleName: `Company ${label}`,
            recordId: company.companyId || String(company._id),
            details: `${label} attachment removed from ${company.name || company.companyId}`,
            deletedPayload: {
                companyId: company.companyId,
                companyName: company.name,
                field,
                attachment: beforeValue,
            },
        },
    });
};

const disposeArrayAttachmentRemovals = async (
    req,
    company,
    beforeRows = [],
    afterRows = [],
    { sectionKey, label, queueForApproval, isRenewal },
) => {
    if (!isInformativeCompanySectionKey(sectionKey)) return;

    const afterIds = new Set(
        (Array.isArray(afterRows) ? afterRows : [])
            .map((row) => (row?._id != null ? String(row._id) : ""))
            .filter(Boolean),
    );

    for (const beforeRow of Array.isArray(beforeRows) ? beforeRows : []) {
        const rowId = beforeRow?._id != null ? String(beforeRow._id) : "";
        const attachment = rowAttachment(beforeRow);
        if (!attachment) continue;

        let shouldDispose = false;
        if (rowId && !afterIds.has(rowId)) {
            shouldDispose = true;
        } else if (rowId) {
            const afterRow = afterRows.find((row) => String(row?._id) === rowId);
            if (afterRow && attachmentChanged(attachment, rowAttachment(afterRow))) {
                shouldDispose = true;
            }
        }

        if (!shouldDispose) continue;

        await disposeCompanyProfileAttachment(req, {
            company,
            attachment,
            isActivationDocumentChange: queueForApproval,
            movedToOldDocuments: isRenewal === true,
            archive: {
                moduleName: `Company ${label}`,
                recordId: company.companyId || String(company._id),
                details: `${label} attachment removed from ${company.name || company.companyId}`,
                deletedPayload: {
                    companyId: company.companyId,
                    companyName: company.name,
                    sectionKey,
                    item: beforeRow,
                },
            },
        });
    }
};

/**
 * Dispose replaced/removed company profile attachments after a committed save.
 * Skipped while changes are queued for activation approval (`queueForApproval`).
 */
export async function disposeCommittedCompanyProfileAttachmentChanges(
    req,
    beforeCompany = {},
    updateData = {},
    { queueForApproval = false, isRenewal = false } = {},
) {
    if (!beforeCompany || !updateData || queueForApproval) return;

    const company = beforeCompany;

    for (const fieldMeta of SCALAR_ATTACHMENT_FIELDS) {
        await disposeScalarField(req, company, beforeCompany, updateData, fieldMeta, {
            queueForApproval,
            isRenewal,
        });
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "ejari")) {
        await disposeArrayAttachmentRemovals(req, company, beforeCompany.ejari, updateData.ejari, {
            sectionKey: "ejari",
            label: "Ejari",
            queueForApproval,
            isRenewal,
        });
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "insurance")) {
        await disposeArrayAttachmentRemovals(req, company, beforeCompany.insurance, updateData.insurance, {
            sectionKey: "insurance",
            label: "Insurance",
            queueForApproval,
            isRenewal,
        });
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "documents")) {
        await disposeArrayAttachmentRemovals(req, company, beforeCompany.documents, updateData.documents, {
            sectionKey: "documents",
            label: "Document",
            queueForApproval,
            isRenewal,
        });
    }
}
