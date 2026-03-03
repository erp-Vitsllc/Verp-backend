import Fine from "../../models/Fine.js";
import { sendFineRejectedEmail } from "../../utils/sendFineRejectedEmail.js";
import { isValidStorageUrl } from "../../utils/validationHelper.js";

import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { sendFineApprovalEmail } from "../../utils/sendFineApprovalEmail.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { getManagementHOD } from "../../utils/getManagementHOD.js";

export const updateFine = async (req, res) => {
    try {
        let { id } = req.params;
        const updates = req.body;

        // Security check for attachment URL to prevent SSRF (Early exit)
        if (updates.attachment && updates.attachment.url) {
            if (!isValidStorageUrl(updates.attachment.url)) {
                return res.status(400).json({ message: "Invalid or unauthorized attachment URL provided." });
            }
        }

        // Sanitize ID (remove artifacts like ":1")
        if (id && typeof id === 'string' && id.includes(':')) {
            id = id.split(':')[0].trim();
        }

        // ... (rest of lookup logic)
        // 1. Fetch Related Fines (Support Group Updates)
        const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);
        let fines = [];

        if (isValidObjectId) {
            const targetFine = await Fine.findById(id);
            if (targetFine) {
                const baseId = targetFine.fineId.split('-').length > 3
                    ? targetFine.fineId.split('-').slice(0, 3).join('-')
                    : targetFine.fineId;
                const baseIdRegex = new RegExp(`^${baseId}(-[A-Z0-9]+)?$`, 'i');
                fines = await Fine.find({ fineId: baseIdRegex });
            }
        }

        if (fines.length === 0) {
            const baseId = id.split('-').length > 3 ? id.split('-').slice(0, 3).join('-') : id;
            const baseIdRegex = new RegExp(`^${baseId}(-[A-Z0-9]+)?$`, 'i');
            fines = await Fine.find({ fineId: baseIdRegex });
        }

        if (fines.length === 0) {
            return res.status(404).json({ message: "Fine(s) not found" });
        }

        const fine = fines[0]; // Primary reference for logic

        const oldStatus = fine.fineStatus;
        let shouldSendApprovalEmail = false;

        // 1. Explicitly Define Allowed Fields (Fix Mass Assignment)
        const allowedUpdates = [
            'fineStatus', 'description', 'awardedDate', 'remarks',
            'attachment', 'category', 'subCategory', 'vehicleId', 'assetId', 'assetName',
            'projectId', 'projectName', 'engineerName', 'responsibleFor',
            'employeeAmount', 'companyAmount', 'payableDuration', 'monthStart',
            'employees' // handled below
        ];

        // 2. Perform submission logic from Draft -> Pending
        if (oldStatus === 'Draft' && updates.fineStatus === 'Pending') {
            console.log("[UpdateFine] Submitting Draft Fine. Routing directly to HR...");
            const bulkIds = fine.assignedEmployees
                .map(e => e.employeeId)
                .filter(id => id && id !== 'VEGA-HR-0000');

            // Validation: Company check
            const employeesWithNoCompany = await EmployeeBasic.find({
                employeeId: { $in: bulkIds },
                $or: [{ company: { $exists: false } }, { company: null }]
            }).select('firstName lastName employeeId');

            if (employeesWithNoCompany.length > 0) {
                const names = employeesWithNoCompany.map(e => `${e.firstName} ${e.lastName || ''}`.trim());
                return res.status(400).json({
                    message: `Cannot submit: The following users have no company: ${names.join(', ')}. Please update their profile first.`
                });
            }

            // Identify target HR HOD for the first employee's company
            const targetEmpId = (fine.assignedEmployees && fine.assignedEmployees.length > 0)
                ? fine.assignedEmployees[0].employeeId
                : null;

            if (targetEmpId) {
                try {
                    const hrHOD = await getDepartmentHOD('hr', targetEmpId);
                    if (hrHOD) {
                        const hrUser = await User.findOne({ employeeId: hrHOD.employeeId });
                        if (hrUser) {
                            for (const f of fines) {
                                f.submittedTo = hrUser._id;
                                f.fineStatus = 'Pending HR';
                                f.workflow = [
                                    { role: 'HR', assignedTo: hrUser._id, status: 'Pending', assignedAt: new Date() }
                                ];
                                await f.save();
                            }
                            shouldSendApprovalEmail = true;
                            console.log(`[UpdateFine] ${fines.length} Fines routed directly to HR: ${hrUser._id}`);
                        }
                    }
                } catch (snapErr) {
                    console.error('[UpdateFine] Error resolving HR:', snapErr);
                }
            }
        } else if (updates.resubmit && oldStatus === 'Rejected') {
            // === RESUBMIT LOGIC ===
            console.log("[UpdateFine] Resubmitting previously rejected fine.");
            const rejectedStep = (fine.workflow || []).find(w => w.status === 'Rejected');
            for (const f of fines) {
                const rejectedStep = (f.workflow || []).find(w => w.status === 'Rejected');
                if (rejectedStep) {
                    rejectedStep.status = 'Pending';
                    rejectedStep.actionedAt = null;
                    if (updates.remarks) rejectedStep.comment = `RESUBMITTED: ${updates.remarks}`;

                    if (rejectedStep.role === 'HR') f.fineStatus = 'Pending HR';
                    else if (rejectedStep.role === 'Accounts') f.fineStatus = 'Pending Accounts';
                    else if (rejectedStep.role === 'Management' || rejectedStep.role === 'CEO') f.fineStatus = 'Pending Authorization';
                    else f.fineStatus = 'Pending Review';

                    f.submittedTo = rejectedStep.assignedTo;
                    await f.save();
                }
            }
            shouldSendApprovalEmail = true;
            console.log(`[UpdateFine] Resubmitted group of ${fines.length} fines.`);
        }

        // 3. Apply updates only for allowed fields (Loop all for bulk update)
        for (const f of fines) {
            allowedUpdates.forEach(key => {
                if (updates[key] !== undefined) {
                    if (key === 'employees' && Array.isArray(updates.employees)) {
                        // Skip bulk employee list update for individual suffix records unless specified
                    } else if (key === 'attachment') {
                        if (updates.attachment && updates.attachment.url && !isValidStorageUrl(updates.attachment.url)) {
                            console.warn("[UpdateFine] Invalid URL. Skipping.");
                        } else {
                            f.attachment = updates.attachment;
                        }
                    } else if (key !== 'employees') {
                        f[key] = updates[key];
                    }
                }
            });
            await f.save();
        }

        if (oldStatus !== 'Rejected' && updates.fineStatus === 'Rejected') {
            if (!updates.rejectionReason || updates.rejectionReason.trim().length === 0) {
                return res.status(400).json({ message: "Reason for rejection is mandatory." });
            }

            for (const f of fines) {
                f.fineStatus = 'Rejected';
                f.rejectedBy = req.user?._id;
                f.rejectedDate = new Date();
                f.rejectionReason = updates.rejectionReason;

                // Update Workflow to Rejected
                if (!f.workflow) f.workflow = [];
                const pendingStep = f.workflow.find(w => w.status === 'Pending');
                if (pendingStep) {
                    pendingStep.status = 'Rejected';
                    pendingStep.actionedAt = new Date();
                    pendingStep.comment = updates.rejectionReason;
                } else {
                    f.workflow.push({
                        role: 'Reviewer',
                        assignedTo: req.user?._id,
                        status: 'Rejected',
                        assignedAt: new Date(),
                        actionedAt: new Date(),
                        comment: updates.rejectionReason
                    });
                }
                await f.save();
            }
        }

        const updatedFine = await fine.save();

        // === SYNC DASHBOARD ACTION ===
        try {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            const targetEmpId = (updatedFine.assignedEmployees && updatedFine.assignedEmployees.length > 0)
                ? updatedFine.assignedEmployees[0].employeeId
                : null;
            const subjectEmp = targetEmpId ? await EmployeeBasic.findOne({ employeeId: targetEmpId }) : null;

            // 1. Resolve current pending steps
            await syncDashboardAction({
                requestId: updatedFine._id,
                requestType: 'Fine',
                status: updatedFine.fineStatus,
                subjectEmployee: subjectEmp,
                actionedBy: req.user?._id,
                comment: updatedFine.rejectionReason
            });

            // 2. If there's a new pending step, create it
            const nextPendingStep = updatedFine.workflow?.find(w => w.status === 'Pending');
            if (nextPendingStep) {
                await syncDashboardAction({
                    requestId: updatedFine._id,
                    requestType: 'Fine',
                    assignedTo: nextPendingStep.assignedTo,
                    status: 'Pending',
                    subjectEmployee: subjectEmp,
                    extra1: updatedFine.fineType,
                    extra2: `AED ${updatedFine.fineAmount}`
                });
            }
        } catch (syncErr) {
            console.error("[UpdateFine] Dashboard Sync Error:", syncErr);
        }

        if (shouldSendApprovalEmail) {
            sendFineApprovalEmail(updatedFine, updatedFine.assignedEmployees).catch(err => console.error("[UpdateFine] Failed to send approval email:", err));
        }

        // If newly rejected, send notification
        if (oldStatus !== 'Rejected' && updatedFine.fineStatus === 'Rejected') {
            try {
                // Create a plain object to modify for the email handler
                // This breaks the direct reference to the Mongoose document
                const safeFineData = updatedFine.toObject ? updatedFine.toObject() : { ...updatedFine };

                // Explicitly validate and sanitize the attachment URL
                if (safeFineData.attachment && safeFineData.attachment.url) {
                    if (!isValidStorageUrl(safeFineData.attachment.url)) {
                        console.warn(`[UpdateFine] Invalid attachment URL detected (${safeFineData.attachment.url}). Removing attachment from rejection email.`);
                        safeFineData.attachment = null; // Remove attachment from the object passed to the emailer
                    }
                }

                await sendFineRejectedEmail(safeFineData, updatedFine.assignedEmployees);
            } catch (err) {
                console.error("Failed to send rejection email:", err);
            }
        }

        return res.status(200).json({
            message: "Fine updated successfully",
            fine: updatedFine
        });
    } catch (error) {
        console.error('Error updating fine:', error);
        return res.status(500).json({
            message: "Failed to update fine",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};
