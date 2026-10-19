import Loan from "../models/Loan.js";
import AssetItem from "../models/AssetItem.js";
import Fine from "../models/Fine.js";
import UtilityEntry from "../models/UtilityEntry.js";
import Reward from "../models/Reward.js";
import EmployeePassport from "../models/EmployeePassport.js";
import EmployeeVisa from "../models/EmployeeVisa.js";
import EmployeeEmiratesId from "../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../models/EmployeeLabourCard.js";
import EmployeeMedicalInsurance from "../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../models/EmployeeDrivingLicense.js";
import SalaryEnrollment from "../models/SalaryEnrollment.js";
import SalaryHistoricalProfile from "../models/SalaryHistoricalProfile.js";
import SalaryMonthPayment from "../models/SalaryMonthPayment.js";
import PayrollSettings from "../models/PayrollSettings.js";
import { getScheduledEmailTimeZone, getZonedParts } from "./scheduleDailyAtMidnight.js";

/** Open / unpaid loan or advance — fully Paid / Rejected / Cancelled / Draft do not block. */
const OPEN_LOAN_STATUSES = [
    "Pending",
    "Pending HR",
    "Pending Accounts",
    "Pending Authorization",
    "Approved",
    "Pending Payment to Employee",
    "Paid", // still block if remaining balance > 0
];

const HELD_ASSET_STATUSES = ["Assigned", "Pending", "On Leave", "Out of Service", "Service"];

/** Fines that may still need payment / clearance (not settled or discarded). */
const OPEN_FINE_STATUSES = [
    "Draft",
    "Pending",
    "Pending HR",
    "Pending Accounts",
    "Pending Authorization",
    "Approved",
    "Active",
];

const PENDING_REWARD_STATUSES = [
    "Pending",
    "Pending HR",
    "Pending Accounts",
    "Pending Authorization",
];

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** Outstanding employee → company balance. Disbursement (`paidAmount`) does not clear it. */
function loanRemaining(loan) {
    const amount = money(loan?.amount ?? loan?.loanAmount ?? loan?.totalAmount);
    const repaid = money(loan?.repaidAmount);
    return Math.max(0, amount - repaid);
}

function fineOutstanding(fine) {
    const amount = money(fine?.totalFineAmount || fine?.fineAmount);
    const paid = money(fine?.paidAmount);
    return Math.max(0, amount - paid);
}

function pad2(value) {
    return String(value).padStart(2, "0");
}

function codeKey(value) {
    return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

function zonedDateKey(value, timeZone = getScheduledEmailTimeZone()) {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = getZonedParts(date, timeZone);
    if (!parts.year || !parts.month || !parts.day) return "";
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function currentYearMonth(timeZone = getScheduledEmailTimeZone()) {
    const parts = getZonedParts(new Date(), timeZone);
    return `${parts.year}-${pad2(parts.month)}`;
}

function shiftYearMonth(ym, delta) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(ym || ""));
    if (!match) return "";
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + delta, 1));
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

function monthLabel(ym) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(ym || ""));
    if (!match) return String(ym || "");
    return `${MONTH_SHORT[Number(match[2]) - 1] || match[2]} ${match[1]}`;
}

function yearMonthValue(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{4}-\d{2})/);
    if (match) return match[1];
    const key = zonedDateKey(value);
    return key ? key.slice(0, 7) : "";
}

function checkRow(code, label, passed, message = "", manual = false) {
    return {
        code,
        label,
        manual,
        passed: Boolean(passed),
        message: passed ? "" : String(message || "").trim(),
    };
}

async function moneyClearance(employee) {
    const empCode = String(employee?.employeeId || "").trim();
    const messages = [];

    const openLoans = empCode
        ? await Loan.find({
            employeeId: empCode,
            status: { $in: OPEN_LOAN_STATUSES },
        })
            .select("_id type loanId amount loanAmount totalAmount paidAmount repaidAmount status")
            .lean()
        : [];

    const blockingLoan = (openLoans || []).find((loan) => {
        const status = String(loan.status || "").trim();
        if (
            [
                "Pending",
                "Pending HR",
                "Pending Accounts",
                "Pending Authorization",
                "Pending Payment to Employee",
            ].includes(status)
        ) {
            return true;
        }
        return loanRemaining(loan) > 0.01;
    });

    if (blockingLoan) {
        const kind = String(blockingLoan.type || "Loan").toLowerCase() === "advance" ? "advance" : "loan";
        messages.push(`Employee has an open ${kind} to clear.`);
    }

    const openFines = empCode
        ? await Fine.find({
            "assignedEmployees.employeeId": empCode,
            fineStatus: { $in: OPEN_FINE_STATUSES },
        })
            .select("fineId fineStatus fineAmount totalFineAmount paidAmount")
            .lean()
        : [];

    if ((openFines || []).some((fine) => fineOutstanding(fine) > 0.01)) {
        messages.push("Employee has a fine amount still to pay.");
    }

    return checkRow(
        "MONEY",
        "Employee has no unpaid loan, advance, or fine",
        messages.length === 0,
        messages.join(" "),
    );
}

