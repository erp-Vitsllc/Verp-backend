import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import TaskManagerTask from "../models/TaskManagerTask.js";
import {
    buildProfileActivationHoldMessage,
    buildProfileActivationRejectedMessage,
} from "./employeeProfileNotificationMessages.js";
import { foldIntoAdminOfficerServiceTrackIfOpen } from "./vehicleServiceAdminOfficerNotification.js";
import { noticeAlreadyDeleted } from "./deletedTaskNotice.js";
import { activityExtra3Lock, pickActivityRow } from "./taskDuplicateKey.js";

function rowMeta(extra3) {
    if (!extra3) return null;
    if (typeof extra3 === "object") return extra3;
    try {
        const parsed = JSON.parse(String(extra3));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

function isAdminTrack(row) {
    return Boolean(rowMeta(row?.extra3)?.adminOfficerServiceTrack);
}

/** Reminders can have several open tasks on one record, one per document or bill. */
function sharesOneTask(requestType) {
    return !/expiry|not renew|card deleted|value missing|asset overdue|profile incomplete|payment reminder|fuel reminder/i.test(
        String(requestType || ""),
    );
}

/** The next approval stays on the task already open for this activity. */
async function followActivityAssignee(actionId, assignee, assigneeId, { reopen = false } = {}) {
    if (!actionId) return;
    const name = `${assignee?.firstName || ""} ${assignee?.lastName || ""}`.trim();
    const set = {
        assignee: assigneeId,
        assigneeEmpId: assignee?.employeeId || "",
        assigneeName: name,
        status: "Pending",
        "closeRequest.originalAssigneeId": null,
        "closeRequest.originalAssigneeEmpId": "",
        "closeRequest.originalAssigneeName": "",
        "closeRequest.reassignmentReleased": false,
        "closeRequest.completionRequestedAt": null,
        "closeRequest.completionConfirmedAt": null,
        "closeRequest.reviewPending": false,
    };
    const filter = {
        sourceDashboardActionId: actionId,
        status: { $nin: ["Cancelled", "Rejected"] },
    };
    if (!reopen) filter.assignee = { $ne: assigneeId };
    await TaskManagerTask.updateMany(filter, { $set: set });
}

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
                // Vehicle service: never wipe the Admin Officer create-track row on mid-stage approve/reject.
                // That row clears on Complete via closeAdminOfficerServiceTrackNotification (billing is Accounts-only).
                if (requestType === 'Vehicle Service Request') {
                    if (extra3) {
                        query.extra3 = String(extra3);
                    } else {
                        query.extra3 = {
                            $not: { $regex: '"adminOfficerServiceTrack"\\s*:\\s*true', $options: 'i' },
                        };
                    }
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

        // 2. If status IS Pending, we ensure there is a record for the assignedTo user.
        // A deleted system or workflow task stays deleted. Do not build the bell again.
        if (await noticeAlreadyDeleted({
            requestType,
            requestId,
            extra1,
            extra3,
            subjectEmployeeId: subjectEmployee?.employeeId,
        })) {
            return;
        }
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

        if (requestType === 'Vehicle Service Request' && status === 'Pending') {
            const folded = await foldIntoAdminOfficerServiceTrackIfOpen({
                requestId,
                assignedTo: actualAssignedTo,
                extra1,
                extra2,
                extra3,
            });
            if (folded) return;
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

        const fineInboxType = requestType === 'Fine' || requestType === 'Group Fine Request';
        if (!sharesOneTask(requestType)) {
            const separateFilter = {
                requestId,
                assignedTo: actualAssignedTo,
                status: 'Pending',
                ...(requestType ? { requestType } : {}),
            };
            const separateLock = activityExtra3Lock(requestType, pendingExtra3);
            if (separateLock) separateFilter.extra3 = separateLock;
            const separateDoc = {
                assignedTo: actualAssignedTo,
                assignedToEmpId: assignee.employeeId,
                requestId,
                requestType,
                status: 'Pending',
                subjectEmployeeId: subjectEmployee?.employeeId,
                subjectName: subjectEmployee
                    ? `${subjectEmployee.firstName || ''} ${subjectEmployee.lastName || ''}`.trim() || data.subjectName || 'Vehicle'
                    : data.subjectName || '',
                requestedByName: requestedByName || '',
                requestedDate: new Date(),
                extra1,
                extra2,
                ...(pendingExtra3 ? { extra3: pendingExtra3 } : {}),
            };
            await DashboardAction.findOneAndUpdate(
                separateFilter,
                { $set: separateDoc },
                { upsert: true, new: true },
            );
            return;
        }

        // One activity keeps one row. The next approval (HR, then Accounts, then payment)
        // updates that row instead of opening a second task.
        // A parallel job stays separate: another service on the same vehicle, the admin
        // create-track, or a disposition / inspection lane stored on extra3.
        const lockedExtra3 = activityExtra3Lock(requestType, pendingExtra3);
        const identity = {
            requestId,
            ...(fineInboxType
                ? { requestType: { $in: ['Fine', 'Group Fine Request'] } }
                : (requestType ? { requestType } : {})),
            ...(lockedExtra3 ? { extra3: lockedExtra3 } : {}),
        };

        const updateDoc = {
            assignedTo: actualAssignedTo,
            assignedToEmpId: assignee.employeeId,
            requestId: requestId,
            requestType: requestType,
            status: 'Pending',
            subjectEmployeeId: subjectEmployee?.employeeId,
            subjectName: subjectEmployee
                ? `${subjectEmployee.firstName || ''} ${subjectEmployee.lastName || ''}`.trim() ||
                  data.subjectName ||
                  'Vehicle'
                : data.subjectName || '',
            requestedByName: requestedByName || '',
            extra1: extra1,
            extra2: extra2,
            ...(pendingExtra3 ? { extra3: pendingExtra3 } : {}),
        };

        const candidates = await DashboardAction.find(identity)
            .select('_id status extra3 assignedTo updatedAt')
            .sort({ updatedAt: -1 })
            .lean();
        const pool = requestType === 'Vehicle Service Request' && !lockedExtra3
            ? candidates.filter((row) => !isAdminTrack(row))
            : candidates;
        const target = pickActivityRow(pool);
        let keptId = target?._id || null;

        if (keptId) {
            const assigneeChanged = String(target.assignedTo || "") !== String(actualAssignedTo);
            const revived = target.status !== "Pending" && target.status !== "On Hold";
            await DashboardAction.findByIdAndUpdate(keptId, { $set: updateDoc });
            if (assigneeChanged || revived) {
                await followActivityAssignee(keptId, assignee, actualAssignedTo, { reopen: true });
            }
        } else {
            const created = await DashboardAction.create({
                ...updateDoc,
                requestedDate: new Date(),
            });
            keptId = created?._id || null;
        }

        await DashboardAction.updateMany(
            {
                ...identity,
                ...(keptId ? { _id: { $ne: keptId } } : {}),
                status: "Pending",
                ...(requestType === "Vehicle Service Request" && !lockedExtra3
                    ? { extra3: { $not: { $regex: '"adminOfficerServiceTrack"\\s*:\\s*true', $options: "i" } } }
                    : {}),
            },
            {
                $set: {
                    status: "Dismissed",
                    actionedDate: new Date(),
                    comment: "Closed: this activity already has one task",
                },
            },
        );

    } catch (error) {
        console.error(`[syncDashboardAction] Failed to sync ${data.requestType}:`, error);
    }
};
