import { hasPermission, isUserAdministrator } from "../services/permissionService.js";
import { isJwtSystemSuperUser } from "./systemSuperUser.js";
import {
    COMPANY_DELETE_PERM,
    OWNER_DOC_KEY_PERM,
    moduleForDocumentContext,
} from "./companyProfileDeleteAccess.js";
import {
    isTradeLicenseOwnersBundleUpdate,
    TRADE_LICENSE_OWNER_BUNDLE_KEYS,
} from "./mergeCompanyOwnersSnapshot.js";
import { getChangedOwnerNestedDocKeys } from "./ownerPatchScope.js";

const COMPANY_PATCH_META_KEYS = new Set([
    "skipArchive",
    "isRenewalModal",
    "isRenewal",
    "clearLiveOwnerDocCard",
    "clearOldOwnerDocCard",
    "pullDocumentsByIds",
    "pullOldDocumentsByIds",
    "pullOwnersByIds",
    "retireLiveDocumentById",
    "companyDocumentNotRenew",
]);

const WORKFLOW_ONLY_KEYS = new Set([
    "pendingReactivationChanges",
    "activationStatus",
    "status",
    "responsibilities",
    "customTabs",
    "trainingDetails",
    "oldOwners",
    "pendingNotRenewRequests",
]);

const BASIC_CORE_FIELDS = ["name", "nickName", "email", "phone", "phoneCountryCode", "establishedDate"];
const ADDRESS_FIELDS = ["address", "country", "state", "city", "postalCode"];
const ESTABLISHMENT_FIELDS = [
    "establishmentCardNumber",
    "establishmentCardIssueDate",
    "establishmentCardExpiry",
    "establishmentCardAttachment",
];

export const NOT_RENEW_KIND_PERM = {
    tradeLicense: COMPANY_DELETE_PERM.tradeLicense,
    establishmentCard: COMPANY_DELETE_PERM.establishment,
    document: COMPANY_DELETE_PERM.docLive,
    ejari: COMPANY_DELETE_PERM.ejari,
    insurance: COMPANY_DELETE_PERM.docLiveWithExpiry,
};

const resolveUserId = (user) => user?.id || user?._id?.toString?.() || user?._id || null;

const patchTouchesFields = (updateData, fields) =>
    fields.some((field) => Object.prototype.hasOwnProperty.call(updateData, field));

const isAdminUser = async (user) => {
    const userId = resolveUserId(user);
    if (!userId) return false;
    if (isJwtSystemSuperUser(user)) return true;
    return isUserAdministrator(userId);
};

/** Modules touched by a company PATCH — mirrors frontend card permissions. */
export function collectCompanyUpdateEditModules(beforeCompany = {}, updateData = {}) {
    const modules = new Set();
    if (!updateData || typeof updateData !== "object") return [];

    const tradeLicenseBundle = isTradeLicenseOwnersBundleUpdate(updateData);
    if (
        tradeLicenseBundle ||
        TRADE_LICENSE_OWNER_BUNDLE_KEYS.some((key) =>
            Object.prototype.hasOwnProperty.call(updateData, key),
        )
    ) {
        modules.add(COMPANY_DELETE_PERM.tradeLicense);
    }
    if (patchTouchesFields(updateData, ESTABLISHMENT_FIELDS)) {
        modules.add(COMPANY_DELETE_PERM.establishment);
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "ejari")) {
        modules.add(COMPANY_DELETE_PERM.ejari);
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "insurance")) {
        modules.add(COMPANY_DELETE_PERM.docLiveWithExpiry);
    }
    if (patchTouchesFields(updateData, ADDRESS_FIELDS)) {
        modules.add("hrm_company_view_basic_address");
    }
    if (patchTouchesFields(updateData, BASIC_CORE_FIELDS)) {
        modules.add("hrm_company_view_basic");
    }
    if (Array.isArray(updateData.documents)) {
        for (const doc of updateData.documents) {
            modules.add(moduleForDocumentContext(doc?.context));
        }
    }
    if (Array.isArray(updateData.owners) && !tradeLicenseBundle) {
        const changedDocKeys = getChangedOwnerNestedDocKeys(
            updateData.owners,
            beforeCompany?.owners || [],
        );
        if (changedDocKeys.size > 0) {
            for (const docKey of changedDocKeys) {
                const mod = OWNER_DOC_KEY_PERM[String(docKey || "")];
                if (mod) modules.add(mod);
            }
        } else {
            modules.add(COMPANY_DELETE_PERM.ownerDetails);
        }
    }

    return [...modules];
}

export function patchHasUnscopedCompanyFields(updateData = {}) {
    if (!updateData || typeof updateData !== "object") return false;
    return Object.keys(updateData).some(
        (key) => !COMPANY_PATCH_META_KEYS.has(key) && !WORKFLOW_ONLY_KEYS.has(key),
    );
}

/** Renew requires edit; add may use create or edit on each touched card module. */
export async function userMayEditCompanyProfilePatch(
    user,
    beforeCompany = {},
    updateData = {},
    { isRenewal = false } = {},
) {
    if (await isAdminUser(user)) return true;

    const userId = resolveUserId(user);
    if (!userId) return false;

    const modules = collectCompanyUpdateEditModules(beforeCompany, updateData);
    if (modules.length === 0) {
        return !patchHasUnscopedCompanyFields(updateData);
    }

    for (const moduleId of modules) {
        if (isRenewal) {
            if (!(await hasPermission(userId, moduleId, "edit"))) return false;
        } else {
            const canEdit = await hasPermission(userId, moduleId, "edit");
            const canCreate = await hasPermission(userId, moduleId, "create");
            if (!canEdit && !canCreate) return false;
        }
    }
    return true;
}

export async function userMaySubmitCompanyNotRenew(user, { kind, docKey } = {}) {
    if (await isAdminUser(user)) return true;

    const userId = resolveUserId(user);
    if (!userId) return false;

    let moduleId = NOT_RENEW_KIND_PERM[String(kind || "")];
    if (kind === "ownerDoc") {
        moduleId = OWNER_DOC_KEY_PERM[String(docKey || "")];
    }
    if (!moduleId) return false;
    return hasPermission(userId, moduleId, "edit");
}
