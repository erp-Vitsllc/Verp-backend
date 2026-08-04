import mongoose from "mongoose";
import Company from "../../models/Company.js";
import CompanyCompliance from "../../models/CompanyCompliance.js";
import { denyCompanyCardDeleteUnlessAllowed } from "../../utils/companyProfileDeleteAccess.js";
import { buildAttachmentKeysMap } from "../../utils/listDeletionAttachmentRefs.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import {
    stripProposedDataKeysFromPendingReactivationEntries,
    calculateCompanyActivationProgress,
} from "../../utils/companyActivation.js";
import { scheduleCompanyCardDeletedNotification } from "../../utils/cardDeleteNotificationHelper.js";
import {
    loadCompanyFullProfile,
    upsertCompanyPartitions,
} from "../../services/companyPartitionService.js";
import { signCompanyProfileForResponse } from "../../utils/signCompanyProfileForResponse.js";
import { closeCreatorNotRenewFollowUpTasks } from "../../utils/companyNotRenewFollowUp.js";
import { cleanupAllNotificationsForCompanyCardDelete } from "../../utils/cleanupCompanyCardNotifications.js";
import DashboardAction from "../../models/DashboardAction.js";

const clearCompanyPendingNotRenewRequestsByKind = async (companyObjectId, kind) => {
    if (!companyObjectId || !kind) return;
    try {
        const Company = (await import("../../models/Company.js")).default;
        const core = await Company.findById(companyObjectId).lean();
        if (!core) return;
        const full = (await loadCompanyFullProfile(core)) || core;
        const pending = Array.isArray(full.pendingNotRenewRequests) ? full.pendingNotRenewRequests : [];
        if (!pending.length) return;
        const kindNorm = String(kind).trim().toLowerCase();
        const next = pending.filter((p) => String(p?.kind || "").trim().toLowerCase() !== kindNorm);
        if (next.length === pending.length) return;
        await upsertCompanyPartitions(companyObjectId, { pendingNotRenewRequests: next });
    } catch (err) {
        console.error("[clearCompanyPendingNotRenewRequestsByKind]", err);
    }
};

const closeCompanyActivationIfQueueEmpty = async (companyObjectId, pendingEntries = []) => {
    if (!companyObjectId) return;
    if (Array.isArray(pendingEntries) && pendingEntries.length > 0) return;
    await DashboardAction.deleteMany({
        requestId: companyObjectId,
        requestType: "Company Activation",
        status: { $in: ["Pending", "On Hold"] },
    });
};
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

const CARD_LABEL_MAP = {
    tradeLicense: "Trade License",
    establishmentCard: "Establishment Card",
};

const buildCompanyFilter = (id) => ({
    $or: [
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
        { companyId: id },
    ],
});

export const clearCompanyCard = async (req, res) => {
    try {
        const { id, card } = req.params;
        const fields = CARD_FIELD_MAP[card];
        if (!fields) {
            return res.status(400).json({ message: "Unknown company card." });
        }

        const companyCore = await Company.findOne(buildCompanyFilter(id)).lean();
        if (!companyCore) {
            return res.status(404).json({ message: "Company not found." });
        }

        const companyBefore = (await loadCompanyFullProfile(companyCore)) || companyCore;

        const denied = await denyCompanyCardDeleteUnlessAllowed(req, companyBefore);
        if (denied) return res.status(denied.status).json(denied.body);

        const snapshot = fields.reduce((acc, field) => {
            acc[field] = companyBefore[field];
            return acc;
        }, {});

        await awaitAdminDeletionArchive(req, {
            moduleName: `Company ${card}`,
            recordId: companyBefore.companyId || String(companyBefore._id),
            details: `${card} card cleared for ${companyBefore.name || companyBefore.companyId}`,
            deletedPayload: {
                companyId: companyBefore.companyId,
                companyName: companyBefore.name,
                companyStatus: companyBefore.status,
                activationStatus: companyBefore.activationStatus,
                card,
                fields: snapshot,
                attachmentKeys: buildAttachmentKeysMap(snapshot),
            },
        });

        const unsetOps = fields.reduce((acc, field) => {
            acc[field] = 1;
            return acc;
        }, {});

        const filter = buildCompanyFilter(id);
        const coreDoc = await Company.findOne(filter).select("_id").lean();
        if (!coreDoc?._id) {
            return res.status(404).json({ message: "Company not found." });
        }

        await Company.collection.updateOne({ _id: coreDoc._id }, { $unset: unsetOps });

        await CompanyCompliance.updateOne(
            { company: companyBefore._id },
            { $unset: unsetOps },
            { upsert: true },
        );

        const existingPending = Array.isArray(companyBefore.pendingReactivationChanges)
            ? companyBefore.pendingReactivationChanges
            : [];
        const nextPending = stripProposedDataKeysFromPendingReactivationEntries(existingPending, fields);
        if (JSON.stringify(nextPending) !== JSON.stringify(existingPending)) {
            await upsertCompanyPartitions(companyBefore._id, {
                pendingReactivationChanges: nextPending,
            });
        }

        const refreshedCore = await Company.findOne(buildCompanyFilter(id)).lean();
        const fullProfile = (await loadCompanyFullProfile(refreshedCore)) || refreshedCore;
        const signedCompany = await signCompanyProfileForResponse(fullProfile);
        const activationProgress = calculateCompanyActivationProgress(fullProfile || {});

        const notRenewKind = card === "tradeLicense" ? "tradeLicense" : "establishmentCard";
        const expiryLabels =
            card === "tradeLicense"
                ? ["Trade License", "Trade licence", "TradeLicense", "tradeLicense"]
                : ["Establishment Card", "Establishment", "establishmentCard"];

        await closeCreatorNotRenewFollowUpTasks(companyBefore._id, {
            kind: notRenewKind,
            closeAllOfKind: true,
        });
        await clearCompanyPendingNotRenewRequestsByKind(companyBefore._id, notRenewKind);
        await cleanupAllNotificationsForCompanyCardDelete({
            companyObjectId: companyBefore._id,
            labels: expiryLabels,
            notRenewKind,
        });
        await closeCompanyActivationIfQueueEmpty(companyBefore._id, nextPending);

        scheduleCompanyCardDeletedNotification(req, fullProfile || companyBefore, {
            cardLabel: CARD_LABEL_MAP[card] || card,
            cardKey: card,
            progressPercentage: activationProgress?.percentage ?? null,
        });

        return res.status(200).json({
            message: "Company card cleared successfully.",
            company: signedCompany,
            activationProgress,
        });
    } catch (error) {
        console.error("Error clearing company card:", error);
        return res.status(500).json({ message: "Server error", error: error.message });
    }
};
