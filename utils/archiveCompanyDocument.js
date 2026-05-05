import Company from "../models/Company.js";

const documentStorageFingerprint = (urlOrObj) => {
    if (!urlOrObj) return "";
    if (typeof urlOrObj === "string") return `url:${urlOrObj.trim()}`;
    if (typeof urlOrObj.url === "string") return `url:${urlOrObj.url.trim()}`;
    return "";
};

/**
 * Skip pushing if the same file was already archived as "Replaced" (concurrent renews / double apply).
 */
const isDuplicateReplacedArchive = async (companyId, type, document) => {
    const fp = documentStorageFingerprint(document);
    if (!fp) return false;
    const company = await Company.findOne({ _id: companyId }).select("oldDocuments").lean();
    const list = Array.isArray(company?.oldDocuments) ? company.oldDocuments : [];
    return list.some(
        (d) =>
            String(d?.archiveReason || "") === "Replaced" &&
            String(d?.type || "") === String(type || "") &&
            documentStorageFingerprint(d?.document) === fp,
    );
};

/**
 * Archive a replaced company document into Company.oldDocuments.
 */
export const archiveCompanyDocument = async ({
    companyId,
    type,
    description = "",
    issueDate = null,
    expiryDate = null,
    cost = null,
    document, // can be string (URL) or { url, name, mimeType }
}) => {
    if (!companyId || !document) return;

    if (await isDuplicateReplacedArchive(companyId, type || "Document", document)) {
        return;
    }

    const docObj = typeof document === "string" ? { url: document } : document;

    await Company.updateOne(
        { _id: companyId },
        {
            $push: {
                oldDocuments: {
                    type: type || "Document",
                    description,
                    issueDate: issueDate || null,
                    expiryDate: expiryDate || null,
                    cost: cost ?? null,
                    archivedAt: new Date(),
                    archiveReason: "Replaced",
                    document: docObj,
                },
            },
        }
    );
};

/**
 * Compare before/after state and archive any documents that were replaced.
 */
export const archiveSupersededCompanyDocuments = async (beforeCompany, updateData) => {
    if (!beforeCompany || !updateData) return;
    const companyId = beforeCompany._id;

    const checkAndArchive = async (key, type, label) => {
        const prev = beforeCompany[key];
        const next = updateData[key];
        // For Company, some attachments are strings (URL), some are objects.
        const prevUrl = typeof prev === "string" ? prev.trim() : prev?.url?.trim();
        const nextUrl = typeof next === "string" ? next.trim() : next?.url?.trim();

        if (prevUrl && nextUrl && prevUrl !== nextUrl) {
            await archiveCompanyDocument({
                companyId,
                type,
                description: `${label} (superseded)`,
                issueDate: beforeCompany[`${key}IssueDate`] || null,
                expiryDate: beforeCompany[`${key}Expiry`] || beforeCompany[`${key}ExpiryDate`] || null,
                document: prev,
            });
        }
    };

    // 1. Trade License
    await checkAndArchive("tradeLicenseAttachment", "Trade License", "Trade License");

    // 2. Establishment Card
    await checkAndArchive("establishmentCardAttachment", "Establishment Card", "Establishment Card");

    // 3. Ejari (Array)
    if (Array.isArray(beforeCompany.ejari) && Array.isArray(updateData.ejari)) {
        for (const nextEjari of updateData.ejari) {
            if (!nextEjari._id || !nextEjari.document?.url) continue;
            const prevEjari = beforeCompany.ejari.find(ej => String(ej._id) === String(nextEjari._id));
            if (prevEjari && prevEjari.document?.url && prevEjari.document.url !== nextEjari.document.url) {
                await archiveCompanyDocument({
                    companyId,
                    type: prevEjari.type ? `Ejari - ${prevEjari.type}` : "Ejari",
                    description: prevEjari.description || "Ejari / Tenancy Contract (superseded)",
                    issueDate: prevEjari.issueDate || null,
                    expiryDate: prevEjari.expiryDate || null,
                    document: prevEjari.document,
                });
            }
        }
    }

    // 4. Insurance (Array)
    if (Array.isArray(beforeCompany.insurance) && Array.isArray(updateData.insurance)) {
        for (const nextIns of updateData.insurance) {
            if (!nextIns._id || !nextIns.document?.url) continue;
            const prevIns = beforeCompany.insurance.find(ins => String(ins._id) === String(nextIns._id));
            if (prevIns && prevIns.document?.url && prevIns.document.url !== nextIns.document.url) {
                await archiveCompanyDocument({
                    companyId,
                    type: prevIns.type ? `Insurance - ${prevIns.type}` : "Insurance",
                    description: prevIns.description || "Company Insurance (superseded)",
                    issueDate: prevIns.issueDate || null,
                    expiryDate: prevIns.expiryDate || null,
                    document: prevIns.document,
                });
            }
        }
    }

    // 5. Custom Documents array
    if (Array.isArray(beforeCompany.documents) && Array.isArray(updateData.documents)) {
        for (const nextDoc of updateData.documents) {
            if (!nextDoc._id || !nextDoc.document?.url) continue;
            const prevDoc = beforeCompany.documents.find(d => String(d._id) === String(nextDoc._id));
            if (prevDoc && prevDoc.document?.url && prevDoc.document.url !== nextDoc.document.url) {
                await archiveCompanyDocument({
                    companyId,
                    type: prevDoc.type || "Document",
                    description: prevDoc.description || "Company document (superseded)",
                    issueDate: prevDoc.issueDate || null,
                    expiryDate: prevDoc.expiryDate || null,
                    document: prevDoc.document,
                });
            }
        }
    }

    // 6. Owners
    if (Array.isArray(beforeCompany.owners) && Array.isArray(updateData.owners)) {
        for (const nextOwner of updateData.owners) {
            if (!nextOwner._id) continue;
            const prevOwner = beforeCompany.owners.find(o => String(o._id) === String(nextOwner._id));
            if (!prevOwner) continue;

            const checkOwnerDoc = async (key, typeLabel) => {
                const prev = prevOwner[key]?.attachment;
                const next = nextOwner[key]?.attachment;
                const prevUrl = prev?.url?.trim();
                const nextUrl = next?.url?.trim();
                if (prevUrl && nextUrl && prevUrl !== nextUrl) {
                    await archiveCompanyDocument({
                        companyId,
                        type: `Owner ${typeLabel}`,
                        description: `Owner: ${prevOwner.name} - ${typeLabel} (superseded)`,
                        issueDate: prevOwner[key]?.issueDate || null,
                        expiryDate: prevOwner[key]?.expiryDate || null,
                        document: prev,
                    });
                }
            };

            await checkOwnerDoc("passport", "Passport");
            await checkOwnerDoc("visa", "Visa");
            await checkOwnerDoc("emiratesId", "Emirates ID");
        }
    }
};
