import mongoose from "mongoose";

/**
 * Removes Company Activation dashboard rows in "On Hold" for a company request (e.g. resubmit after hold).
 */
const resolveCompanyActivationRequestId = (companyMongoId) => {
    if (!companyMongoId) return null;
    return mongoose.Types.ObjectId.isValid(String(companyMongoId))
        ? new mongoose.Types.ObjectId(String(companyMongoId))
        : companyMongoId;
};

export async function clearCompanyActivationHoldDashboardRows(companyMongoId) {
    const requestId = resolveCompanyActivationRequestId(companyMongoId);
    if (!requestId) return;
    const DashboardAction = (await import("../models/DashboardAction.js")).default;
    await DashboardAction.deleteMany({
        requestId,
        requestType: "Company Activation",
        status: "On Hold",
    });
}

/** Removes finished activation notifications (e.g. before resubmit after rejection). */
export async function clearStaleCompanyActivationOutcomeRows(companyMongoId) {
    const requestId = resolveCompanyActivationRequestId(companyMongoId);
    if (!requestId) return;
    const DashboardAction = (await import("../models/DashboardAction.js")).default;
    await DashboardAction.deleteMany({
        requestId,
        requestType: "Company Activation",
        status: { $in: ["Rejected", "Approved"] },
    });
}

/** Removes all company activation dashboard rows once activation is complete. */
export async function clearAllCompanyActivationDashboardRows(companyMongoId) {
    const requestId = resolveCompanyActivationRequestId(companyMongoId);
    if (!requestId) return;
    const DashboardAction = (await import("../models/DashboardAction.js")).default;
    await DashboardAction.deleteMany({
        requestId,
        requestType: "Company Activation",
    });
}
