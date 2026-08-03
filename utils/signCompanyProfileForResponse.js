import { signOrKeepAttachmentUrl } from "./s3Upload.js";
import { signCompanyDocumentArray } from "./signCompanyDocumentFields.js";

/** Sign attachment URLs on a company profile object for API responses. */
export async function signCompanyProfileForResponse(companyObj = {}) {
    const out = { ...companyObj };
    if (out.logo) out.logo = await signOrKeepAttachmentUrl(out.logo);
    if (typeof out.tradeLicenseAttachment === "string" && out.tradeLicenseAttachment) {
        out.tradeLicenseAttachment = await signOrKeepAttachmentUrl(out.tradeLicenseAttachment);
    }
    if (typeof out.establishmentCardAttachment === "string" && out.establishmentCardAttachment) {
        out.establishmentCardAttachment = await signOrKeepAttachmentUrl(out.establishmentCardAttachment);
    }
    if (Array.isArray(out.documents)) out.documents = await signCompanyDocumentArray(out.documents);
    if (Array.isArray(out.oldDocuments)) out.oldDocuments = await signCompanyDocumentArray(out.oldDocuments);
    if (Array.isArray(out.insurance)) out.insurance = await signCompanyDocumentArray(out.insurance);
    if (Array.isArray(out.ejari)) out.ejari = await signCompanyDocumentArray(out.ejari);
    const signOwnerRow = async (owner) => {
        if (!owner || typeof owner !== "object") return owner;
        const o = { ...owner };
        if (typeof o.attachment === "string" && o.attachment) {
            o.attachment = await signOrKeepAttachmentUrl(o.attachment);
        }
        for (const key of [
            "passport",
            "visa",
            "visitVisa",
            "employmentVisa",
            "spouseVisa",
            "emiratesId",
            "medical",
            "drivingLicense",
            "labourCard",
        ]) {
            const doc = o[key];
            if (doc?.attachment && typeof doc.attachment === "string") {
                o[key] = { ...doc, attachment: await signOrKeepAttachmentUrl(doc.attachment) };
            }
        }
        return o;
    };

    if (Array.isArray(out.owners)) {
        out.owners = await Promise.all(out.owners.map(signOwnerRow));
    }

    const signPendingSnapshot = async (data) => {
        if (!data || typeof data !== "object") return data;
        const snap = { ...data };
        if (typeof snap.tradeLicenseAttachment === "string" && snap.tradeLicenseAttachment) {
            snap.tradeLicenseAttachment = await signOrKeepAttachmentUrl(snap.tradeLicenseAttachment);
        }
        if (typeof snap.establishmentCardAttachment === "string" && snap.establishmentCardAttachment) {
            snap.establishmentCardAttachment = await signOrKeepAttachmentUrl(snap.establishmentCardAttachment);
        }
        if (Array.isArray(snap.owners)) {
            snap.owners = await Promise.all(snap.owners.map(signOwnerRow));
        }
        return snap;
    };

    if (Array.isArray(out.pendingReactivationChanges)) {
        out.pendingReactivationChanges = await Promise.all(
            out.pendingReactivationChanges.map(async (entry) => {
                if (!entry || typeof entry !== "object") return entry;
                const next = { ...entry };
                if (entry.previousData) {
                    next.previousData = await signPendingSnapshot(entry.previousData);
                }
                if (entry.proposedData) {
                    next.proposedData = await signPendingSnapshot(entry.proposedData);
                }
                return next;
            }),
        );
    }

    return out;
}
