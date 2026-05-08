import Company from "../../models/Company.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";

// @desc    Delete an owner record from company's oldOwners list (Archive)
// @route   DELETE /api/Company/:id/old-owner/:target
// @access  Private (Admin Only)
export const deleteOldOwner = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete archived company owners." });
        }

        const { id, target } = req.params; // target can be an index or an _id
        
        // Find by _id or companyId
        let company = await Company.findOne({
            $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }]
        });

        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        if (!company.oldOwners || company.oldOwners.length === 0) {
            return res.status(404).json({ message: "No archived owners found" });
        }

        let ownerIndex = -1;

        // Try to treat target as an ID first (24-char hex string)
        if (target.match(/^[0-9a-fA-F]{24}$/)) {
            ownerIndex = company.oldOwners.findIndex(o => String(o._id || o.id) === target);
        }

        // If not found by ID, try treating it as an index
        if (ownerIndex === -1) {
            const indexValue = parseInt(target);
            if (!isNaN(indexValue) && indexValue >= 0 && indexValue < company.oldOwners.length) {
                ownerIndex = indexValue;
            }
        }

        if (ownerIndex === -1) {
            return res.status(400).json({ message: "Owner record not found in archive" });
        }

        // Remove owner from oldOwners array
        company.oldOwners.splice(ownerIndex, 1);
        await company.save();

        res.status(200).json({
            message: "Archived company owner record deleted successfully",
            company: company
        });

    } catch (error) {
        console.error("Error deleting archived company owner:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
