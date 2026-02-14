import Fine from "../../models/Fine.js";
import { sendFineRejectedEmail } from "../../utils/sendFineRejectedEmail.js";
import { isValidStorageUrl } from "../../utils/validationHelper.js";

import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { sendFineApprovalEmail } from "../../utils/sendFineApprovalEmail.js";

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
        let fine;
        const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);
        if (isValidObjectId) {
            fine = await Fine.findById(id);
        }
        if (!fine) {
            fine = await Fine.findOne({ fineId: id });
        }

        if (!fine) {
            return res.status(404).json({ message: "Fine not found" });
        }

        const oldStatus = fine.fineStatus;
        let shouldSendApprovalEmail = false;

        // 1. Explicitly Define Allowed Fields (Fix Mass Assignment)
        const allowedUpdates = [
            'fineStatus', 'description', 'awardedDate', 'remarks',
            'attachment', 'category', 'subCategory', 'vehicleId',
            'projectId', 'projectName', 'engineerName', 'responsibleFor',
            'employeeAmount', 'companyAmount', 'payableDuration', 'monthStart',
            'employees' // handled below
        ];

        // 2. Perform submission logic from Draft -> Pending
        if (oldStatus === 'Draft' && updates.fineStatus === 'Pending') {
            // ... (keep submission logic)
            console.log("[UpdateFine] Submitting Draft Fine. Validating Company linkage...");
            const bulkIds = fine.assignedEmployees.map(e => e.employeeId).filter(id => id);
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

            // Manager Identification
            const targetEmpId = (fine.assignedEmployees && fine.assignedEmployees.length > 0)
                ? fine.assignedEmployees[0].employeeId
                : null;

            if (targetEmpId) {
                const employeeForSnapshot = await EmployeeBasic.findOne({ employeeId: targetEmpId }).select('primaryReportee').lean();
                if (employeeForSnapshot && employeeForSnapshot.primaryReportee) {
                    const managerBasic = await EmployeeBasic.findById(employeeForSnapshot.primaryReportee)
                        .select('employeeId companyEmail email workEmail firstName lastName').lean();
                    if (managerBasic) {
                        let reporteeUser = await User.findOne({ employeeId: managerBasic.employeeId });
                        if (!reporteeUser) {
                            const managerEmail = managerBasic.companyEmail || managerBasic.workEmail || managerBasic.email;
                            if (managerEmail) reporteeUser = await User.findOne({ $or: [{ email: managerEmail }, { username: managerEmail }] });
                        }
                        if (reporteeUser) {
                            fine.submittedTo = reporteeUser._id;
                            fine.workflow = [{ role: 'Reportee', assignedTo: reporteeUser._id, status: 'Pending', assignedAt: new Date() }];
                            shouldSendApprovalEmail = true;
                        }
                    }
                }
            }
        } else if (updates.resubmit && oldStatus === 'Rejected') {
            // === RESUBMIT LOGIC ===
            console.log("[UpdateFine] Resubmitting previously rejected fine.");
            const rejectedStep = (fine.workflow || []).find(w => w.status === 'Rejected');
            if (rejectedStep) {
                // Reset the rejected step to Pending
                rejectedStep.status = 'Pending';
                rejectedStep.actionedAt = null;
                if (updates.remarks) rejectedStep.comment = `RESUBMITTED: ${updates.remarks}`;

                fine.fineStatus = 'Pending';

                fine.submittedTo = rejectedStep.assignedTo;
                shouldSendApprovalEmail = true;

                console.log(`[UpdateFine] Resubmitting: Role=${rejectedStep.role} -> TargetStatus=Pending`);
            }
        }

        // 3. Apply updates only for allowed fields
        allowedUpdates.forEach(key => {
            if (updates[key] !== undefined) {
                if (key === 'employees' && Array.isArray(updates.employees)) {
                    fine.assignedEmployees = updates.employees.map(emp => ({
                        employeeId: emp.employeeId,
                        employeeName: emp.employeeName || 'Unknown',
                        daysWorked: emp.daysWorked || 0,
                        approvalStatus: emp.approvalStatus || 'Pending',
                        individualAmount: emp.employeeAmount || updates.employeeAmount || 0
                    }));
                } else if (key === 'attachment') {
                    // Double check URL inside attachment object if modified
                    if (updates.attachment && updates.attachment.url && !isValidStorageUrl(updates.attachment.url)) {
                        // ignore malicious URL update
                        console.warn("[UpdateFine] Attempted to update with invalid attachment URL. Skipping attachment update.");
                    } else {
                        fine.attachment = updates.attachment;
                    }
                } else if (key !== 'employees') {
                    fine[key] = updates[key];
                }
            }
        });

        if (oldStatus !== 'Rejected' && updates.fineStatus === 'Rejected') {
            if (!updates.rejectionReason || updates.rejectionReason.trim().length === 0) {
                return res.status(400).json({ message: "Reason for rejection is mandatory." });
            }
            fine.rejectedBy = req.user?._id;
            fine.rejectedDate = new Date();
            fine.rejectionReason = updates.rejectionReason;

            // NEW: Update Workflow to Rejected
            if (!fine.workflow) fine.workflow = [];
            const pendingStep = fine.workflow.find(w => w.status === 'Pending');
            if (pendingStep) {
                pendingStep.status = 'Rejected';
                pendingStep.actionedAt = new Date();
                pendingStep.comment = updates.rejectionReason;
            } else {
                fine.workflow.push({
                    role: 'Reviewer',
                    assignedTo: req.user?._id,
                    status: 'Rejected',
                    assignedAt: new Date(),
                    actionedAt: new Date(),
                    comment: updates.rejectionReason
                });
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
