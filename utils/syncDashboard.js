import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import {
    buildProfileActivationHoldMessage,
    buildProfileActivationRejectedMessage,
} from "./employeeProfileNotificationMessages.js";

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
            /** Vehicle Profile Activation On Hold: outcome row for the submitter. */
            vehicleProfileActivationNotifyAssignee,
            /** Asset creation rejected: outcome row for the creator (resubmit). */
            assetCreationNotifyAssignee,
            /** Loss & Damage rejected: outcome row for the original requester (resubmit). */
            lossDamageNotifyAssignee,
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
                if (requestType === 'Vehicle Disposition Request' && extra3) {
                    query.extra3 = String(extra3);
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

            // Profile Activation — On Hold / Rejected: dashboard / task row for the **submitter** (not the profile subject).
            // Approve: email only; no outcome row here (callers omit profileActivationNotifyAssignee).
            if (
                requestType === 'Profile Activation' &&
                (status === 'On Hold' || status === 'Rejected') &&
                subjectEmployee?._id &&
                profileActivationNotifyAssignee?._id
            ) {
                const assignee = profileActivationNotifyAssignee;
                const subj = subjectEmployee;
                const subjectNameDisplay = `${subj.firstName || ''} ${subj.lastName || ''}`.trim() || 'Employee';
                const outcomeExtra1 =
                    extra1 ||
                    (status === "On Hold"
                        ? buildProfileActivationHoldMessage({
                              employeeName: subjectNameDisplay,
                              employeeId: subj.employeeId,
                          })
                        : buildProfileActivationRejectedMessage({
                              employeeName: subjectNameDisplay,
                              employeeId: subj.employeeId,
                          }));
                await DashboardAction.findOneAndUpdate(
                    { requestId, assignedTo: assignee._id, requestType },
                    {
                        assignedTo: assignee._id,
                        assignedToEmpId: assignee.employeeId,
                        requestId,
                        requestType,
                        status: status,
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
                (status === "On Hold" || status === "Rejected") &&
                subjectEmployee &&
                companyActivationNotifyAssignee?._id
            ) {
                const assignee = companyActivationNotifyAssignee;
                const subj = subjectEmployee;
                const subjectNameDisplay =
                    `${subj.firstName || ""} ${subj.lastName || ""}`.trim() || subj.name || "Company";
                const outcomeExtra1 =
                    extra1 ||
                    `[Company profile] HR ${status.toLowerCase()} your activation — please review the comments and update the profile.`;
                await DashboardAction.findOneAndUpdate(
                    { requestId, assignedTo: assignee._id, requestType },
                    {
                        assignedTo: assignee._id,
                        assignedToEmpId: assignee.employeeId,
                        requestId,
                        requestType: "Company Activation",
                        status: status,
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

            if (
                requestType === 'Vehicle Profile Activation' &&
                (status === 'On Hold' || status === 'Rejected') &&
                subjectEmployee &&
                vehicleProfileActivationNotifyAssignee?._id
            ) {
                const assignee = vehicleProfileActivationNotifyAssignee;
                const subj = subjectEmployee;
                const subjectNameDisplay = `${subj.firstName || ''} ${subj.lastName || ''}`.trim() || 'Vehicle';
                const outcomeExtra1 =
                    extra1 ||
                    `[Fleet] HR ${status.toLowerCase()} your vehicle activation — please review the comments and update the profile.`;
                await DashboardAction.findOneAndUpdate(
                    { requestId, assignedTo: assignee._id, requestType },
                    {
                        assignedTo: assignee._id,
                        assignedToEmpId: assignee.employeeId,
                        requestId,
                        requestType: 'Vehicle Profile Activation',
                        status: status,
                        subjectEmployeeId: subj.employeeId || '',
                        subjectName: subjectNameDisplay,
                        requestedByName: requestedByName || '',
                        requestedDate: new Date(),
                        extra1: outcomeExtra1,
                        extra2: extra2 || '',
                        extra3:
                            extra3 ??
                            JSON.stringify({
                                activationSubject: 'vehicle',
                                activationViewerRole: 'submitter',
                            }),
                        actionedDate: new Date(),
                        actionedBy: actionedBy || null,
                        comment: comment || '',
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true },
                );
            }

            if (
                requestType === 'Asset Loss Damage' &&
                status === 'Rejected' &&
                lossDamageNotifyAssignee?._id
            ) {
                const assignee = lossDamageNotifyAssignee;
                const subj = subjectEmployee || assignee;
                const subjectNameDisplay =
                    `${subj.firstName || ''} ${subj.lastName || ''}`.trim() || 'Employee';
                const outcomeExtra1 =
                    extra1 ||
                    '[Loss & Damage] Your request was rejected — you may update and submit again.';
                await DashboardAction.findOneAndUpdate(
                    { requestId, assignedTo: assignee._id, requestType: 'Asset Loss Damage' },
                    {
                        assignedTo: assignee._id,
                        assignedToEmpId: assignee.employeeId,
                        requestId,
                        requestType: 'Asset Loss Damage',
                        status: 'Rejected',
                        subjectEmployeeId: subj.employeeId || '',
                        subjectName: subjectNameDisplay,
                        requestedByName: requestedByName || '',
                        requestedDate: new Date(),
                        extra1: outcomeExtra1,
                        extra2: extra2 || '',
                        extra3:
                            extra3 ??
                            JSON.stringify({
                                lossDamageViewerRole: 'requester',
                                outcome: 'reject',
                            }),
                        actionedDate: new Date(),
                        actionedBy: actionedBy || null,
                        comment: comment || '',
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true },
                );
            }

            if (
                requestType === 'Asset Approval' &&
                status === 'Rejected' &&
                subjectEmployee?._id &&
                assetCreationNotifyAssignee?._id
            ) {
                const assignee = assetCreationNotifyAssignee;
                const subj = subjectEmployee;
                const subjectNameDisplay =
                    `${subj.firstName || ''} ${subj.lastName || ''}`.trim() || 'Employee';
                const outcomeExtra1 =
                    extra1 ||
                    '[Asset creation] Your asset was not approved — update the draft and resubmit for Asset Controller review.';
                await DashboardAction.findOneAndUpdate(
                    { requestId, assignedTo: assignee._id, requestType: 'Asset Approval' },
                    {
                        assignedTo: assignee._id,
                        assignedToEmpId: assignee.employeeId,
                        requestId,
                        requestType: 'Asset Approval',
                        status: 'Rejected',
                        subjectEmployeeId: subj.employeeId || '',
                        subjectName: subjectNameDisplay,
                        requestedByName: requestedByName || '',
                        requestedDate: new Date(),
                        extra1: outcomeExtra1,
                        extra2: extra2 || '',
                        extra3:
                            extra3 ??
                            JSON.stringify({
                                assetCreationViewerRole: 'creator',
                                outcome: 'reject'
                            }),
                        actionedDate: new Date(),
                        actionedBy: actionedBy || null,
                        comment: comment || ''
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
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
                    : requestType === 'Vehicle Profile Activation'
                        ? JSON.stringify({ activationSubject: 'vehicle', activationViewerRole: 'flowchart_hr' })
                        : undefined;

        const pendingUpsertFilter = {
            requestId: requestId,
            assignedTo: actualAssignedTo,
            status: 'Pending',
        };
        // Parallel disposition + inspection handover: separate bell rows per viewer role / task type.
        // Oil service: keep Admin Officer track row separate from stage tasks (HR / Accounts / On Service).
        if (
            (requestType === 'Vehicle Disposition Request' || requestType === 'Vehicle Inspection') &&
            pendingExtra3
        ) {
            pendingUpsertFilter.extra3 = pendingExtra3;
        } else if (requestType === 'Vehicle Service Request' && pendingExtra3) {
            try {
                const meta = JSON.parse(String(pendingExtra3));
                if (meta?.adminOfficerServiceTrack || meta?.oilStage || meta?.serviceRecordId) {
                    pendingUpsertFilter.extra3 = pendingExtra3;
                }
            } catch {
                /* keep default filter */
            }
        }

        await DashboardAction.findOneAndUpdate(
            pendingUpsertFilter,
            {
                assignedToEmpId: assignee.employeeId,
                requestType: requestType,
                status: 'Pending',
                subjectEmployeeId: subjectEmployee?.employeeId,
                subjectName: subjectEmployee
                    ? `${subjectEmployee.firstName || ''} ${subjectEmployee.lastName || ''}`.trim() ||
                      data.subjectName ||
                      'Vehicle'
                    : data.subjectName || '',
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
