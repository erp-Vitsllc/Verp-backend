import mongoose from "mongoose";
import Company from "../../models/Company.js";
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

export const deleteDocument = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete company documents." });
        }

        const { id, target } = req.params;
        const company = await Company.findOne(buildCompanyFilter(id)).lean();
        if (!company) {
            return res.status(404).json({ message: "Company not found." });
        }

        const fullProfile = (await loadCompanyFullProfile(company)) || company;
        const located = findCompanyDocumentRow(fullProfile, target);
        if (!located?.row) {
            return res.status(404).json({ message: "Document not found." });
        }

        const { field, row: deletedDoc } = located;

        await awaitAdminDeletionArchive(req, {
            moduleName: field === "oldDocuments" ? "Company Old Document" : "Company Document",
            recordId: company.companyId || String(company._id),
            details: (deletedDoc?.type || "Company document").toString(),
            deletedPayload: {
                companyId: company.companyId,
                companyName: company.name,
                document: deletedDoc,
                storageField: field,
            },
        });

        const { modified, found } = await pullFromCompanyDocumentBundle(company._id, field, target);
        if (!found || !modified) {
            return res.status(404).json({ message: "Document not found." });
        }

        return res.status(200).json({ message: "Company document deleted successfully." });
    } catch (error) {
        console.error("Error deleting company document:", error);
        return res.status(500).json({ message: "Server error", error: error.message });
    }
};
