import { normalizeS3Key } from "./s3Upload.js";
import { awaitAdminDeletionArchive } from "./adminDeletionArchiveRun.js";
import { isActiveCompanyProfile } from "./companyActivation.js";
import { isActiveEmployeeProfile } from "./profileFileChangeHrNotify.js";

/** Resolve a DB attachment value to a Wasabi/S3 object key. */
export function resolveProfileAttachmentKey(attachment) {
    if (attachment == null || attachment === "") return null;
    if (typeof attachment === "string") return normalizeS3Key(attachment);
    if (typeof attachment === "object") {
        const raw =
            attachment.publicId ||
            attachment.key ||
            attachment.url ||
            attachment.href ||
            null;
        return raw ? normalizeS3Key(String(raw)) : null;
    }
    return null;
}

/**
 * Dispose a profile attachment that is no longer referenced by live profile data.
 *
 * Files are always retained in storage until an admin permanently deletes the record.
 * Activated profile removals are archived for management review; non-activated profiles
 * also keep files in storage (no immediate S3 purge).
 */
export async function disposeRemovedProfileAttachment(
    req,
    {
        attachment = null,
        profileActivated = false,
        isActivationDocumentChange = false,
        movedToOldDocuments = false,
        archive = null,
    } = {},
) {
    if (movedToOldDocuments || isActivationDocumentChange) {
        return { action: "retained" };
    }

    if (!profileActivated) {
        return { action: "retained" };
    }

    if (!archive?.moduleName || !archive?.recordId) {
        return { action: "retained" };
    }

    const key = resolveProfileAttachmentKey(attachment);

    await awaitAdminDeletionArchive(req, {
        moduleName: archive.moduleName,
        recordId: archive.recordId,
        details: archive.details || "",
        deletedPayload: archive.deletedPayload ?? (key ? { attachmentKey: key } : {}),
    });
    return { action: "archived_management" };
}

export function isEmployeeProfileActivated(employeeBasic = {}) {
    return isActiveEmployeeProfile(employeeBasic);
}

export function isCompanyProfileActivated(company = {}) {
    return isActiveCompanyProfile(company);
}

export async function disposeEmployeeProfileAttachment(
    req,
    { employeeBasic, attachment, isActivationDocumentChange = false, movedToOldDocuments = false, archive } = {},
) {
    return disposeRemovedProfileAttachment(req, {
        attachment,
        profileActivated: isEmployeeProfileActivated(employeeBasic),
        isActivationDocumentChange,
        movedToOldDocuments,
        archive,
    });
}

export async function disposeCompanyProfileAttachment(
    req,
    { company, attachment, isActivationDocumentChange = false, movedToOldDocuments = false, archive } = {},
) {
    return disposeRemovedProfileAttachment(req, {
        attachment,
        profileActivated: isCompanyProfileActivated(company),
        isActivationDocumentChange,
        movedToOldDocuments,
        archive,
    });
}
