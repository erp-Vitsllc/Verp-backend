import mongoose from "mongoose";
import Company from "../../models/Company.js";
import {
    loadCompanyFullProfile,
    pullFromCompanyDocumentBundle,
    findBundleArrayRow,
    loadAuthoritativeBundleArray,
    isCompanyUsingPartitions,
} from "../../services/companyPartitionService.js";
import { signCompanyProfileForResponse } from "../../utils/signCompanyProfileForResponse.js";
import { calculateCompanyActivationProgress } from "../../utils/companyActivation.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { isRequestUserDesignatedFlowchartHr } from "../../utils/isDesignatedFlowchartHr.js";
import { hasPermission } from "../../services/permissionService.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { scheduleCompanyProfileFileDeleteHrEmail } from "../../utils/companyInformativeHrNotify.js";

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
    const row = findBundleArrayRow(list, target);
    if (!row) return null;
    const rowId = row._id ?? row.id;
    if (rowId && /^[a-fA-F0-9]{24}$/.test(String(rowId))) {
        return { row, pullById: true, oid: new mongoose.Types.ObjectId(String(rowId)) };
    }
    const index = Number.parseInt(String(target ?? "").trim(), 10);
    if (Number.isInteger(index) && index >= 0) {
        return { row, pullById: false, index };
    }
    return { row, pullById: true, oid: row._id };
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

        const fullProfile = (await loadCompanyFullProfile(company)) || company;
        const bundleList = isCompanyUsingPartitions(company)
            ? await loadAuthoritativeBundleArray(company._id, fieldName)
            : fullProfile[fieldName];

        const isAdmin = await isReqUserAdmin(req.user);
        const isDesignatedHr = await isRequestUserDesignatedFlowchartHr(req);
        const canBypassActivatedDelete = isAdmin || isDesignatedHr;
        const activated = isCompanyProfileActivated(company);
        const permModule = FIELD_PERMISSION_MAP[fieldName];

        if (!isAdmin) {
            if (activated) {
                if (!canBypassActivatedDelete) {
                    return res.status(403).json({
                        message: `Only administrator can delete ${fieldName} records on an activated company profile.`,
                    });
                }
            } else {
                const userId = req.user?.id || req.user?._id;
                const hasDeletePerm =
                    userId && permModule && (await hasPermission(userId, permModule, "delete"));
                if (!canBypassActivatedDelete && !hasDeletePerm) {
                    return res.status(403).json({
                        message: `You do not have permission to delete this ${fieldName} record.`,
                    });
                }
            }
        }

        const resolved = resolveArrayItem(bundleList, target);
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

        const { modified, found } = await pullFromCompanyDocumentBundle(company._id, fieldName, target);
        if (!found || !modified) {
            return res.status(404).json({ message: `${fieldName} entry not found.` });
        }

        const refreshedCore = await Company.findOne(buildCompanyFilter(id)).lean();
        const fullAfter = (await loadCompanyFullProfile(refreshedCore)) || refreshedCore;

        const followUpTarget = { kind: fieldName };
        if (resolved.pullById && resolved.oid) {
            followUpTarget.arrayItemId = String(resolved.oid);
        } else if (Number.isInteger(resolved.index)) {
            followUpTarget.arrayIndex = resolved.index;
        } else {
            followUpTarget.closeAllOfKind = true;
        }
        await closeCreatorNotRenewFollowUpTasks(company._id, followUpTarget);

        scheduleCompanyProfileFileDeleteHrEmail({
            company: fullAfter,
            sectionKey: fieldName,
            sectionLabel: label,
            action: "deleted",
            attachment: resolved.row?.document || resolved.row?.attachment || null,
            actor: req.user,
        });

        return res.status(200).json({
            message: `${label} entry deleted successfully.`,
            company: await signCompanyProfileForResponse(fullAfter),
            activationProgress: calculateCompanyActivationProgress(fullAfter),
        });
    } catch (error) {
        console.error("deleteCompanyArrayItem error:", error);
        return res.status(500).json({ message: error.message || "Failed to delete record." });
    }
};
