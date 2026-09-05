import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { dispatchFineApprovedNotification } from "../../utils/dispatchFineApprovedNotification.js";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { sendHODAuthorizationEmail } from "../../utils/sendHODAuthorizationEmail.js";
import { isValidStorageUrl } from "../../utils/validationHelper.js";
import { canUserActOnFineStageAsync } from "../../utils/fineStageAuth.js";
import { runAfterResponse } from "../../utils/runAfterResponse.js";
import {
    openAccountsPaymentInbox,
    emailAccountsPaymentRequest,
    resolveFineManagementActor,
    resolveFineAccountsActor,
} from "../../utils/fineAccountsPaymentFlow.js";

/**
 * Approve Fine - Sequential Workflow
 * New Sequence: HR -> Accounts -> Management -> Approved
 * (Reportee/Manager step removed — fines go directly to HR on creation)
 */
export const approveFine = async (req, res) => {
    let { id } = req.params;

    // Sanitize ID
    if (id && typeof id === 'string' && id.includes(':')) {
        id = id.split(':')[0].trim();
    }

    try {
        // 1. Fetch All Related Fines (Support Group Approval)
        const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);
        let fines = [];

        if (isValidObjectId) {
            const targetFine = await Fine.findById(id);
            if (targetFine) {
                // If it's a specific record, find all siblings sharing the same base ID
                const baseId = targetFine.fineId.split('-').length > 3
                    ? targetFine.fineId.split('-').slice(0, 3).join('-')
                    : targetFine.fineId;
                const baseIdRegex = new RegExp(`^${baseId}(-[A-Z0-9]+)?$`, 'i');
                fines = await Fine.find({ fineId: baseIdRegex }).populate('createdBy', 'name');
            }
        }

        if (fines.length === 0) {
            // Try searching by fineId as a base
            const baseId = id.split('-').length > 3 ? id.split('-').slice(0, 3).join('-') : id;
            const baseIdRegex = new RegExp(`^${baseId}(-[A-Z0-9]+)?$`, 'i');
            fines = await Fine.find({ fineId: baseIdRegex }).populate('createdBy', 'name');
        }

        if (fines.length === 0) {
            return res.status(404).json({ message: "Fine(s) not found" });
        }

        // Use the first one for status/permission checks (assuming all siblings share status)
        const fine = fines[0];

        // 2. Identify Logged-In User
        let userBasic = null;
        if (req.user.employeeId) {
            userBasic = await EmployeeBasic.findOne({ employeeId: req.user.employeeId });
        } else if (req.user.companyEmail) {
            userBasic = await EmployeeBasic.findOne({ companyEmail: req.user.companyEmail });
        } else if (req.user.email) {
            userBasic = await EmployeeBasic.findOne({
                $or: [{ companyEmail: req.user.email }, { email: req.user.email }, { workEmail: req.user.email }]
            });
        }

        const isAdmin = req.user.isAdmin === true;
        if (!userBasic && !isAdmin) {
            return res.status(403).json({ message: "User not recognized as an employee." });
        }

        // 3. Stage-based authorization uses workflow assignee (see fineStageAuth.js)
        const currentStatus = fine.fineStatus;
        const canActOnFine = async () =>
            canUserActOnFineStageAsync({
                user: req.user,
                fine,
                isAdmin,
                employeeObjectId: userBasic?._id,
            });
        let modified = false;

        console.log("ApproveFine:", { fineId: fine.fineId, status: currentStatus, userId: req.user._id });

        // --- STAGE 1: HR (Pending HR -> Pending Authorization / Management) ---
        const isHRStage = currentStatus === 'Pending HR' || currentStatus === 'Pending Review' ||
            (currentStatus === 'Pending' && (!fine.workflow || fine.workflow.length === 0 || fine.workflow.some(w => w.status === 'Pending' && w.role === 'HR')));

        if (isHRStage) {
            if (await canActOnFine()) {
                fine.fineStatus = 'Pending Authorization';
                fine.hrApprovedBy = req.user._id;
                modified = true;

                const { managementHOD, mgmtUser } = await resolveFineManagementActor(fine);
                let nextApproverFound = false;

                const hrEntry = fine.workflow?.find(w =>
                    w.status === 'Pending' &&
                    (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'HR')
                );
                if (hrEntry) { hrEntry.status = 'Approved'; hrEntry.actionedAt = new Date(); }
                else {
                    if (!fine.workflow) fine.workflow = [];
                    fine.workflow.push({ role: 'HR', assignedTo: req.user._id, status: 'Approved', assignedAt: new Date(), actionedAt: new Date() });
                }

                if (mgmtUser) {
                    fine.submittedTo = mgmtUser._id;
                    nextApproverFound = true;
                    const nextStepExists = fine.workflow.some(w =>
                        (w.role === 'Management' || w.role === 'CEO') && w.status === 'Pending'
                    );
                    if (!nextStepExists) {
                        fine.workflow.push({
                            role: 'Management',
                            assignedTo: mgmtUser._id,
                            status: 'Pending',
                            assignedAt: new Date(),
                        });
                    }
                } else {
                    console.warn(`[Fine ${fine.fineId}] Management Approver NOT FOUND after HR. Releasing submittedTo.`);
                    fine.submittedTo = null;
                }

                for (const f of fines) {
                    f.fineStatus = 'Pending Authorization';
                    f.hrApprovedBy = req.user._id;
                    f.submittedTo = fine.submittedTo;
                    f.workflow = fine.workflow;
                    await f.save();
                }

                console.log(`[Fine ${fine.fineId}] HR Approved. Next Management: ${nextApproverFound}`);
                if (managementHOD) {
                    const fineSnapshot = fine.toObject?.() ? fine.toObject() : { ...fine };
                    runAfterResponse('approveFine-hr-email', () =>
                        sendHODAuthorizationEmail('Fine', fineSnapshot, managementHOD, {
                            name: req.user.name || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'HR',
                            designation: 'HR',
                        }),
                    );
                }
            } else {
                return res.status(403).json({ message: "Only the assigned HR approver can approve at this stage." });
            }
        }
        // --- STAGE 2: Accounts (Pending Accounts -> Pending Authorization) ---
        else if (currentStatus === 'Pending Accounts' || currentStatus === 'Pending Finance' ||
            (currentStatus === 'Pending' && fine.workflow?.some(w => w.status === 'Pending' && w.role === 'Accounts'))) {
            if (await canActOnFine()) {
                // Persist any party payables sent with the approve request
                const partyPayables = Array.isArray(req.body?.partyPayables) ? req.body.partyPayables : [];
                if (partyPayables.length > 0) {
                    for (const party of partyPayables) {
                        if (!party) continue;
                        const match = fines.find(
                            (f) =>
                                (party.fineRecordId && String(f._id) === String(party.fineRecordId)) ||
                                (party.fineId && String(f.fineId) === String(party.fineId)),
                        );
                        if (!match) continue;
                        if (party.expenseAccountId !== undefined) {
                            match.expenseAccountId = String(party.expenseAccountId || '').trim();
                        }
                        if (party.expenseAccountName !== undefined) {
                            match.expenseAccountName = String(party.expenseAccountName || '').trim();
                        }
                        if (party.payableConfirmed !== undefined) {
                            match.payableConfirmed = Boolean(party.payableConfirmed);
                        } else if (match.expenseAccountId) {
                            match.payableConfirmed = true;
                        }
                    }
                }

                // Every liable party must have Payable (Chart of Accounts) filled
                const incomplete = fines.filter((f) => !String(f.expenseAccountId || '').trim());
                if (incomplete.length > 0) {
                    const labels = incomplete.map((f) => {
                        const party = f.assignedEmployees?.[0];
                        return party?.employeeName || f.companyName || f.fineId;
                    });
                    return res.status(400).json({
                        message:
                            `Accounts cannot approve until every party Payable is filled. Incomplete: ${labels.join(', ')}.`,
                        missingPayables: labels,
                    });
                }

                const realEmp = fine.assignedEmployees?.find(e => e.employeeId && e.employeeId !== 'VEGA-HR-0000');
                const applicantId = realEmp?.employeeId || fine.assignedEmployees?.[0]?.employeeId;

                const managementHOD = await import("../../utils/getManagementHOD.js")
                    .then(m => m.getManagementHOD(applicantId));
                let nextApproverFound = false;

                if (managementHOD) {
                    const mgmtUser = await import("../../models/User.js")
                        .then(m => m.default.findOne({ employeeId: managementHOD.employeeId }));
                    if (mgmtUser) {
                        fine.submittedTo = mgmtUser._id;
                        nextApproverFound = true;

                        const accEntry = fine.workflow?.find(w =>
                            w.status === 'Pending' &&
                            (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'Accounts')
                        );
                        if (accEntry) { accEntry.status = 'Approved'; accEntry.actionedAt = new Date(); }
                        else { fine.workflow.push({ role: 'Accounts', assignedTo: req.user._id, status: 'Approved', assignedAt: new Date(), actionedAt: new Date() }); }

                        const nextStepExists = fine.workflow.some(w => (w.role === 'Management' || w.role === 'CEO') && w.status === 'Pending');
                        if (!nextStepExists) {
                            fine.workflow.push({ role: 'Management', assignedTo: mgmtUser._id, status: 'Pending', assignedAt: new Date() });
                        }
                    }
                }

                if (!nextApproverFound) {
                    console.warn(`[Fine ${fine.fineId}] Management Approver NOT FOUND. Releasing submittedTo.`);
                    fine.submittedTo = null;
                    const accEntry = fine.workflow?.find(w =>
                        w.status === 'Pending' &&
                        (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'Accounts')
                    );
                    if (accEntry) { accEntry.status = 'Approved'; accEntry.actionedAt = new Date(); }
                }

                for (const f of fines) {
                    f.fineStatus = 'Pending Authorization';
                    f.accountsApprovedBy = req.user._id;
                    f.submittedTo = fine.submittedTo;
                    f.workflow = fine.workflow;
                    // Keep a group-level default account from the first party for legacy single-line sync
                    if (!f.expenseAccountId && fines[0]?.expenseAccountId) {
                        f.expenseAccountId = fines[0].expenseAccountId;
                        f.expenseAccountName = fines[0].expenseAccountName || '';
                    }
                    await f.save();
                }

                console.log(`[Fine ${fine.fineId}] Finance Approved. Management:`, managementHOD ? `${managementHOD.firstName} ${managementHOD.lastName}` : 'NOT FOUND');
                const fineSnapshot = fine.toObject?.() ? fine.toObject() : { ...fine };
                runAfterResponse('approveFine-accounts-email', () =>
                    sendHODAuthorizationEmail('Fine', fineSnapshot, managementHOD, {
                        name: 'Accounts Department',
                        designation: 'Finance',
                    }),
                );
            } else {
                return res.status(403).json({ message: "Only the assigned Accounts approver can approve at this stage." });
            }
        }
        // --- STAGE 3: Management (Pending Authorization -> Approved) ---
        else if (currentStatus === 'Pending Authorization' || currentStatus === 'Pending Management' ||
            (currentStatus === 'Pending' && fine.workflow?.some(w => w.status === 'Pending' && (w.role === 'Management' || w.role === 'CEO')))) {
            if (await canActOnFine()) {
                // Update ALL siblings — no Zoho at Management. Accounts settles payment next.
                for (const f of fines) {
                    const { snapshotDeductionScheduleOnApproval } = await import('../../utils/fineDeductionScheduleSnapshot.js');
                    const { syncFinePartyPayableAmounts } = await import('../../utils/finePayableAmount.js');
                    snapshotDeductionScheduleOnApproval(f);
                    syncFinePartyPayableAmounts(f);

                    f.fineStatus = 'Approved';
                    f.approvedBy = req.user._id;
                    f.approvedDate = new Date();

                    f.assignedEmployees.forEach(e => {
                        e.approvalStatus = 'Approved';
                        e.approvedAt = new Date();
                        e.approvedBy = req.user._id;
                    });

                    // Update Workflow
                    const mgmtEntry = f.workflow?.find(w =>
                        w.status === 'Pending' &&
                        (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'Management' || w.role === 'CEO')
                    );
                    if (mgmtEntry) { mgmtEntry.status = 'Approved'; mgmtEntry.actionedAt = new Date(); }
                    else { if (!f.workflow) f.workflow = []; f.workflow.push({ role: 'Management', assignedTo: req.user._id, status: 'Approved', assignedAt: new Date(), actionedAt: new Date() }); }

                    await f.save();
                }

                modified = true;
                Object.assign(fine, fines[0].toObject?.() ? fines[0].toObject() : fines[0]);

                // PDF + employee email (CC HOD, HR) + Accounts payment request — no Zoho here.
                const fineIdsForNotify = fines.map((f) => f._id);
                const primaryFineId = fines[0]._id;
                const reqSnapshot = req;
                runAfterResponse('approveFine-pdf-email-accounts', async () => {
                    const freshFines = await Fine.find({ _id: { $in: fineIdsForNotify } });
                    if (!freshFines.length) return;
                    const primary =
                        freshFines.find((f) => String(f._id) === String(primaryFineId)) || freshFines[0];

                    const allAssignedEmployees = freshFines.flatMap((f) => f.assignedEmployees);
                    const { persistFineApprovalAttachments } = await import(
                        '../../utils/persistFineApprovalAttachments.js'
                    );
                    await persistFineApprovalAttachments(primary, { req: reqSnapshot });
                    await dispatchFineApprovedNotification(primary, allAssignedEmployees, reqSnapshot, {
                        ccOnlyHodAndHr: true,
                    });

                    const { accountsHOD } = await resolveFineAccountsActor(primary);
                    await emailAccountsPaymentRequest(primary, accountsHOD);
                });

                // Update Asset Status if Loss & Damage — only for the main asset case.
                // Accessory L&D fines store accessoryId / accessoryName; parent asset must stay unchanged
                // (accessory already marked Lost when AC approved; catalog sync handles the instance).
                const isAccessoryContextFine =
                    !!(fine.accessoryId && String(fine.accessoryId).trim()) ||
                    !!(fine.accessoryName && String(fine.accessoryName).trim());

                if (
                    !isAccessoryContextFine &&
                    fine.assetId &&
                    (fine.fineType === 'Loss & Damage' || fine.category === 'Damage')
                ) {
                    const AssetItem = (await import("../../models/AssetItem.js")).default;
                    const asset = await AssetItem.findOne({ assetId: fine.assetId });

                    if (asset) {
                        const ownerBeforeLost = asset.assignedTo
                            ? await EmployeeBasic.findById(asset.assignedTo)
                                .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
                                .populate('primaryReportee', 'firstName lastName companyEmail workEmail')
                                .lean()
                            : null;

                        const ftRaw = String(fine.fineType || '');
                        const ft = ftRaw.toLowerCase();
                        const isLossDamageFine =
                            fine.category === 'Loss' ||
                            ftRaw === 'Loss' ||
                            ft.includes('loss & damage') ||
                            ft.includes('loss and damage') ||
                            fine.description?.toLowerCase().includes('loss');
                        const newStatus = isLossDamageFine ? 'Lost' : 'Out of Service';

                        asset.status = newStatus;
                        asset.assignedTo = null;
                        asset.assignedDate = null;
                        asset.assignedBy = null;
                        asset.acceptanceStatus = 'Pending';
                        await asset.save();
                        console.log(`[ApproveFine] Main Asset ${fine.assetId} updated to ${newStatus}`);
                        try {
                            const AssetHistory = (await import("../../models/AssetHistory.js")).default;
                            await AssetHistory.create({
                                assetId: asset._id,
                                action: 'Returned',
                                assignedTo: null,
                                performedBy: req.user.employeeId
                                    ? (await EmployeeBasic.findOne({ employeeId: req.user.employeeId }))?._id
                                    : null,
                                comments: `Asset ${newStatus} due to approved Fine (${fine.fineId}). ${fine.description}`,
                                date: new Date()
                            });
                        } catch (historyErr) {
                            console.error("[ApproveFine] Asset History failed:", historyErr);
                        }

                        if (isLossDamageFine && ownerBeforeLost) {
                            const assetMailPayload = {
                                asset: { _id: asset._id, assetId: asset.assetId, name: asset.name },
                                fine: fine.toObject?.() ? fine.toObject() : fine,
                                owner: ownerBeforeLost,
                            };
                            runAfterResponse('approveFine-asset-lost-email', async () => {
                                const { sendAssetLostFromFineEmail } = await import(
                                    '../../utils/sendAssetLostFromFineEmail.js'
                                );
                                await sendAssetLostFromFineEmail(assetMailPayload);
                            });
                        }
                    }
                }
            } else {
                return res.status(403).json({ message: "Only the assigned Management approver can approve at this stage." });
            }
        } else {
            return res.status(400).json({ message: `No actionable status found for fine (status: ${currentStatus}).` });
        }

        // === SYNC DASHBOARD ACTION ===
        try {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            const targetEmpId = fine.assignedEmployees?.[0]?.employeeId || null;
            const subjectEmp = targetEmpId ? await EmployeeBasic.findOne({ employeeId: targetEmpId }) : null;
            
            const isGroup = fines.length > 1;
            const reqType = isGroup ? 'Group Fine Request' : 'Fine';
            const subjectName = isGroup ? `Group Fine - ${fines.length} Employees` : undefined;

            const isFinalStatus = fine.fineStatus === 'Approved' || fine.fineStatus === 'Rejected';
            // Clear current stage Pending immediately (HR/Accounts), not only on final Management.
            await syncDashboardAction({
                requestId: fine._id,
                requestType: reqType,
                assignedTo: null,
                status: isFinalStatus ? fine.fineStatus : 'Approved',
                subjectEmployee: subjectEmp,
                subjectName: subjectName,
                requestedByName: fine.createdBy?.name || ''
            });

            const nextPendingStep = fine.workflow?.find(w => w.status === 'Pending');
            if (nextPendingStep) {
                await syncDashboardAction({
                    requestId: fine._id,
                    requestType: reqType,
                    assignedTo: nextPendingStep.assignedTo,
                    status: 'Pending',
                    subjectEmployee: subjectEmp,
                    subjectName: subjectName,
                    requestedByName: fine.createdBy?.name || '',
                    extra1: fine.fineType,
                    extra2: `Total: AED ${fines.reduce((sum, f) => sum + (f.fineAmount || 0), 0)}` // total for group
                });
            } else if (fine.fineStatus === 'Approved') {
                await openAccountsPaymentInbox(fine, fines);
            }
        } catch (syncErr) {
            console.error("[ApproveFine] Dashboard Sync Error:", syncErr);
        }

        if (modified && fine.fineStatus !== 'Approved') {
            await fine.save();
        }

        try {
            await fine.populate([
                { path: 'createdBy', select: 'name firstName lastName' },
                { path: 'hrApprovedBy', select: 'name firstName lastName employeeId' },
                { path: 'accountsApprovedBy', select: 'name firstName lastName employeeId' },
                { path: 'approvedBy', select: 'name firstName lastName employeeId' },
                { path: 'submittedTo', select: 'name firstName lastName employeeId' },
                { path: 'workflow.assignedTo', select: 'name firstName lastName employeeId' },
            ]);
        } catch (popErr) {
            console.warn('[ApproveFine] Populate names for response failed:', popErr?.message || popErr);
        }

        return res.status(200).json({
            message: "Fine approved successfully.",
            fine
        });
    } catch (error) {
        console.error("Error approving fine:", error);
        return res.status(500).json({ message: error.message || "Failed to approve fine" });
    }
};
