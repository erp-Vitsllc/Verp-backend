import mongoose from "mongoose";
import Company from "../../models/Company.js";
import CompanyCompliance from "../../models/CompanyCompliance.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { isRequestUserDesignatedFlowchartHr } from "../../utils/isDesignatedFlowchartHr.js";
import { hasPermission } from "../../services/permissionService.js";
import { buildAttachmentKeysMap } from "../../utils/listDeletionAttachmentRefs.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { stripProposedDataKeysFromPendingReactivationEntries } from "../../utils/companyActivation.js";
import {
    loadCompanyFullProfile,
    upsertCompanyPartitions,
} from "../../services/companyPartitionService.js";
import { signCompanyProfileForResponse } from "../../utils/signCompanyProfileForResponse.js";

const CARD_FIELD_MAP = {
    tradeLicense: [
        "tradeLicenseNumber",
        "tradeLicenseIssueDate",
        "tradeLicenseExpiry",
        "tradeLicenseOwnerName",
        "tradeLicenseAttachment",
    ],
    establishmentCard: [
        "establishmentCardNumber",
        "establishmentCardIssueDate",
        "establishmentCardExpiry",
        "establishmentCardAttachment",
    ],
};

const CARD_PERMISSION_MAP = {
    tradeLicense: "hrm_company_view_basic_trade_license",
    establishmentCard: "hrm_company_view_basic_establishment_card",
};

const buildCompanyFilter = (id) => ({
    $or: [
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
        { companyId: id },
    ],
});

function isCompanyProfileActivated(company) {
    const status = String(company?.status || "").toLowerCase();
    const activationStatus = String(company?.activationStatus || "").toLowerCase();
    return status === "active" && activationStatus === "active";
}

export const clearCompanyCard = async (req, res) => {
    try {
        const { id, card } = req.params;
        const fields = CARD_FIELD_MAP[card];
        if (!fields) {
            return res.status(400).json({ message: "Unknown company card." });
        }

        const companyCore = await Company.findOne(buildCompanyFilter(id)).lean();
        if (!companyCore) {
            return res.status(404).json({ message: "Company not found." });
        }

        const companyBefore = (await loadCompanyFullProfile(companyCore)) || companyCore;

        const isAdmin = await isReqUserAdmin(req.user);
        const isDesignatedHr = await isRequestUserDesignatedFlowchartHr(req);
        const canBypassActivatedDelete = isAdmin || isDesignatedHr;
        const activated = isCompanyProfileActivated(companyBefore);
        const permModule = CARD_PERMISSION_MAP[card];

        if (!isAdmin) {
            if (activated) {
                if (!canBypassActivatedDelete) {
                    return res.status(403).json({
                        message: "Only administrator can delete card details on an activated company profile.",
                    });
                }
            } else {
                const userId = req.user?.id || req.user?._id;
                const hasDeletePerm =
                    userId && permModule && (await hasPermission(userId, permModule, "delete"));
                if (!canBypassActivatedDelete && !hasDeletePerm) {
                    return res.status(403).json({ message: "You do not have permission to delete this card." });
                }
            }
        }

        const snapshot = fields.reduce((acc, field) => {
            acc[field] = companyBefore[field];
            return acc;
        }, {});

        await awaitAdminDeletionArchive(req, {
            moduleName: `Company ${card}`,
            recordId: companyBefore.companyId || String(companyBefore._id),
            details: `${card} card cleared for ${companyBefore.name || companyBefore.companyId}`,
            deletedPayload: {
                companyId: companyBefore.companyId,
                companyName: companyBefore.name,
                companyStatus: companyBefore.status,
                activationStatus: companyBefore.activationStatus,
                card,
                fields: snapshot,
                attachmentKeys: buildAttachmentKeysMap(snapshot),
            },
        });

        const unsetOps = fields.reduce((acc, field) => {
            acc[field] = 1;
            return acc;
        }, {});

        const filter = buildCompanyFilter(id);
        const result = await Company.updateOne(filter, { $unset: unsetOps });
        if (!result.matchedCount) {
            return res.status(404).json({ message: "Company not found." });
        }

        await CompanyCompliance.updateOne({ company: companyBefore._id }, { $unset: unsetOps });

        const existingPending = Array.isArray(companyBefore.pendingReactivationChanges)
            ? companyBefore.pendingReactivationChanges
            : [];
        const nextPending = stripProposedDataKeysFromPendingReactivationEntries(existingPending, fields);
        if (JSON.stringify(nextPending) !== JSON.stringify(existingPending)) {
            await upsertCompanyPartitions(companyBefore._id, {
                pendingReactivationChanges: nextPending,
            });
        }

        const refreshedCore = await Company.findOne(buildCompanyFilter(id)).lean();
        const fullProfile = (await loadCompanyFullProfile(refreshedCore)) || refreshedCore;
        const signedCompany = await signCompanyProfileForResponse(fullProfile);

        return res.status(200).json({
            message: "Company card cleared successfully.",
            company: signedCompany,
        });
    } catch (error) {
        console.error("Error clearing company card:", error);
        return res.status(500).json({ message: "Server error", error: error.message });
    }
};