async function rewardClearance(employee) {
    const empCode = String(employee?.employeeId || "").trim();
    const pendingReward = empCode
        ? await Reward.findOne({
            employeeId: empCode,
            rewardStatus: { $in: PENDING_REWARD_STATUSES },
        })
            .select("rewardId rewardStatus")
            .lean()
        : null;

    return checkRow(
        "REWARD",
        "Employee reward is not pending",
        !pendingReward,
        pendingReward
            ? `Employee has a reward still pending (${pendingReward.rewardStatus || "Pending"}).`
            : "",
    );
}

async function assetClearance(employee) {
    const empMongoId = String(employee?._id || "").trim();
    const empCode = String(employee?.employeeId || "").trim();
    const messages = [];

    if (employee?._id) {
        const heldAsset = await AssetItem.findOne({
            assignedTo: employee._id,
            acceptanceStatus: { $in: ["Accepted", "Pending"] },
            status: { $in: HELD_ASSET_STATUSES },
        })
            .select("assetId plateNumber name")
            .populate("typeId", "name")
            .lean();

        if (heldAsset) {
            const typeName = String(heldAsset?.typeId?.name || "").toLowerCase();
            let assetKind = "asset(s)";
            if (typeName.includes("vehicle")) assetKind = "vehicle";
            else if (typeName.includes("tool")) assetKind = "tools";
            messages.push(`Employee still has ${assetKind} assigned. Return them before leaving.`);
        }
    }

    if (empMongoId || empCode) {
        const utilityAssigned = await UtilityEntry.findOne({
            assignedToType: "Employee",
            $or: [
                ...(empMongoId ? [{ assignedToId: empMongoId }] : []),
                ...(empCode ? [{ assignedToId: empCode }] : []),
            ],
        })
            .select("_id type")
            .lean();

        if (utilityAssigned) {
            messages.push("Employee still has a utility account assigned (SIM / utility must be returned).");
        }
    }

    return checkRow(
        "ASSETS",
        "Employee has no asset assigned (tools, vehicle, or utilities)",
        messages.length === 0,
        messages.join(" "),
    );
}

async function salaryClearance(employee) {
    const empCode = String(employee?.employeeId || "").trim();
    const key = codeKey(empCode);
    const label = "Employee salary until the current month is processed";
    if (!key) return checkRow("SALARY", label, true);

    const [enrollment, lockedProfile, payroll] = await Promise.all([
        SalaryEnrollment.findOne({ employeeId: empCode }).select("fromMonth").lean(),
        SalaryHistoricalProfile.findOne({ employeeId: empCode, workflowStatus: "locked" })
            .select("verpStartDate")
            .lean(),
        PayrollSettings.findOne({ key: "default" }).select("hiddenSalaryMonths").lean(),
    ]);

    const fromMonth = /^\d{4}-\d{2}$/.test(String(enrollment?.fromMonth || ""))
        ? String(enrollment.fromMonth)
        : yearMonthValue(lockedProfile?.verpStartDate);
    const currentYm = currentYearMonth();

    // Not on payroll, or the first salary month is not open yet.
    if (!/^\d{4}-\d{2}$/.test(fromMonth) || fromMonth >= currentYm) {
        return checkRow("SALARY", label, true);
    }

    const hidden = new Set(
        (payroll?.hiddenSalaryMonths || []).map((ym) => String(ym || "").trim()).filter(Boolean),
    );
    const payments = await SalaryMonthPayment.find({
        monthKey: { $gte: fromMonth, $lt: currentYm },
    })
        .select("monthKey employeeIds")
        .lean();

    const paid = new Set();
    for (const row of payments || []) {
        const month = String(row.monthKey || "").trim();
        const included = (row.employeeIds || []).some((id) => codeKey(id) === key);
        if (month && included) paid.add(month);
    }

    const missing = [];
    let cursor = fromMonth;
    let guard = 0;
    while (cursor && cursor < currentYm && guard < 240) {
        if (!hidden.has(cursor) && !paid.has(cursor)) missing.push(cursor);
        cursor = shiftYearMonth(cursor, 1);
        guard += 1;
    }

    if (!missing.length) return checkRow("SALARY", label, true);

    const shown = missing.slice(0, 6).map(monthLabel).join(", ");
    const more = missing.length > 6 ? ` and ${missing.length - 6} more` : "";
    return checkRow(
        "SALARY",
        label,
        false,
        `Salary is not processed for ${shown}${more}.`,
    );
}

