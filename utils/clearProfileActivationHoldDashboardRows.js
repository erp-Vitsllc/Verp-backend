/**
 * Removes Profile Activation dashboard rows in "On Hold" or "Rejected" for an employee request.
 * Call when the employee resubmits after hold/reject so the submitter bell list updates.
 */
export async function clearProfileActivationHoldDashboardRows(requestEmployeeMongoId) {
    if (!requestEmployeeMongoId) return;
    const DashboardAction = (await import("../models/DashboardAction.js")).default;
    await DashboardAction.deleteMany({
        requestId: requestEmployeeMongoId,
        requestType: "Profile Activation",
        status: { $in: ["On Hold", "Rejected"] },
    });
}
