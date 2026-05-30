import mongoose from "mongoose";
import Company from "../../models/Company.js";
import CompanyCompliance from "../../models/CompanyCompliance.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { hasPermission } from "../../services/permissionService.js";
import { buildAttachmentKeysMap } from "../../utils/listDeletionAttachmentRefs.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";

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

        const companyBefore = await Company.findOne(buildCompanyFilter(id)).lean();
        if (!companyBefore) {
            return res.status(404).json({ message: "Company not found." });
        }

        const isAdmin = await isReqUserAdmin(req.user);
        const activated = isCompanyProfileActivated(companyBefore);
        const permModule = CARD_PERMISSION_MAP[card];

        if (activated) {
            if (!isAdmin) {
                return res.status(403).json({
                    message: "Only administrator can delete card details on an activated company profile.",
                });
            }
        } else {
            const userId = req.user?.id || req.user?._id;
            const hasDeletePerm =
                userId && permModule && (await hasPermission(userId, permModule, "delete"));
            if (!isAdmin && !hasDeletePerm) {
                return res.status(403).json({ message: "You do not have permission to delete this card." });
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

        if (card === "tradeLicense" || card === "establishmentCard") {
            await CompanyCompliance.updateOne(
                { company: companyBefore._id },
                { $unset: unsetOps },
            );
        }

        return res.status(200).json({ message: "Company card cleared successfully." });
    } catch (error) {
        console.error("Error clearing company card:", error);
        return res.status(500).json({ message: "Server error", error: error.message });
    }
};
