import Loan from "../models/Loan.js";
import AssetItem from "../models/AssetItem.js";
import Fine from "../models/Fine.js";
import Flowchart from "../models/Flowchart.js";

const ACTIVE_LOAN_STATUSES = [
    "Approved",
    "Paid",
    "Pending",
    "Pending HR",
    "Pending Accounts",
    "Pending Authorization",
];

const HELD_ASSET_STATUSES = ["Assigned", "Pending", "On Leave", "Out of Service", "Service"];

export async function getLeftUserEligibilityBlockers(employee) {
    const blockers = [];

    if (employee?.status === "Left User") {
        return blockers;
    }

    if (String(employee?.profileStatus || "").toLowerCase() !== "active") {
        blockers.push({
            code: "PROFILE_INACTIVE",
            message: "Profile status must be active before marking as Left User.",
        });
    }

    const activeLoan = await Loan.findOne({
        employeeId: employee.employeeId,
        status: { $in: ACTIVE_LOAN_STATUSES },
    })
        .select("_id type loanId")
        .lean();
    if (activeLoan) {
        blockers.push({
            code: "ACTIVE_LOAN",
            message: "User has an active loan or advance.",
        });
    }

    const heldAsset = await AssetItem.findOne({
        assignedTo: employee._id,
        acceptanceStatus: { $in: ["Accepted", "Pending"] },
        status: { $in: HELD_ASSET_STATUSES },
    })
        .select("assetId")
        .lean();
    if (heldAsset) {
        blockers.push({
            code: "ASSETS",
            message: "User has assets.",
        });
    }

    // Project assignment check is not implemented — no project assignment model in the system yet.

    const flowchartAssignment = await Flowchart.findOne({
        $or: [{ empObjectId: employee._id }, { employeeId: employee.employeeId }],
        status: { $in: ["Active", "Pending"] },
    })
        .select("category designation")
        .lean();
    if (flowchartAssignment) {
        blockers.push({
            code: "FLOWCHART",
            message: "User is assigned a flow chart.",
        });
    }

    const fine = await Fine.findOne({
        "assignedEmployees.employeeId": employee.employeeId,
        fineStatus: { $nin: ["Cancelled", "Rejected"] },
    })
        .select("fineId fineStatus")
        .lean();
    if (fine) {
        blockers.push({
            code: "FINES",
            message: "User has a fine.",
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
