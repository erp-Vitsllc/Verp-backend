import Company from "../../models/Company.js";
import mongoose from "mongoose";
import {
    isReqUserAdmin,
    scheduleManagementAdminDeletionEmail,
} from "../../utils/sendAdminDeletionNotificationEmails.js";

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
        const filter = {
            $or: [
                ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
                { companyId: id },
            ],
        };
        const company = await Company.findOne(filter).lean();
        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        let deletedDoc = null;
        if (mongoose.Types.ObjectId.isValid(target)) {
            deletedDoc = (company.oldDocuments || []).find((d) => String(d._id) === String(target));
        } else {
            const docIndex = Number.parseInt(target, 10);
            if (Number.isInteger(docIndex) && docIndex >= 0 && company.oldDocuments?.[docIndex]) {
                deletedDoc = company.oldDocuments[docIndex];
            }
        }
        if (deletedDoc) {
            scheduleManagementAdminDeletionEmail(req, {
                moduleName: "Company Old Document",
                recordId: company.companyId || String(company._id),
                details: (deletedDoc?.type || "Archived company document").toString(),
                deletedPayload: {
                    companyId: company.companyId,
                    companyName: company.name,
                    document: deletedDoc,
                },
            });
        }

        let result;

        if (mongoose.Types.ObjectId.isValid(target)) {
            result = await Company.updateOne(filter, {
                $pull: { oldDocuments: { _id: new mongoose.Types.ObjectId(target) } },
            });
        } else {
            const docIndex = Number.parseInt(target, 10);
            if (!Number.isInteger(docIndex) || docIndex < 0) {
                return res.status(400).json({ message: "Invalid archived document target" });
            }
            result = await Company.updateOne(filter, {
                $unset: { [`oldDocuments.${docIndex}`]: 1 },
            });
            if (result.matchedCount) {
                await Company.updateOne(filter, { $pull: { oldDocuments: null } });
            }
        }

        if (!result.matchedCount) {
            return res.status(404).json({ message: "Company not found" });
        }

        res.status(200).json({
            message: "Archived company document deleted successfully",
        });

    } catch (error) {
        console.error("Error deleting archived company document:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};
