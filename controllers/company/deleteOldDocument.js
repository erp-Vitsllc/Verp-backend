import Company from "../../models/Company.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";

// @desc    Delete a document from company's oldDocuments list (Archive)
// @route   DELETE /api/Company/:id/old-document/:target
// @access  Private (Admin Only)
export const deleteOldDocument = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete archived company documents." });
        }

        const { id, target } = req.params; // target can be an index or an _id
        
        // Find by _id or companyId
        let company = await Company.findOne({
            $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }]
        });

        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        if (!company.oldDocuments || company.oldDocuments.length === 0) {
            return res.status(404).json({ message: "No archived documents found" });
        }

        let docIndex = -1;

        // Try to treat target as an ID first (24-char hex string)
        if (target.match(/^[0-9a-fA-F]{24}$/)) {
            docIndex = company.oldDocuments.findIndex(d => String(d._id || d.id) === target);
        }

        // If not found by ID, try treating it as an index
        if (docIndex === -1) {
            const indexValue = parseInt(target);
            if (!isNaN(indexValue) && indexValue >= 0 && indexValue < company.oldDocuments.length) {
                docIndex = indexValue;
            }
        }

        if (docIndex === -1) {
            return res.status(400).json({ message: "Document not found in archive" });
        }

        // Remove document from oldDocuments array
        company.oldDocuments.splice(docIndex, 1);
        await company.save();

        res.status(200).json({
            message: "Archived company document deleted successfully",
            company: company
        });

    } catch (error) {
        console.error("Error deleting archived company document:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
