import mongoose from "mongoose";
import Company from "../../models/Company.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { hasPermission } from "../../services/permissionService.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";

const ALLOWED_FIELDS = new Set(["ejari", "insurance"]);

const FIELD_PERMISSION_MAP = {
    ejari: "hrm_company_view_basic_ejari",
    insurance: "hrm_company_view_documents_live_with_expiry",
};

const buildCompanyFilter = (id) => ({
    $or: [
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
        { companyId: id },
    ],
});

function isCompanyProfileActivated(company) {
    const status = String(company?.status || "").toLowerCase();
    const activationStatus = String(company?.activationStatus || "").toLowerCase();
    return status === "active" && activationStatus === "active";
}

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
 * Delete Ejari / Insurance card with Deleted Records archive (attachments preserved).
 * DELETE /api/Company/:id/array-field/:field/:target  — target = Mongo _id or array index
 */
export const deleteCompanyArrayItem = async (req, res) => {
    try {
        const { id, field, target } = req.params;
        const fieldName = String(field || "").trim();
        if (!ALLOWED_FIELDS.has(fieldName)) {
            return res.status(400).json({ message: "Invalid field. Use ejari or insurance." });
        }

        const company = await Company.findOne(buildCompanyFilter(id)).lean();
        if (!company) {
            return res.status(404).json({ message: "Company not found." });
        }

        const isAdmin = await isReqUserAdmin(req.user);
        const activated = isCompanyProfileActivated(company);
        const permModule = FIELD_PERMISSION_MAP[fieldName];

        if (activated) {
            if (!isAdmin) {
                return res.status(403).json({
                    message: `Only administrator can delete ${fieldName} records on an activated company profile.`,
                });
            }
        } else {
            const userId = req.user?.id || req.user?._id;
            const hasDeletePerm =
                userId && permModule && (await hasPermission(userId, permModule, "delete"));
            if (!isAdmin && !hasDeletePerm) {
                return res.status(403).json({
                    message: `You do not have permission to delete this ${fieldName} record.`,
                });
            }
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
