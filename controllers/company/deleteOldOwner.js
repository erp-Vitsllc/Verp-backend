import mongoose from "mongoose";
import Company from "../../models/Company.js";
import {
    isReqUserAdmin,
    scheduleManagementAdminDeletionEmail,
} from "../../utils/sendAdminDeletionNotificationEmails.js";

const companyMatch = (id) => ({
    $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }],
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

        /** Prefer $pull by subdoc _id so we never load/save a multi‑MB Company document in memory. */
        if (typeof decodedTarget === "string" && /^[0-9a-fA-F]{24}$/.test(decodedTarget)) {
            const oid = new mongoose.Types.ObjectId(decodedTarget);
            const companySnap = await Company.findOne(companyMatch(id))
                .select("companyId name oldOwners")
                .lean();
            const ownerSnap = (companySnap?.oldOwners || []).find(
                (o) => String(o._id) === String(decodedTarget)
            );
            if (ownerSnap) {
                scheduleManagementAdminDeletionEmail(req, {
                    moduleName: "Company Archived Owner",
                    recordId: companySnap.companyId || String(companySnap._id),
                    details: ownerSnap?.name || "Archived owner",
                    deletedPayload: {
                        companyId: companySnap.companyId,
                        companyName: companySnap.name,
                        owner: ownerSnap,
                        ownerTarget: 'oldOwners',
                    },
                });
            }
            const result = await Company.updateOne(companyMatch(id), { $pull: { oldOwners: { _id: oid } } });
            if (!result.matchedCount) {
                return res.status(404).json({ message: "Company not found" });
            }
            if (!result.modifiedCount) {
                return res.status(404).json({ message: "Owner record not found in archive" });
            }
            return res.status(200).json({
                message: "Archived company owner record deleted successfully",
            });
        }

        let company = await Company.findOne(companyMatch(id));

        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        if (!company.oldOwners || company.oldOwners.length === 0) {
            return res.status(404).json({ message: "No archived owners found" });
        }

        let ownerIndex = -1;
        const indexValue = parseInt(decodedTarget, 10);
        if (!Number.isNaN(indexValue) && indexValue >= 0 && indexValue < company.oldOwners.length) {
            ownerIndex = indexValue;
        }

        if (ownerIndex === -1) {
            return res.status(400).json({ message: "Owner record not found in archive" });
        }

        const ownerSnap = company.oldOwners[ownerIndex];
        scheduleManagementAdminDeletionEmail(req, {
            moduleName: "Company Archived Owner",
            recordId: company.companyId || String(company._id),
            details: ownerSnap?.name || "Archived owner",
            deletedPayload: {
                companyId: company.companyId,
                companyName: company.name,
                owner: ownerSnap?.toObject ? ownerSnap.toObject() : ownerSnap,
                ownerTarget: 'oldOwners',
            },
        });

        company.oldOwners.splice(ownerIndex, 1);
        await company.save();

        res.status(200).json({
            message: "Archived company owner record deleted successfully",
        });
    } catch (error) {
        console.error("Error deleting archived company owner:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
