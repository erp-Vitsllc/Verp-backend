import mongoose from "mongoose";
import Company from "../../models/Company.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";

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
        const filter = buildCompanyFilter(id);
        let result;

        if (mongoose.Types.ObjectId.isValid(target)) {
            result = await Company.updateOne(filter, {
                $pull: { documents: { _id: new mongoose.Types.ObjectId(target) } },
            });
        } else {
            const index = Number.parseInt(target, 10);
            if (!Number.isInteger(index) || index < 0) {
                return res.status(400).json({ message: "Invalid document target." });
            }

            result = await Company.updateOne(filter, {
                $unset: { [`documents.${index}`]: 1 },
            });

            if (result.matchedCount) {
                await Company.updateOne(filter, { $pull: { documents: null } });
            }
        }

        if (!result.matchedCount) {
            return res.status(404).json({ message: "Company not found." });
        }

        return res.status(200).json({ message: "Company document deleted successfully." });
    } catch (error) {
        console.error("Error deleting company document:", error);
        return res.status(500).json({ message: "Server error", error: error.message });
    }
};
