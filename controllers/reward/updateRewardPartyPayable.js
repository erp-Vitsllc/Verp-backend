import Reward from "../../models/Reward.js";

/**
 * Accounts party payable only — Expense Account / Paid Through / Zoho org
 * on the Reward Parties card (same pattern as Loan/Adv Parties).
 * Uses Reward view permission (not Create).
 */
export const updateRewardPartyPayable = async (req, res) => {
    const { id } = req.params;
    const {
        expenseAccountId,
        expenseAccountName,
        paidThroughAccountId,
        paidThroughAccountName,
        zohoOrganizationId,
    } = req.body || {};

    try {
        const reward = await Reward.findById(id);
        if (!reward) {
            return res.status(404).json({ message: "Reward not found" });
        }

        const status = String(reward.rewardStatus || reward.approvalStatus || "").trim();
        const amount = Number(reward.amount) || 0;
        const paid = Number(reward.paidAmount) || 0;
        const hasZoho = Boolean(
            String(reward.zohoExpenseId || '').trim() || String(reward.zohoJournalId || '').trim()
        );
        const syncErr = Boolean(String(reward.zohoSyncError || "").trim());
        const canFixFailedZoho =
            !hasZoho &&
            syncErr &&
            (status === "Approved (Paid)" ||
                status === "Paid" ||
                (amount > 0 && paid >= amount - 0.01));

        const isCashOrGift =
            reward.rewardType === "Cash Reward" ||
            reward.rewardType === "Gift Reward" ||
            amount > 0;

        const canEditAtAccounts = status === "Pending Accounts";
        const canEditBeforePay =
            isCashOrGift &&
            status === "Approved" &&
            amount > 0 &&
            amount - paid > 0.01;

        if (!canEditAtAccounts && !canEditBeforePay && !canFixFailedZoho) {
            return res.status(403).json({
                message: hasZoho
                    ? "Accounts fields cannot be changed after Zoho is posted."
                    : "Expense Account / Paid Through can only be set at the Accounts stage or before payment.",
            });
        }

        if (zohoOrganizationId !== undefined) {
            reward.zohoOrganizationId = String(zohoOrganizationId || "").trim();
        }

        if (expenseAccountId !== undefined) {
            reward.expenseAccountId = String(expenseAccountId || "").trim();
        }
        if (expenseAccountName !== undefined) {
            reward.expenseAccountName = String(expenseAccountName || "").trim();
        }
        if (!reward.expenseAccountId) {
            reward.expenseAccountName = "";
        }

        if (paidThroughAccountId !== undefined) {
            reward.paidThroughAccountId = String(paidThroughAccountId || "").trim();
        }
        if (paidThroughAccountName !== undefined) {
            reward.paidThroughAccountName = String(paidThroughAccountName || "").trim();
        }
        if (!reward.paidThroughAccountId) {
            reward.paidThroughAccountName = "";
        }

        const saved = await reward.save();
        return res.status(200).json({
            message: "Party accounts updated successfully",
            reward: saved,
        });
    } catch (error) {
        console.error("[updateRewardPartyPayable]", error);
        if (error.name === "CastError") {
            return res.status(400).json({ message: "Invalid reward ID format" });
        }
        return res.status(500).json({
            message: error.message || "Failed to update party accounts",
        });
    }
};
