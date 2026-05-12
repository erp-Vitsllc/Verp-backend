import mongoose from "mongoose";
import Company from "../../models/Company.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";

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

const buildCompanyFilter = (id) => ({
    $or: [
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
        { companyId: id },
    ],
});

export const clearCompanyCard = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can clear company card details." });
        }

        const { id, card } = req.params;
        const fields = CARD_FIELD_MAP[card];
        if (!fields) {
            return res.status(400).json({ message: "Unknown company card." });
        }

        const unsetOps = fields.reduce((acc, field) => {
            acc[field] = 1;
            return acc;
        }, {});

        const result = await Company.updateOne(buildCompanyFilter(id), { $unset: unsetOps });
        if (!result.matchedCount) {
            return res.status(404).json({ message: "Company not found." });
        }

        return res.status(200).json({ message: "Company card cleared successfully." });
    } catch (error) {
        console.error("Error clearing company card:", error);
        return res.status(500).json({ message: "Server error", error: error.message });
    }
};
