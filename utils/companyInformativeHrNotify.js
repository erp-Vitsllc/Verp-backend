import { getChangedOwnerNestedDocKeys } from "./ownerPatchScope.js";
import { isActiveCompanyProfile } from "./companyActivation.js";
import {
    buildCompanyProfileSectionUrl,
    isInformativeCompanySectionKey,
    notifyFlowchartHrOfProfileFileChanges,
    resolveFileLinkEntries,
    scheduleFlowchartHrProfileFileChangeEmail,
} from "./profileFileChangeHrNotify.js";

const INDEPENDENT_OWNER_DOC_KEYS = new Set([
    "visitVisa",
    "employmentVisa",
    "spouseVisa",
    "visa",
    "labourCard",
    "medical",
    "drivingLicense",
]);

const INDEPENDENT_OWNER_LABELS = {
    visitVisa: "Owner Visit Visa",
    employmentVisa: "Owner Employment Visa",
    spouseVisa: "Owner Spouse Visa",
    visa: "Owner Visa",
    labourCard: "Owner Labour Card",
    medical: "Owner Medical Insurance",
    drivingLicense: "Owner Driving License",
};

const isArchivedDocumentRow = (d) => {
    if (!d || typeof d !== "object") return false;
    const desc = String(d?.description || "").toLowerCase();
    if (desc.includes("not renewed")) return true;
    if (d?.archivedAt) return true;
    if (String(d?.archiveReason || "").toLowerCase().includes("not renew")) return true;
    return false;
};

const isMoaDocumentRow = (d) => {
    if (!d || typeof d !== "object") return false;
    const ctx = String(d?.context || "").toLowerCase();
    if (ctx === "moa") return true;
    return String(d?.type || "").toLowerCase().includes("moa");
};

const rowAttachment = (row) => row?.document?.url || row?.document?.publicId || row?.attachment || null;

const normalizeBundleRow = (row) => ({
    id: row?._id != null ? String(row._id) : "",
    type: String(row?.type || ""),
    description: String(row?.description || ""),
    issueDate: row?.issueDate ? new Date(row.issueDate).toISOString() : "",
    expiryDate: row?.expiryDate ? new Date(row.expiryDate).toISOString() : "",
    url: String(rowAttachment(row) || "").split("?")[0],
});

const normalizeLiveDocumentRow = (row) => ({
    id: row?._id != null ? String(row._id) : "",
    context: String(row?.context || ""),
    type: String(row?.type || ""),
    description: String(row?.description || ""),
    issueDate: row?.issueDate ? new Date(row.issueDate).toISOString() : "",
    expiryDate: row?.expiryDate ? new Date(row.expiryDate).toISOString() : "",
    url: String(rowAttachment(row) || "").split("?")[0],
});

const liveNonMoaDocuments = (documents = []) =>
    (Array.isArray(documents) ? documents : []).filter((d) => !isArchivedDocumentRow(d) && !isMoaDocumentRow(d));

const documentRowInformLabel = (row) => {
    const ctx = String(row?.context || "").toLowerCase();
    if (ctx === "memo") return "Memo";
    if (ctx === "certificate") return "Certificate";
    if (ctx === "document_with_expiry") return "Document With Expiry";
    if (ctx === "document_without_expiry") return "Document Without Expiry";
    if (ctx === "insurance") return "Insurance";
    if (ctx === "other_document") return "Document";
    const type = String(row?.type || "").trim();
    return type || "Document";
};

const inferArrayAction = (beforeRows = [], afterRows = [], rowNorm) => {
    const beforeMap = new Map((beforeRows || []).map((r) => [rowNorm(r).id, rowNorm(r)]).filter(([id]) => id));
    const afterMap = new Map((afterRows || []).map((r) => [rowNorm(r).id, rowNorm(r)]).filter(([id]) => id));
    const actions = [];

    for (const [id, afterRow] of afterMap.entries()) {
        const beforeRow = beforeMap.get(id);
        if (!beforeRow) {
            actions.push({ action: "added", row: afterRow });
        } else if (JSON.stringify(beforeRow) !== JSON.stringify(afterRow)) {
            actions.push({ action: "modified", row: afterRow });
        }
    }
    for (const [id, beforeRow] of beforeMap.entries()) {
        if (!afterMap.has(id)) actions.push({ action: "deleted", row: beforeRow });
    }
    return actions;
};

