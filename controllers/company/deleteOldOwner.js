import mongoose from "mongoose";
import Company from "../../models/Company.js";
import {
    loadCompanyFullProfile,
    pullOwnerFromPartition,
    findOwnerRow,
    findBundleArrayRow,
} from "../../services/companyPartitionService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";

const companyMatch = (id) => ({
    $or: [
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
        { companyId: id },
    ],
});

// @desc    Delete an owner record from company's oldOwners list (Archive)
// @route   DELETE /api/Company/:id/old-owner/:target
// @access  Private (Admin Only)
export const deleteOldOwner = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete archived company owners." });
        }

        const { id, target } = req.params;
        const decodedTarget = typeof target === "string" ? decodeURIComponent(target) : target;

        const company = await Company.findOne(companyMatch(id)).lean();
        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        const fullProfile = (await loadCompanyFullProfile(company)) || company;
        const ownerSnap = findBundleArrayRow(fullProfile.oldOwners, decodedTarget);
        if (!ownerSnap) {
            return res.status(404).json({ message: "Owner record not found in archive" });
        }

        await awaitAdminDeletionArchive(req, {
            moduleName: "Company Archived Owner",
            recordId: company.companyId || String(company._id),
            details: ownerSnap?.name || "Archived owner",
            deletedPayload: {
                companyId: company.companyId,
                companyName: company.name,
                owner: ownerSnap,
                ownerTarget: "oldOwners",
            },
        });

        const { modified, found } = await pullOwnerFromPartition(company._id, "oldOwners", decodedTarget);
        if (!found || !modified) {
            return res.status(404).json({ message: "Owner record not found in archive" });
        }

        return res.status(200).json({
            message: "Archived company owner record deleted successfully",
        });
    } catch (error) {
        console.error("Error deleting archived company owner:", error);
        return res.status(500).json({ message: "Server error", error: error.message });
    }
};
