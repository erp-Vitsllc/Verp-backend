import mongoose from "mongoose";

/**
 * Removes Company Activation dashboard rows in "On Hold" for a company request (e.g. resubmit after hold).
 */
export async function clearCompanyActivationHoldDashboardRows(companyMongoId) {
    if (!companyMongoId) return;
    const DashboardAction = (await import("../models/DashboardAction.js")).default;
    const requestId = mongoose.Types.ObjectId.isValid(String(companyMongoId))
        ? new mongoose.Types.ObjectId(String(companyMongoId))
        : companyMongoId;
    await DashboardAction.deleteMany({
        requestId,
        requestType: "Company Activation",
        status: "On Hold",
    });
}