const serializeArrayRows = (rows = [], rowNorm) => {
    try {
        return JSON.stringify((Array.isArray(rows) ? rows : []).map(rowNorm).sort((a, b) => a.id.localeCompare(b.id)));
    } catch {
        return String(Array.isArray(rows) ? rows.length : 0);
    }
};

/**
 * Collect non-activation company file changes for HR informative email.
 * @returns {Promise<object[]>}
 */
export async function collectCompanyProfileFileChangeEvents(beforeCompany = {}, updateData = {}, options = {}) {
    if (!updateData || typeof updateData !== "object") return [];
    const companyId = beforeCompany?._id || options.companyId;
    const events = [];

    const pushEvent = async ({
        sectionKey,
        sectionLabel,
        action = "modified",
        attachment = null,
        docContext = "",
        ownerTabIndex = null,
    }) => {
        if (!isInformativeCompanySectionKey(sectionKey)) return;
        const profileUrl = buildCompanyProfileSectionUrl(companyId, {
            sectionKey,
            docContext,
            ownerTabIndex,
        });
        const files = attachment ? await resolveFileLinkEntries(attachment) : [];
        events.push({
            sectionKey,
            sectionLabel,
            action,
            profileUrl,
            files,
        });
    };

    if (Object.prototype.hasOwnProperty.call(updateData, "ejari")) {
        const beforeRows = beforeCompany?.ejari || [];
        const afterRows = updateData.ejari || [];
        const rowActions = inferArrayAction(beforeRows, afterRows, normalizeBundleRow);
        if (rowActions.length) {
            for (const { action, row } of rowActions) {
                const match = afterRows.concat(beforeRows).find((r) => String(r?._id) === row.id) || afterRows[0];
                await pushEvent({
                    sectionKey: "ejari",
                    sectionLabel: "Ejari",
                    action,
                    attachment: match ? rowAttachment(match) : null,
                });
            }
        } else if (serializeArrayRows(beforeRows, normalizeBundleRow) !== serializeArrayRows(afterRows, normalizeBundleRow)) {
            await pushEvent({
                sectionKey: "ejari",
                sectionLabel: "Ejari",
                action: options.isRenewal ? "renewed" : "modified",
                attachment: afterRows[0] ? rowAttachment(afterRows[0]) : null,
            });
        }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "insurance")) {
        const beforeRows = beforeCompany?.insurance || [];
        const afterRows = updateData.insurance || [];
        const rowActions = inferArrayAction(beforeRows, afterRows, normalizeBundleRow);
        if (rowActions.length) {
            for (const { action, row } of rowActions) {
                const match = afterRows.concat(beforeRows).find((r) => String(r?._id) === row.id) || afterRows[0];
                await pushEvent({
                    sectionKey: "insurance",
                    sectionLabel: "Insurance",
                    action,
                    attachment: match ? rowAttachment(match) : null,
                });
            }
        } else if (serializeArrayRows(beforeRows, normalizeBundleRow) !== serializeArrayRows(afterRows, normalizeBundleRow)) {
            await pushEvent({
                sectionKey: "insurance",
                sectionLabel: "Insurance",
                action: options.isRenewal ? "renewed" : "modified",
                attachment: afterRows[0] ? rowAttachment(afterRows[0]) : null,
            });
        }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "documents")) {
        const beforeRows = liveNonMoaDocuments(beforeCompany?.documents);
        const afterRows = liveNonMoaDocuments(updateData.documents);
        const rowActions = inferArrayAction(beforeRows, afterRows, normalizeLiveDocumentRow);
        if (rowActions.length) {
            for (const { action, row } of rowActions) {
                const match = afterRows.concat(beforeRows).find((r) => String(r?._id) === row.id);
                await pushEvent({
                    sectionKey: "documents",
                    sectionLabel: documentRowInformLabel(match || row),
                    action,
                    attachment: match ? rowAttachment(match) : null,
                    docContext: match?.context || row.context || "",
                });
            }
        } else if (
            serializeArrayRows(beforeRows, normalizeLiveDocumentRow) !==
            serializeArrayRows(afterRows, normalizeLiveDocumentRow)
        ) {
            for (const row of afterRows) {
                await pushEvent({
                    sectionKey: "documents",
                    sectionLabel: documentRowInformLabel(row),
                    action: options.isRenewal ? "renewed" : "modified",
                    attachment: rowAttachment(row),
                    docContext: row?.context || "",
                });
            }
        }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "owners")) {
        const beforeOwners = beforeCompany?.owners || [];
        const changedKeys = getChangedOwnerNestedDocKeys(updateData.owners, beforeOwners);
        for (const key of changedKeys) {
            if (!INDEPENDENT_OWNER_DOC_KEYS.has(key)) continue;
            const ownerIdx = (updateData.owners || []).findIndex((o) => o?.[key]);
            const ownerRow = ownerIdx >= 0 ? updateData.owners[ownerIdx] : null;
            await pushEvent({
                sectionKey: key,
                sectionLabel: INDEPENDENT_OWNER_LABELS[key] || key,
                action: options.isRenewal ? "renewed" : "modified",
                attachment: ownerRow?.[key]?.attachment || ownerRow?.[key]?.document || null,
                ownerTabIndex: ownerIdx >= 0 ? ownerIdx : null,
            });
        }
    }

    return events;
}

