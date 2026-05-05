/**
 * Removes Profile Activation dashboard rows in "On Hold" for an employee request.
 * Call when the employee resubmits after hold (send-approval-email / submit-approval) so the bell list updates.
 */
export async function clearProfileActivationHoldDashboardRows(requestEmployeeMongoId) {
    if (!requestEmployeeMongoId) return;
    const DashboardAction = (await import("../models/DashboardAction.js")).default;
    await DashboardAction.deleteMany({
        requestId: requestEmployeeMongoId,
        requestType: "Profile Activation",
        status: "On Hold",
    });
}