function pushExpired(labels, name, expiry, todayKey) {
    const key = zonedDateKey(expiry);
    if (!key || !todayKey || key >= todayKey) return;
    const label = String(name || "Document").trim() || "Document";
    if (!labels.includes(label)) labels.push(label);
}

async function documentClearance(employee) {
    const empCode = String(employee?.employeeId || "").trim();
    const todayKey = zonedDateKey(new Date());
    const labels = [];

    for (const doc of employee?.documents || []) {
        pushExpired(labels, doc?.documentName || doc?.type || "Document", doc?.expiryDate, todayKey);
    }
    pushExpired(labels, "Contract", employee?.contractExpiryDate, todayKey);

    if (empCode) {
        const [passport, visa, emiratesId, labourCard, medical, license] = await Promise.all([
            EmployeePassport.findOne({ employeeId: empCode }).select("expiryDate").lean(),
            EmployeeVisa.findOne({ employeeId: empCode }).select("visit employment spouse").lean(),
            EmployeeEmiratesId.findOne({ employeeId: empCode }).select("emiratesId.expiryDate").lean(),
            EmployeeLabourCard.findOne({ employeeId: empCode }).select("labourCard.expiryDate").lean(),
            EmployeeMedicalInsurance.findOne({ employeeId: empCode }).select("medicalInsurance.expiryDate").lean(),
            EmployeeDrivingLicense.findOne({ employeeId: empCode }).select("drivingLicenceDetails.expiryDate").lean(),
        ]);

        pushExpired(labels, "Passport", passport?.expiryDate, todayKey);
        pushExpired(labels, "Visit Visa", visa?.visit?.expiryDate, todayKey);
        pushExpired(labels, "Employment Visa", visa?.employment?.expiryDate, todayKey);
        pushExpired(labels, "Spouse Visa", visa?.spouse?.expiryDate, todayKey);
        pushExpired(labels, "Emirates ID", emiratesId?.emiratesId?.expiryDate, todayKey);
        pushExpired(labels, "Labour Card", labourCard?.labourCard?.expiryDate, todayKey);
        pushExpired(labels, "Medical Insurance", medical?.medicalInsurance?.expiryDate, todayKey);
        pushExpired(labels, "Driving License", license?.drivingLicenceDetails?.expiryDate, todayKey);
    }

    const shown = labels.slice(0, 6).join(", ");
    const more = labels.length > 6 ? ` and ${labels.length - 6} more` : "";
    return checkRow(
        "DOCUMENTS",
        "Employee expired documents are all marked not renewed",
        labels.length === 0,
        labels.length
            ? `Expired and not marked Not Renewed: ${shown}${more}.`
            : "",
    );
}

/**
 * Clearance shown on the Left User checklist.
 * System rows must pass. Gratuity is confirmed manually on the checklist.
 */
export async function buildLeftUserClearance(employee) {
    const alreadyLeftUser = employee?.status === "Left User";
    if (alreadyLeftUser) {
        return {
            alreadyLeftUser: true,
            eligible: false,
            blockers: [],
            checks: [],
        };
    }

    const [moneyCheck, rewardCheck, assetCheck, salaryCheck, documentCheck] = await Promise.all([
        moneyClearance(employee),
        rewardClearance(employee),
        assetClearance(employee),
        salaryClearance(employee),
        documentClearance(employee),
    ]);

    const checks = [
        moneyCheck,
        rewardCheck,
        assetCheck,
        salaryCheck,
        checkRow(
            "GRATUITY",
            "Employee gratuity is paid",
            false,
            "Tick this after gratuity is paid. This is confirmed manually.",
            true,
        ),
        documentCheck,
    ];

    const blockers = checks
        .filter((row) => !row.manual && !row.passed)
        .map((row) => ({
            code: row.code,
            message: row.message || row.label,
        }));

    return {
        alreadyLeftUser: false,
        eligible: blockers.length === 0,
        blockers,
        checks,
    };
}

export async function getLeftUserEligibilityBlockers(employee) {
    const result = await buildLeftUserClearance(employee);
    return result.blockers;
}

export async function checkLeftUserEligibility(employee) {
    return buildLeftUserClearance(employee);
}
