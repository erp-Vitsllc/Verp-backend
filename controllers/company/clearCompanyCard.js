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
        await closeCreatorNotRenewFollowUpTasks(companyBefore._id, {
            kind: notRenewKind,
            closeAllOfKind: true,
        });

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
