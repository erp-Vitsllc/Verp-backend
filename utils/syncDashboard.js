import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";

/**
 * Synchronize a request with the DashboardAction collection.
 * This ensures the current person responsible for an action sees it in their dashboard.
 * 
 * @param {Object} data - The action data
 * @param {String} data.requestId - ID of the source request (Loan, Reward, etc)
 * @param {String} data.requestType - Type of request
 * @param {String} data.assignedTo - ObjectId of the employee who needs to action it
 * @param {String} data.status - 'Pending', 'Approved', 'Rejected'
 * @param {Object} data.subjectEmployee - The employee record the request is about
 * @param {String} data.extra1 - Dashboard metadata
 * @param {String} data.extra2 - Dashboard metadata
 */
export const syncDashboardAction = async (data) => {
    try {
        const {
            requestId,
            requestType,
            assignedTo,
            status,
            subjectEmployee,
            extra1,
            extra2,
            extra3,
            actionedBy,
            comment,
            requestedByName,
            /** Profile Activation On Hold: outcome row for the submitter (dashboard / sidebar). */
            profileActivationNotifyAssignee,
            /** Company Activation On Hold: outcome row for the submitter. */
            companyActivationNotifyAssignee,
            /** When true, do not mark assignee Pending rows as completed (used for Profile hold: HR keeps the task open). */
            skipPendingCompletion = false,
        } = data;

        // 1. If status is NOT pending, find and update any existing pending actions for this request
        if (status !== 'Pending') {
            if (!skipPendingCompletion) {
                const query = { requestId: requestId, status: 'Pending' };
                if (requestType) {
                    query.requestType = requestType;
                }
                // NEW: If assignedTo is provided for a non-pending status, only clear THAT person's action.
                // This is critical for parallel workflows (Reward) where one person acting shouldn't clear everyone.
                if (assignedTo) {
                    query.assignedTo = assignedTo;
                }

                await DashboardAction.updateMany(
                    query,
                    {
                        status: status,
                        actionedDate: new Date(),
                        actionedBy: actionedBy,
                        comment: comment
                    }
                );
            }

            // Profile Activation — On Hold only: dashboard / task row for the **submitter** (not the profile subject).
            // Approve / Reject: email only; no outcome row here (callers omit profileActivationNotifyAssignee).
            if (
                requestType === 'Profile Activation' &&
                status === 'On Hold' &&
                subjectEmployee?._id &&
                profileActivationNotifyAssignee?._id
            ) {
                const assignee = profileActivationNotifyAssignee;
                const subj = subjectEmployee;
                const subjectNameDisplay = `${subj.firstName || ''} ${subj.lastName || ''}`.trim() || 'Employee';
                const outcomeExtra1 =
                    extra1 ||
                    '[Employee profile] HR placed your activation on hold — please update the listed items.';
                await DashboardAction.findOneAndUpdate(
                    { requestId, assignedTo: assignee._id, requestType },
                    {
                        assignedTo: assignee._id,
                        assignedToEmpId: assignee.employeeId,
                        requestId,
                        requestType,
                        status: 'On Hold',
                        subjectEmployeeId: subj.employeeId,
                        subjectName: subjectNameDisplay,
                        requestedByName: requestedByName || '',
                        requestedDate: new Date(),
                        extra1: outcomeExtra1,
                        extra2: subj.designation || '',
                        extra3:
                            extra3 ??
                            JSON.stringify({ activationSubject: 'employee', activationViewerRole: 'submitter' }),
                        actionedDate: new Date(),
                        actionedBy: actionedBy || null,
                        comment: comment || '',
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true },
                );
            }

            if (
                requestType === "Company Activation" &&
                status === "On Hold" &&
                subjectEmployee &&
                companyActivationNotifyAssignee?._id
            ) {
                const assignee = companyActivationNotifyAssignee;
                const subj = subjectEmployee;
                const subjectNameDisplay =
                    `${subj.firstName || ""} ${subj.lastName || ""}`.trim() || subj.name || "Company";
                const outcomeExtra1 =
                    extra1 ||
                    "[Company profile] HR placed your activation on hold — please update the listed items.";
                await DashboardAction.findOneAndUpdate(
                    { requestId, assignedTo: assignee._id, requestType },
                    {
                        assignedTo: assignee._id,
                        assignedToEmpId: assignee.employeeId,
                        requestId,
                        requestType: "Company Activation",
                        status: "On Hold",
                        subjectEmployeeId: subj.employeeId || subj.companyId || "",
                        subjectName: subjectNameDisplay,
                        requestedByName: requestedByName || "",
                        requestedDate: new Date(),
                        extra1: outcomeExtra1,
                        extra2: extra2 || "",
                        extra3:
                            extra3 ??
                            JSON.stringify({
                                companyActivationViewerRole: "submitter",
                                activationSubject: "company",
                            }),
                        actionedDate: new Date(),
                        actionedBy: actionedBy || null,
                        comment: comment || "",
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true },
                );
            }

            // If it's fully completed and no next step, we stop here.
            // But usually, an action's completion triggers a NEW pending action for the next person.
            // That would be a separate call to syncDashboardAction with the new 'assignedTo'.
            return;
        }

        // 2. If status IS Pending, we ensure there is a record for the assignedTo user
        if (!assignedTo) return;

        let actualAssignedTo = assignedTo;
        let assignee = await EmployeeBasic.findById(assignedTo).select('employeeId firstName lastName');

        if (!assignee) {
            // It might be a USER ID (from User collection). 
            // We need to resolve it to an Employee ID because DashboardAction.assignedTo refs EmployeeBasic
            const User = (await import("../models/User.js")).default;
            const user = await User.findById(assignedTo).select('employeeId');
            if (user) {
                assignee = await EmployeeBasic.findOne({ employeeId: user.employeeId }).select('employeeId firstName lastName');
                if (assignee) {
                    actualAssignedTo = assignee._id;
                    console.log(`[syncDashboardAction] Resolved UserID ${assignedTo} to EmployeeID ${actualAssignedTo} (${assignee.employeeId})`);
                }
            }
        }

        if (!assignee) {
            console.warn(`[syncDashboardAction] Could not resolve assignedTo ID ${assignedTo} to any Employee record.`);
            return;
        }

        // Upsert the pending action
        const pendingExtra3 =
            extra3 !== undefined && extra3 !== null
                ? String(extra3)
                : requestType === 'Profile Activation'
                    ? JSON.stringify({ activationSubject: 'employee', activationViewerRole: 'hr' })
                    : undefined;

        await DashboardAction.findOneAndUpdate(
            { requestId: requestId, assignedTo: actualAssignedTo, status: 'Pending' },
            {
                assignedToEmpId: assignee.employeeId,
                requestType: requestType,
                status: 'Pending',
                subjectEmployeeId: subjectEmployee?.employeeId,
                subjectName: subjectEmployee ? `${subjectEmployee.firstName} ${subjectEmployee.lastName}` : (data.subjectName || ''),
                requestedByName: requestedByName || '',
                requestedDate: new Date(),
                extra1: extra1,
                extra2: extra2,
                ...(pendingExtra3 ? { extra3: pendingExtra3 } : {})
            },
            { upsert: true, new: true }
        );

    } catch (error) {
        console.error(`[syncDashboardAction] Failed to sync ${data.requestType}:`, error);
    }
};