export async function notifyHrOfCompanyInformativeCardUpdates({
    company = {},
    changedCards = [],
    changeEvents = [],
    actor = {},
}) {
    if (!isActiveCompanyProfile(company)) return { sent: false, reason: "NOT_ACTIVE" };

    let events = Array.isArray(changeEvents) ? changeEvents : [];
    if (!events.length && Array.isArray(changedCards) && changedCards.length) {
        const baseUrl = buildCompanyProfileSectionUrl(company._id, { sectionKey: "documents" });
        events = changedCards.map((label) => ({
            sectionLabel: label,
            sectionKey: "documents",
            action: "modified",
            profileUrl: baseUrl.replace(/\?.*$/, "") + "?tab=others",
            files: [],
        }));
    }
    if (!events.length) return { sent: false, reason: "NO_CHANGES" };

    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const profileUrl = company?._id ? `${baseUrl}/Company/${company._id}` : `${baseUrl}/Company`;

    return notifyFlowchartHrOfProfileFileChanges({
        entityType: "company",
        entityLabel: company?.name || "Company",
        entityCode: company?.companyId || "",
        profileUrl,
        changes: events,
        actor,
    });
}

export function scheduleCompanyProfileFileChangeHrEmail({ company, beforeCompany, updateData, actor, isRenewal = false }) {
    if (!company?._id || !isActiveCompanyProfile(company)) return;
    scheduleFlowchartHrProfileFileChangeEmail(async () => {
        const events = await collectCompanyProfileFileChangeEvents(beforeCompany, updateData, {
            companyId: company._id,
            isRenewal,
        });
        if (!events.length) return { sent: false };
        return notifyHrOfCompanyInformativeCardUpdates({
            company,
            changeEvents: events,
            actor,
        });
    });
}

export function scheduleCompanyProfileFileDeleteHrEmail({ company, sectionKey, sectionLabel, action = "deleted", attachment = null, actor = {} }) {
    if (!company?._id || !isActiveCompanyProfile(company)) return;
    if (!isInformativeCompanySectionKey(sectionKey)) return;

    scheduleFlowchartHrProfileFileChangeEmail(async () => {
        const profileUrl = buildCompanyProfileSectionUrl(company._id, { sectionKey });
        const files = attachment ? await resolveFileLinkEntries(attachment) : [];
        return notifyHrOfCompanyInformativeCardUpdates({
            company,
            changeEvents: [
                {
                    sectionKey,
                    sectionLabel,
                    action,
                    profileUrl,
                    files,
                },
            ],
            actor,
        });
    });
}
