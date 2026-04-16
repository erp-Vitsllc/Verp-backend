import EmployeeBasic from "../models/EmployeeBasic.js";

/**
 * After an active profile is edited, mark it inactive and return approval status to draft.
 * No auto-submission to HR; submission is manual via "Submit for Approval".
 */
export const triggerProfileReactivationIfNeeded = async ({
    employeeId,
    actor = null,
    reason = "Profile data edited",
}) => {
    if (!employeeId) return { triggered: false };

    const employee = await EmployeeBasic.findOne({ employeeId })
        .select("_id employeeId firstName lastName designation company profileStatus profileApprovalStatus")
        .lean();
    if (!employee) return { triggered: false };

    // Applies only after profile/company activation.
    if (!employee.company || employee.profileStatus !== "active") {
        return { triggered: false };
    }

    await EmployeeBasic.updateOne(
        { employeeId },
        {
            $set: {
                profileStatus: "inactive",
                profileApprovalStatus: "draft",
                profileSubmittedTo: null,
            },
        }
    );

    return { triggered: true };
};
