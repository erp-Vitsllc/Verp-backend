import mongoose from "mongoose";
import Company from "../../models/Company.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";

const ALLOWED_FIELDS = new Set(["ejari", "insurance"]);

const buildCompanyFilter = (id) => ({
    $or: [
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
        { companyId: id },
    ],
});

function resolveArrayItem(list, target) {
    const items = Array.isArray(list) ? list : [];
    const targetStr = String(target ?? "").trim();
    if (/^[a-fA-F0-9]{24}$/.test(targetStr)) {
        const byId = items.find((row) => String(row?._id) === targetStr);
        if (byId) return { row: byId, pullById: true, oid: new mongoose.Types.ObjectId(targetStr) };
    }
    const index = Number.parseInt(targetStr, 10);
    if (Number.isInteger(index) && index >= 0 && index < items.length) {
        return { row: items[index], pullById: false, index };
    }
    return null;
}

/**
 * Admin delete Ejari / Insurance card with Deleted Records archive (attachments preserved).
 * DELETE /api/Company/:id/array-field/:field/:target  — target = Mongo _id or array index
 */
export const deleteCompanyArrayItem = async (req, res) => {
    try {
        if (!(await isReqUserAdmin(req.user))) {
            return res.status(403).json({ message: "Only administrator can delete company records." });
        }

        const { id, field, target } = req.params;
        const fieldName = String(field || "").trim();
        if (!ALLOWED_FIELDS.has(fieldName)) {
            return res.status(400).json({ message: "Invalid field. Use ejari or insurance." });
        }

        const company = await Company.findOne(buildCompanyFilter(id)).lean();
        if (!company) {
            return res.status(404).json({ message: "Company not found." });
        }

        const resolved = resolveArrayItem(company[fieldName], target);
        if (!resolved?.row) {
            return res.status(404).json({ message: `${fieldName} entry not found.` });
        }

        const label = fieldName === "ejari" ? "Ejari" : "Insurance";
        const rowLabel = resolved.row.type || resolved.row.description || label;

        await awaitAdminDeletionArchive(req, {
            moduleName: `Company ${label}`,
            recordId: company.companyId || String(company._id),
            details: `${rowLabel} removed from ${company.name || company.companyId}`,
            deletedPayload: {
                companyId: company.companyId,
                companyName: company.name,
                field: fieldName,
                item: resolved.row,
            },
        });

        const filter = buildCompanyFilter(id);
        if (resolved.pullById) {
            await Company.updateOne(filter, {
                $pull: { [fieldName]: { _id: resolved.oid } },
            });
        } else {
            await Company.updateOne(filter, {
                $unset: { [`${fieldName}.${resolved.index}`]: 1 },
            });
            await Company.updateOne(filter, { $pull: { [fieldName]: null } });
        }

        return res.status(200).json({
            message: `${label} entry deleted successfully.`,
        });
    } catch (error) {
        console.error("deleteCompanyArrayItem error:", error);
        return res.status(500).json({ message: error.message || "Failed to delete record." });
    }
};
