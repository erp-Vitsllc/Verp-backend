import EmployeeBasic from "../../models/EmployeeBasic.js";
import Loan from "../../models/Loan.js";
import Reward from "../../models/Reward.js";
import Fine from "../../models/Fine.js";
import { resolveEmployeeFinePayableAmount } from "../../utils/finePayableAmount.js";
import {
    fineIsVisibleToEmployee,
    loanIsVisibleToEmployee,
    rewardIsVisibleToEmployee,
} from "../../utils/employeeFinancialVisibility.js";

function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

function displayLoanStatus(item) {
    const raw = String(item?.approvalStatus || item?.status || "").trim();
    if (!raw) return "—";
    const amount = Number(item.amount) || 0;
    const paid = Number(item.paidAmount) || 0;
    if (raw === "Paid" || (amount > 0 && paid >= amount - 0.01)) return "Recovered";
    return raw;
}

function displayRepaymentPayment(outstanding) {
    return outstanding <= 0.01 ? "Paid" : "Not Paid";
}

function resolveScheduleStart(startRaw, fallbackDate) {
    const fallback = fallbackDate ? new Date(fallbackDate) : new Date();
    const base = Number.isNaN(fallback.getTime()) ? new Date() : fallback;
    const start = String(startRaw || "").trim();

    if (/^\d{4}-\d{2}$/.test(start)) {
        const [yearText, monthText] = start.split("-");
        return { year: parseInt(yearText, 10), monthIndex: parseInt(monthText, 10) - 1 };
    }

    if (start) {
        const nameIndex = MONTH_NAMES.findIndex((month) => month.toLowerCase() === start.toLowerCase());
        if (nameIndex >= 0) return { year: base.getFullYear(), monthIndex: nameIndex };
    }

    const nextMonth = base.getMonth() + 1;
    return {
        year: nextMonth > 11 ? base.getFullYear() + 1 : base.getFullYear(),
        monthIndex: nextMonth % 12,
    };
}

function buildMonthSchedule(startRaw, durationRaw, total, paid, fallbackDate, options = {}) {
    const duration = Math.max(1, Number(durationRaw) || 1);
    const { year: startYear, monthIndex: startIndex } = resolveScheduleStart(startRaw, fallbackDate);
    const monthly = total > 0 ? total / duration : 0;
    let remainingPaid = Math.max(0, Number(paid) || 0);
    let monthIndex = startIndex;
    let year = startYear;
    const boxes = [];

    for (let i = 0; i < duration; i++) {
        const thisPaid = Math.min(remainingPaid, monthly);
        remainingPaid = Math.max(0, remainingPaid - monthly);
        const isPaid = monthly <= 0.01 || thisPaid >= monthly - 0.5;
        const isPartial = !isPaid && thisPaid > 0.01;
        const monthName = MONTH_NAMES[monthIndex];
        boxes.push({
            key: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
            label: monthName.slice(0, 3),
            year,
            monthTitle: `${monthName} ${year}`,
            monthlyAmount: roundMoney(monthly),
            paidAmount: roundMoney(thisPaid),
            remaining: roundMoney(Math.max(0, monthly - thisPaid)),
            isPaid,
            isPartial,
            isEos: Boolean(options.isEos),
            paid: isPaid,
        });
        monthIndex += 1;
        if (monthIndex > 11) {
            monthIndex = 0;
            year += 1;
        }
    }
    return boxes;
}

function mapDocument(file, fallbackName) {
    if (!file || typeof file !== "object") return null;
    const url = String(file.url || file.attachment || "").trim();
    const name = String(file.name || file.label || file.type || fallbackName || "").trim();
    if (!url && !name) return null;
    return {
        name: name || "Document",
        url,
        mimeType: String(file.mimeType || ""),
    };
}

function collectDocuments(files, fallbackName) {
    return (Array.isArray(files) ? files : [files])
        .map((file) => mapDocument(file, fallbackName))
        .filter(Boolean);
}

