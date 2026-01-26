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

        // Sanitize ID (remove artifacts like ":1")
        if (id && typeof id === 'string' && id.includes(':')) {
            id = id.split(':')[0].trim();
        }

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

        // Update fields
        const oldStatus = fine.fineStatus;
        let shouldSendApprovalEmail = false;

        // === SUBMIT FROM DRAFT LOGIC ===
        if (oldStatus === 'Draft' && updates.fineStatus === 'Pending') {
            console.log("[UpdateFine] Submitting Draft Fine. Identifying Manager...");

            // Use the first assigned employee to determine the manager
            const targetEmpId = (fine.assignedEmployees && fine.assignedEmployees.length > 0)
                ? fine.assignedEmployees[0].employeeId
                : null;

            if (targetEmpId) {
                const employeeForSnapshot = await EmployeeBasic.findOne({ employeeId: targetEmpId })
                    .select('primaryReportee')
                    .lean();

                if (employeeForSnapshot && employeeForSnapshot.primaryReportee) {
                    const managerBasic = await EmployeeBasic.findById(employeeForSnapshot.primaryReportee)
                        .select('employeeId companyEmail email workEmail firstName lastName')
                        .lean();

                    if (managerBasic) {
                        let reporteeUser = null;
                        if (managerBasic.employeeId) {
                            if (req.user && req.user.employeeId === managerBasic.employeeId) {
                                reporteeUser = req.user;
                            } else {
                                reporteeUser = await User.findOne({ employeeId: managerBasic.employeeId });
                            }
                        }
                        if (!reporteeUser) {
                            const managerEmail = managerBasic.companyEmail || managerBasic.workEmail || managerBasic.email;
                            if (managerEmail) {
                                reporteeUser = await User.findOne({ $or: [{ email: managerEmail }, { username: managerEmail }] });
                            }
                        }

                        if (reporteeUser) {
                            console.log(`[UpdateFine] Found Manager: ${reporteeUser.name || reporteeUser.username || reporteeUser.email}`);
                            updates.submittedTo = reporteeUser._id;

                            // Initialize Workflow
                            updates.workflow = [{
                                role: 'Reportee',
                                assignedTo: reporteeUser._id,
                                status: 'Pending',
                                assignedAt: new Date()
                            }];

                            shouldSendApprovalEmail = true;
                        }
                    }
                }
            }
        }

        Object.keys(updates).forEach(key => {
            if (updates[key] !== undefined) {
                fine[key] = updates[key];
            }
        });


        // Set rejection tracking if applicable
        if (oldStatus !== 'Rejected' && fine.fineStatus === 'Rejected') {
            fine.rejectedBy = req.user?._id;
            fine.rejectedDate = new Date();
        }

        const updatedFine = await fine.save();

        if (shouldSendApprovalEmail) {
            sendFineApprovalEmail(updatedFine, updatedFine.assignedEmployees).catch(err => console.error("[UpdateFine] Failed to send approval email:", err));
        }

        // If newly rejected, send notification
        if (oldStatus !== 'Rejected' && updatedFine.fineStatus === 'Rejected') {
            try {
                if (updatedFine.attachment && updatedFine.attachment.url) {
                    if (!isValidStorageUrl(updatedFine.attachment.url)) {
                        console.warn('Skipping email due to invalid attachment URL hostname');
                        return; // Skip email to prevent SSRF
                    }
                }
                await sendFineRejectedEmail(updatedFine, updatedFine.assignedEmployees);
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
