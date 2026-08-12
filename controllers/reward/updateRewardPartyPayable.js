import Reward from "../../models/Reward.js";

/**
 * Accounts party payable only — Expense Account / Paid Through / Zoho org
 * on the Reward Parties card.
 * Paid only after Zoho Expense succeeds (does not affect Loan/Advance).
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

        const amount = Number(reward.amount) || 0;
        const hasZoho = Boolean(
            String(reward.zohoExpenseId || '').trim() || String(reward.zohoJournalId || '').trim()
        );
        const syncErr = Boolean(String(reward.zohoSyncError || "").trim());
        const status = String(reward.rewardStatus || reward.approvalStatus || "").trim();

        // Allow Accounts field edit at Pending Accounts, or Zoho retry while already Paid but sync failed.
        const canFixFailedZoho =
            !hasZoho &&
            syncErr &&
            (status === "Pending Accounts" || status === "Approved (Paid)" || status === "Paid");
        const canEditAtAccounts = status === "Pending Accounts";

        if (!canEditAtAccounts && !canFixFailedZoho) {
            return res.status(403).json({
                message: hasZoho
                    ? "Accounts fields cannot be changed after Zoho is posted."
                    : "Expense Account / Paid Through can only be set at the Accounts stage.",
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

        // Retry Zoho when Accounts fields are complete (Pending Accounts or Paid-with-sync-error)
        const canRetryZoho =
            String(reward.expenseAccountId || "").trim() &&
            String(reward.paidThroughAccountId || "").trim() &&
            String(reward.expenseAccountId).trim() !== String(reward.paidThroughAccountId).trim() &&
            !hasZoho &&
            (syncErr || status === "Pending Accounts" || status === "Approved (Paid)" || status === "Paid");

        if (canRetryZoho && (syncErr || canFixFailedZoho || status === "Approved (Paid)" || status === "Paid")) {
            try {
                const EmployeeBasic = (await import("../../models/EmployeeBasic.js")).default;
                const { syncRewardApprovalToZohoExpense } = await import(
                    "../../utils/syncRewardPaymentToZoho.js"
                );
                const employee = await EmployeeBasic.findOne({ employeeId: reward.employeeId })
                    .select("employeeId company firstName lastName")
                    .lean();
                const zohoResult = await syncRewardApprovalToZohoExpense({
                    reward,
                    employee,
                });
                if (zohoResult?.ok && zohoResult.expenseId) {
                    reward.zohoExpenseId = zohoResult.expenseId;
                    reward.zohoExpenseNumber = zohoResult.expenseNumber || "";
                    reward.zohoOrganizationId =
                        zohoResult.organizationId || reward.zohoOrganizationId || "";
                    reward.zohoSyncedAt = new Date();
                    reward.zohoSyncError = "";
                    reward.rewardStatus = "Approved (Paid)";
                    reward.approvalStatus = "Approved (Paid)";
                    reward.paymentStatus = "Billed";
                    if (amount > 0) reward.paidAmount = amount;
                    const accountsStep = (reward.workflow || []).find((w) => w.role === "Accounts");
                    if (accountsStep) {
                        accountsStep.status = "Approved";
                        accountsStep.actionedAt = new Date();
                    }
                } else if (zohoResult && !zohoResult.ok) {
                    reward.zohoSyncError = zohoResult.message || "Zoho Expense sync failed";
                }
            } catch (zohoErr) {
                reward.zohoSyncError = zohoErr?.message || "Zoho Expense sync failed";
                console.error("[updateRewardPartyPayable] Zoho retry error:", zohoErr);
            }
        }

        const saved = await reward.save();
        return res.status(200).json({
            message: String(saved.zohoExpenseId || "").trim()
                ? "Party accounts updated and Zoho Expense posted — reward is Approved (Paid)."
                : "Party accounts updated successfully",
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