function mapLoanItem(item) {
    const amount = roundMoney(item.amount);
    const repaid = roundMoney(item.repaidAmount);
    const status = displayLoanStatus(item);
    const type = item.type === "Advance" ? "Advance" : "Loan";
    const duration = Math.max(1, Number(item.duration || item.originalDuration) || 1);
    const outstanding = Math.max(0, roundMoney(amount - repaid));
    return {
        id: String(item._id),
        code: item.loanId || type,
        type,
        amount,
        paid: roundMoney(item.paidAmount),
        repaid,
        outstanding,
        deduction: roundMoney(amount / duration),
        status,
        payment: displayRepaymentPayment(outstanding),
        duration,
        monthStart: item.monthStart || item.originalMonthStart || "",
        reason: String(item.reason || "").trim(),
        documents: [
            ...collectDocuments(item.attachment, "Loan document"),
            ...collectDocuments(item.approvalAttachments, "Approval document"),
        ],
        schedule: buildMonthSchedule(
            item.monthStart || item.originalMonthStart,
            duration,
            amount,
            repaid,
            item.createdAt || item.appliedDate,
        ),
        date: item.createdAt || item.appliedDate || null,
        href: `/HRM/LoanAndAdvance/${type.replace(/\s+/g, "-")}-${item._id}`,
    };
}

function displayRewardStatus(item) {
    const raw = String(item?.rewardStatus || item?.approvalStatus || "").trim();
    if (!raw || raw === "Draft") return "";
    if (raw.toLowerCase().includes("pending")) return "";
    if (
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
        description: String(item.description || "").trim(),
        amount: roundMoney(item.amount),
        status,
        documents: [
            ...collectDocuments(item.attachment, "Reward document"),
            ...collectDocuments(item.certificateAttachment, "Reward certificate"),
        ],
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

function displayFinePayment(outstanding) {
    return outstanding <= 0.01 ? "Paid" : "Not Paid";
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

    const outstanding = roundMoney(Math.max(0, share - paid));
    const code = item.fineId || String(item._id);
    return {
        id: String(item._id),
        code,
        type: item.fineType || "Fine",
        amount: roundMoney(share),
        paid: roundMoney(paid),
        outstanding,
        status,
        payment: displayFinePayment(outstanding),
        duration: Math.max(1, Number(item.payableDuration || item.originalPayableDuration) || 1),
        monthStart: item.monthStart || item.originalMonthStart || "",
        description: String(item.description || "").trim(),
        sourceOfIncome: item.sourceOfIncome || "Salary",
        documents: [
            ...collectDocuments(item.attachment, "Fine document"),
            ...collectDocuments(item.attachments, "Fine attachment"),
        ],
        schedule: buildMonthSchedule(
            item.monthStart || item.originalMonthStart,
            item.payableDuration || item.originalPayableDuration,
            share,
            paid,
            item.awardedDate || item.createdAt,
            { isEos: item.sourceOfIncome === "End of Service" },
        ),
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
                .select(
                    "type loanId amount paidAmount repaidAmount duration monthStart originalMonthStart originalDuration status approvalStatus createdAt appliedDate reason attachment approvalAttachments",
                )
                .sort({ createdAt: -1 })
                .lean(),
            Reward.find({ employeeId, rewardStatus: { $ne: "Draft" } })
                .select("rewardId rewardType rewardStatus approvalStatus amount title description awardedDate createdAt attachment certificateAttachment")
                .sort({ createdAt: -1 })
                .lean(),
            Fine.find({ "assignedEmployees.employeeId": employeeId, fineStatus: { $ne: "Draft" } })
                .select(
                    "fineId fineType fineStatus responsibleFor fineAmount totalFineAmount employeeAmount companyAmount serviceCharge assignedEmployees paidAmount isGroupView awardedDate createdAt payableDuration monthStart originalMonthStart originalPayableDuration sourceOfIncome description attachment attachments",
                )
                .sort({ createdAt: -1 })
                .lean(),
        ]);

        return res.status(200).json({
            employeeId,
            loans: (loans || [])
                .filter((item) => item.type === "Loan" && loanIsVisibleToEmployee(item))
                .map(mapLoanItem),
            advances: (loans || [])
                .filter((item) => item.type === "Advance" && loanIsVisibleToEmployee(item))
                .map(mapLoanItem),
            rewards: (rewards || [])
                .filter((item) => rewardIsVisibleToEmployee(item))
                .map(mapRewardItem)
                .filter(Boolean),
            fines: (fines || [])
                .filter((item) => fineIsVisibleToEmployee(item, employeeId))
                .map((item) => mapFineItem(item, employeeId))
                .filter(Boolean),
        });
    } catch (error) {
        console.error("[getMyHrDashboardCards]", error);
        return res.status(500).json({ message: "Failed to load dashboard HR cards" });
    }
};
