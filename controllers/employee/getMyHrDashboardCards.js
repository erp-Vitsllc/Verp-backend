import EmployeeBasic from "../../models/EmployeeBasic.js";
import Loan from "../../models/Loan.js";
import Reward from "../../models/Reward.js";
import Fine from "../../models/Fine.js";
import { resolveEmployeeFinePayableAmount } from "../../utils/finePayableAmount.js";

function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

/** Dashboard lists: Approved or Paid (and equivalent settled statuses) only. */
function isApprovedOrPaidStatus(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) return false;
    if (s === "draft" || s === "pending") return false;
    if (s.includes("reject") || s.includes("cancel")) return false;
    if (s.includes("pending hr") || s.includes("pending accounts") || s.includes("pending authorization")) {
        return false;
    }
    return (
        s === "approved" ||
        s.startsWith("approved") ||
        s === "paid" ||
        s.includes("(paid)") ||
        s === "active" ||
        s === "completed" ||
        s === "recovered" ||
        s === "pending payment to employee"
    );
}

function displayLoanStatus(item) {
    const raw = String(item?.approvalStatus || item?.status || "").trim();
    if (!raw) return "—";
    const amount = Number(item.amount) || 0;
    const paid = Number(item.paidAmount) || 0;
    if (raw === "Paid" || (amount > 0 && paid >= amount - 0.01)) return "Recovered";
    if (raw === "Pending Payment to Employee") return "Pending payment";
    return raw;
}

function mapLoanItem(item) {
    const amount = roundMoney(item.amount);
    const paid = roundMoney(item.paidAmount);
    const status = displayLoanStatus(item);
    const type = item.type === "Advance" ? "Advance" : "Loan";
    return {
        id: String(item._id),
        code: item.loanId || type,
        type,
        amount,
        paid,
        outstanding: Math.max(0, roundMoney(amount - paid)),
        status,
        date: item.createdAt || null,
        href: `/HRM/LoanAndAdvance/${type.replace(/\s+/g, "-")}-${item._id}`,
    };
}

function displayRewardStatus(item) {
    const raw = String(item?.rewardStatus || item?.approvalStatus || "").trim();
    if (!raw || raw === "Draft") return "";
    if (
        raw === "Pending Accounts" ||
        raw === "Approved (Not Paid)" ||
        raw === "Approved (Paid)" ||
        raw === "Paid" ||
        raw === "Completed" ||
        raw === "Approved" ||
        raw === "Active"
    ) {
        return "Completed";
    }
    return raw;
}

function mapRewardItem(item) {
    const status = displayRewardStatus(item);
    if (!status) return null;
    const code = item.rewardId || String(item._id);
    return {
        id: String(item._id),
        code,
        type: item.rewardType || "Reward",
        title: item.title || item.description || item.rewardType || "Reward",
        amount: roundMoney(item.amount),
        status,
        date: item.awardedDate || item.createdAt || null,
        href: `/HRM/Reward/rewrd.${encodeURIComponent(code)}`,
    };
}

function displayFineStatus(status, share, paid) {
    const raw = String(status || "").trim();
    if (!raw || raw === "Draft") return "";
    if (raw === "Paid" || raw === "Completed" || (share > 0 && paid >= share - 0.01)) return "Recovered";
    if (raw === "Approved" || raw === "Active") return "Approved";
    return raw;
}

function mapFineItem(item, employeeId) {
    const rawStatus = String(item?.fineStatus || "").trim();
    if (!rawStatus || rawStatus === "Draft") return null;

    const share = resolveEmployeeFinePayableAmount(item, employeeId);
    if (share <= 0 && !rawStatus.toLowerCase().includes("pending")) return null;

    const entry = (item.assignedEmployees || []).find((ae) => ae.employeeId === employeeId);
    const paid = Math.min(parseFloat(entry?.paidAmount ?? item.paidAmount ?? 0) || 0, share);
    const status = displayFineStatus(rawStatus, share, paid);
    if (!status) return null;

    const code = item.fineId || String(item._id);
    return {
        id: String(item._id),
        code,
        type: item.fineType || "Fine",
        amount: roundMoney(share),
        paid: roundMoney(paid),
        outstanding: roundMoney(Math.max(0, share - paid)),
        status,
        date: item.awardedDate || item.createdAt || null,
        href: `/HRM/Fine/${encodeURIComponent(code)}`,
    };
}

async function resolveEmployeeCode(req) {
    if (req.user?.employeeId) return String(req.user.employeeId).trim();
    if (!req.user?.employeeObjectId) return "";
    const emp = await EmployeeBasic.findById(req.user.employeeObjectId).select("employeeId").lean();
    return String(emp?.employeeId || "").trim();
}

/**
 * Logged-in employee's own loan / advance / reward / fine records for the home dashboard.
 * @route GET /api/Employee/dashboard/my-hr-cards
 */
export const getMyHrDashboardCards = async (req, res) => {
    try {
        const employeeId = await resolveEmployeeCode(req);
        const empty = {
            employeeId: employeeId || null,
            loans: [],
            advances: [],
            rewards: [],
            fines: [],
        };

        if (!employeeId) {
            return res.status(200).json(empty);
        }

        const loanQuery = { employeeId, status: { $ne: "Draft" } };
        if (req.user?.employeeObjectId) {
            loanQuery.$or = [{ employeeId }, { employeeObjectId: req.user.employeeObjectId }];
            delete loanQuery.employeeId;
        }

        const [loans, rewards, fines] = await Promise.all([
            Loan.find(loanQuery)
                .select("type loanId amount paidAmount status approvalStatus createdAt")
                .sort({ createdAt: -1 })
                .lean(),
            Reward.find({ employeeId, rewardStatus: { $ne: "Draft" } })
                .select("rewardId rewardType rewardStatus approvalStatus amount title description awardedDate createdAt")
                .sort({ createdAt: -1 })
                .lean(),
            Fine.find({ "assignedEmployees.employeeId": employeeId, fineStatus: { $ne: "Draft" } })
                .select(
                    "fineId fineType fineStatus responsibleFor fineAmount totalFineAmount employeeAmount companyAmount serviceCharge assignedEmployees paidAmount isGroupView awardedDate createdAt",
                )
                .sort({ createdAt: -1 })
                .lean(),
        ]);

        return res.status(200).json({
            employeeId,
            loans: (loans || [])
                .filter((item) => item.type === "Loan" && isApprovedOrPaidStatus(item.approvalStatus || item.status))
                .map(mapLoanItem),
            advances: (loans || [])
                .filter((item) => item.type === "Advance" && isApprovedOrPaidStatus(item.approvalStatus || item.status))
                .map(mapLoanItem),
            rewards: (rewards || [])
                .filter((item) => isApprovedOrPaidStatus(item.rewardStatus || item.approvalStatus))
                .map(mapRewardItem)
                .filter(Boolean),
            fines: (fines || [])
                .filter((item) => isApprovedOrPaidStatus(item.fineStatus))
                .map((item) => mapFineItem(item, employeeId))
                .filter(Boolean),
        });
    } catch (error) {
        console.error("[getMyHrDashboardCards]", error);
        return res.status(500).json({ message: "Failed to load dashboard HR cards" });
    }
};
