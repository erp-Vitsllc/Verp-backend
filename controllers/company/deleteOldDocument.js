import Company from "../../models/Company.js";
import mongoose from "mongoose";
import {
    loadCompanyFullProfile,
    pullFromCompanyDocumentBundle,
    findCompanyDocumentRow,
} from "../../services/companyPartitionService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";

const buildCompanyFilter = (id) => ({
    $or: [
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
        { companyId: id },
    ],
});

// @desc    Delete a document from company's oldDocuments list (Archive)
// @route   DELETE /api/Company/:id/old-document/:target
// @access  Private (Admin Only)
export const deleteOldDocument = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete archived company documents." });
        }

        const { id, target } = req.params;
        const company = await Company.findOne(buildCompanyFilter(id)).lean();
        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        const fullProfile = (await loadCompanyFullProfile(company)) || company;
        const located = findCompanyDocumentRow(fullProfile, target, ["oldDocuments", "documents"]);
        if (!located?.row) {
            return res.status(404).json({ message: "Archived document not found." });
        }

        const { field, row: deletedDoc } = located;

        await awaitAdminDeletionArchive(req, {
            moduleName: "Company Old Document",
            recordId: company.companyId || String(company._id),
            details: (deletedDoc?.type || "Archived company document").toString(),
            deletedPayload: {
                companyId: company.companyId,
                companyName: company.name,
                document: deletedDoc,
                storageField: field,
            },
        });

        const { modified, found } = await pullFromCompanyDocumentBundle(company._id, field, target);
        if (!found || !modified) {
            return res.status(404).json({ message: "Archived document not found." });
        }

        return res.status(200).json({
            message: "Archived company document deleted successfully",
        });
    } catch (error) {
        console.error("Error deleting archived company document:", error);
        return res.status(500).json({ message: "Server error", error: error.message });
    }
};
