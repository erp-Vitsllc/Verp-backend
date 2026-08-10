import Loan from "../models/Loan.js";
import AssetItem from "../models/AssetItem.js";
import Fine from "../models/Fine.js";
import Flowchart from "../models/Flowchart.js";
import UtilityEntry from "../models/UtilityEntry.js";

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

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function loanRemaining(loan) {
    const amount = money(loan?.amount ?? loan?.loanAmount ?? loan?.totalAmount);
    const paid = money(loan?.paidAmount);
    return Math.max(0, amount - paid);
}

function fineOutstanding(fine) {
    const amount = money(fine?.totalFineAmount || fine?.fineAmount);
    const paid = money(fine?.paidAmount);
    return Math.max(0, amount - paid);
}

/**
 * Clearance checks before an employee can be marked Left User.
 *
 * Required clearances:
 * - No open loan / advance balance
 * - No held AssetItem assignment (vehicle, tools, and other assets)
 * - No utility account assigned to the employee
 * - No flowchart responsibility (Active / Pending)
 * - No fine with an amount still to pay
 *
 * Not a pre-check: portal User login is disabled automatically when Left User is applied.
 * Projects: not implemented (no project-assignment model yet).
 */
export async function getLeftUserEligibilityBlockers(employee) {
    const blockers = [];

    if (employee?.status === "Left User") {
        return blockers;
    }

    const empMongoId = String(employee?._id || "").trim();
    const empCode = String(employee?.employeeId || "").trim();

    const openLoans = await Loan.find({
        employeeId: empCode,
        status: { $in: OPEN_LOAN_STATUSES },
    })
        .select("_id type loanId amount loanAmount totalAmount paidAmount status")
        .lean();

    const blockingLoan = (openLoans || []).find((loan) => {
        const st = String(loan.status || "").trim();
        const remaining = loanRemaining(loan);
        // Still in approval / disbursement workflow.
        if (
            [
                "Pending",
                "Pending HR",
                "Pending Accounts",
                "Pending Authorization",
                "Pending Payment to Employee",
            ].includes(st)
        ) {
            return true;
        }
        // Approved / Paid only block while money is still owed.
        return remaining > 0.01;
    });

    if (blockingLoan) {
        const kind = String(blockingLoan.type || "Loan").toLowerCase() === "advance" ? "advance" : "loan";
        blockers.push({
            code: "ACTIVE_LOAN",
            message: `Employee has an open ${kind} to clear.`,
        });
    }

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
        let assetKind = "assets";
        if (typeName.includes("vehicle")) assetKind = "vehicle asset(s)";
        else if (typeName.includes("tool")) assetKind = "tools asset(s)";
        blockers.push({
            code: "ASSETS",
            message: `Employee has ${assetKind} assigned (vehicle / tools / other assets must be returned).`,
        });
    }

    if (empMongoId || empCode) {
        const utilityAssigned = await UtilityEntry.findOne({
            assignedToType: "Employee",
            $or: [
                ...(empMongoId ? [{ assignedToId: empMongoId }] : []),
                ...(empCode ? [{ assignedToId: empCode }] : []),
            ],
        })
            .select("_id type assignedTo values.accountNumber")
            .lean();

        if (utilityAssigned) {
            blockers.push({
                code: "UTILITY",
                message: "Employee has utility account(s) assigned (SIM / utility must be returned).",
            });
        }
    }

    // Project assignment check is not implemented — no project assignment model in the system yet.

    const flowchartAssignment = await Flowchart.findOne({
        $or: [
            ...(empMongoId ? [{ empObjectId: employee._id }] : []),
            ...(empCode ? [{ employeeId: empCode }] : []),
        ],
        status: { $in: ["Active", "Pending"] },
    })
        .select("category designation")
        .lean();

    if (flowchartAssignment) {
        blockers.push({
            code: "FLOWCHART",
            message: "Employee is assigned on the flowchart (remove flowchart responsibility first).",
        });
    }

    const openFines = await Fine.find({
        "assignedEmployees.employeeId": empCode,
        fineStatus: { $in: OPEN_FINE_STATUSES },
    })
        .select("fineId fineStatus fineAmount totalFineAmount paidAmount")
        .lean();

    const fineToPay = (openFines || []).find((fine) => fineOutstanding(fine) > 0.01);
    if (fineToPay) {
        blockers.push({
            code: "FINES",
            message: "Employee has a fine amount still to pay.",
        });
    }

    return blockers;
}

export async function checkLeftUserEligibility(employee) {
    const blockers = await getLeftUserEligibilityBlockers(employee);
    const alreadyLeftUser = employee?.status === "Left User";

    return {
        eligible: !alreadyLeftUser && blockers.length === 0,
        blockers,
        alreadyLeftUser,
    };
}
