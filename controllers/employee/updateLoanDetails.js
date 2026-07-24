import nodemailer from "nodemailer";
import { resolveFrontendBaseUrl, emailFrontendUrl } from '../../utils/resolveFrontendBaseUrl.js';
import Loan from "../../models/Loan.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import {
    isApprovedLoanStatus,
    isUserHrForApprovedLoanEdit,
    restrictApprovedLoanUpdates,
} from "../../utils/loanApprovedEditAuth.js";

export const updateLoanDetails = async (req, res) => {
    const { id } = req.params;
    const {
        type,
        amount,
        duration,
        reason,
        monthStart,
        status,
        scheduleOnlyEdit,
        partyPayableOnly,
        expenseAccountId,
        expenseAccountName,
        paidThroughAccountId,
        paidThroughAccountName,
        zohoOrganizationId,
    } = req.body;

    try {
        const loan = await Loan.findById(id);
        if (!loan) {
            return res.status(404).json({ message: "Loan request not found" });
        }

        const loanStatus = loan.approvalStatus || loan.status;
        const isApproved = isApprovedLoanStatus(loanStatus);

        // Accounts fills Expense Account + Paid Through on Loan/Adv Parties card.
        if (partyPayableOnly) {
            if (loanStatus !== 'Pending Accounts') {
                return res.status(403).json({
                    message:
                        loanStatus === 'Paid'
                            ? 'Accounts fields cannot be changed after the loan/advance is paid.'
                            : 'Expense Account / Paid Through can only be set at the Accounts stage (after HR approval).',
                });
            }

            if (zohoOrganizationId !== undefined) {
                loan.zohoOrganizationId = String(zohoOrganizationId || '').trim();
            }

            if (expenseAccountId !== undefined) {
                loan.expenseAccountId = String(expenseAccountId || '').trim();
            }
            if (expenseAccountName !== undefined) {
                loan.expenseAccountName = String(expenseAccountName || '').trim();
            }
            if (!loan.expenseAccountId) {
                loan.expenseAccountName = '';
            }

            if (paidThroughAccountId !== undefined) {
                loan.paidThroughAccountId = String(paidThroughAccountId || '').trim();
            }
            if (paidThroughAccountName !== undefined) {
                loan.paidThroughAccountName = String(paidThroughAccountName || '').trim();
            }
            if (!loan.paidThroughAccountId) {
                loan.paidThroughAccountName = '';
            }

            const savedLoan = await loan.save();
            return res.status(200).json({
                message: 'Party accounts updated successfully',
                loan: savedLoan,
            });
        }

        if (isApproved) {
            if (!scheduleOnlyEdit) {
                return res.status(403).json({
                    message: 'Approved loans can only have repayment schedule updated by HR.',
                });
            }

            const hrOk = await isUserHrForApprovedLoanEdit(req, loan);
            if (!hrOk) {
                return res.status(403).json({ message: 'Only HR can edit approved loan schedules.' });
            }

            const { error, allowed } = restrictApprovedLoanUpdates(req.body, loan);
            if (error) {
                return res.status(400).json({ message: error });
            }

            const { preserveOriginalLoanScheduleBeforeEdit } = await import('../../utils/loanDeductionScheduleSnapshot.js');
            preserveOriginalLoanScheduleBeforeEdit(loan);

            if (allowed.duration !== undefined) {
                loan.duration = loan.type === 'Advance' ? 1 : allowed.duration;
            }
            if (allowed.monthStart !== undefined) {
                loan.monthStart = allowed.monthStart;
            }

            const savedLoan = await loan.save();

            try {
                const { persistLoanApprovalAttachments } = await import('../../utils/persistLoanApprovalAttachments.js');
                await persistLoanApprovalAttachments(savedLoan, { forceRegenerate: true });
            } catch (pdfErr) {
                console.error('[UpdateLoan] Failed to regenerate acknowledgment PDF:', pdfErr?.message || pdfErr);
            }

            return res.status(200).json({
                message: 'Repayment schedule updated successfully',
                loan: savedLoan,
            });
        }

        // Prevent editing if not Draft or rejected? For now, allow edit if user is authorized.
        const oldStatus = loan.status;
        const newStatus = status || loan.status;

        // Update basic fields
        loan.type = type || loan.type;
        loan.amount = amount || loan.amount;
        loan.duration = duration || loan.duration;
        loan.reason = reason || loan.reason;
        if (monthStart !== undefined) loan.monthStart = monthStart;

        // Handle attachment update
        const { attachment } = req.body;
        if (attachment && attachment.data) {
            try {
                const { uploadDocumentToS3 } = await import("../../utils/s3Upload.js");
                const uploadResult = await uploadDocumentToS3(
                    attachment.data,
                    `loans/${loan.employeeId}`,
                    attachment.name || 'loan-attachment.pdf',
                    'raw'
                );

                loan.attachment = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: attachment.name || '',
                    mimeType: attachment.mimeType || 'application/pdf'
                };
                console.log(`[UpdateLoan] New attachment uploaded: ${uploadResult.url}`);
            } catch (uploadError) {
                console.error(`[UpdateLoan] Attachment upload failed:`, uploadError);
            }
        } else if (attachment === null) {
            // Optional: Clear attachment if null is explicitly passed
            loan.attachment = undefined;
        }

        loan.status = newStatus;
        loan.approvalStatus = newStatus;

        // Transitions: Draft -> Pending
        let sendEmail = false;
        let reportee = null;
        let employeeBasic = null;

        if (oldStatus === 'Draft' && newStatus === 'Pending') {
            // --- VALIDATION: Existing Loan Check ---
            // Block if employee already has an Approved or In-Progress loan/advance (excluding this one)
            const activeLoan = await Loan.findOne({
                _id: { $ne: id },
                employeeId: loan.employeeId,
                status: { $in: ['Approved', 'Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'] }
            }).lean();

            if (activeLoan) {
                const isApproved = activeLoan.status === 'Approved';
                return res.status(400).json({
                    message: isApproved
                        ? `This employee already has an Approved loan (${activeLoan.loanId}). A new request cannot be submitted while a loan is active.`
                        : `This employee already has another loan application in progress (${activeLoan.loanId} - ${activeLoan.status}).`
                });
            }

            employeeBasic = await getCompleteEmployee(loan.employeeObjectId);
            if (employeeBasic) {
                reportee = employeeBasic.primaryReportee;
                if (reportee) {
                    loan.submittedTo = reportee._id;
                    loan.workflow = [{
                        role: 'Manager',
                        assignedTo: reportee._id,
                        status: 'Pending',
                        assignedAt: new Date()
                    }];
                    sendEmail = true;
                }
            }
        } else if (req.body.resubmit && oldStatus === 'Rejected') {
            // --- VALIDATION: Existing Loan Check for Resubmit ---
            const activeLoan = await Loan.findOne({
                _id: { $ne: id },
                employeeId: loan.employeeId,
                status: { $in: ['Approved', 'Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'] }
            }).lean();

            if (activeLoan) {
                return res.status(400).json({
                    message: `Cannot resubmit this application. The employee already has another ${activeLoan.status === 'Approved' ? 'active Approved loan' : 'application in progress'} (${activeLoan.loanId}).`
                });
            }

            // === RESUBMIT LOGIC ===
            console.log("[UpdateLoan] Resubmitting previously rejected loan.");
            const rejectedStep = (loan.workflow || []).find(w => w.status === 'Rejected');
            if (rejectedStep) {
                // Reset the rejected step to Pending
                rejectedStep.status = 'Pending';
                rejectedStep.actionedAt = null;
                if (reason) rejectedStep.comment = `RESUBMITTED: ${reason}`;

                loan.status = 'Pending';
                loan.approvalStatus = rejectedStep.role === 'Manager' ? 'Pending' :
                    rejectedStep.role === 'Accounts' ? 'Pending Accounts' :
                        'Pending Authorization';

                loan.submittedTo = rejectedStep.assignedTo;
                sendEmail = true;

                // For email logic
                employeeBasic = await getCompleteEmployee(loan.employeeObjectId);
                const User = await import("../../models/User.js").then(m => m.default);
                const nextUser = await User.findById(rejectedStep.assignedTo);
                if (nextUser) {
                    reportee = await EmployeeBasic.findOne({ employeeId: nextUser.employeeId });
                }
            }
        }

        const savedLoan = await loan.save();

        // Send Email Notification if status changed to Pending OR if still Pending and details updated
        if (newStatus === 'Pending' || sendEmail) {
            if (!employeeBasic) employeeBasic = await getCompleteEmployee(loan.employeeObjectId);
            if (employeeBasic) {
                if (!reportee) reportee = employeeBasic.primaryReportee;
                if (reportee) {
                    const reporteeEmail = reportee.companyEmail || reportee.workEmail || reportee.email;
                    if (reporteeEmail) {
                        const emailUser = process.env.EMAIL_USER?.trim();
                        const emailPass = process.env.EMAIL_PASS?.trim();

                        if (emailUser && emailPass) {
                            const transporter = nodemailer.createTransport({
                                host: "smtp.office365.com",
                                port: 587,
                                secure: false,
                                auth: { user: emailUser, pass: emailPass }
                            });

                            const employeeName = `${employeeBasic.firstName || ""} ${employeeBasic.lastName || ""}`.trim();
                            const reporteeName = `${reportee.firstName || ""} ${reportee.lastName || ""}`.trim();
                            const subject = `${oldStatus === 'Draft' ? '' : 'UPDATED '}${loan.loanId || type} Application: ${employeeName}`;

                            const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
                            const baseUrl = resolveFrontendBaseUrl(req);
                            const typeSlug = type ? type.replace(/\s+/g, '-') : 'Loan';
                            const actionUrl = `${baseUrl}/HRM/LoanAndAdvance/${typeSlug}-${savedLoan._id}`;

                            const html = `
                                 <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                                     <div style="background-color: #3b82f6; color: white; padding: 20px; text-align: center;">
                                         <h2 style="margin: 0;">${type} Application ${oldStatus === 'Draft' ? 'Submitted' : 'Updated'}</h2>
                                     </div>
                                     <div style="padding: 30px;">
                                         <p>Hello <strong>${reporteeName}</strong>,</p>
                                         <p><strong>${employeeName}</strong> has ${oldStatus === 'Draft' ? 'submitted' : 'updated'} their request for ${type}.</p>
                                         
                                         <div style="background-color: #eff6ff; padding: 20px; border-radius: 8px; border: 1px solid #dbeafe; margin: 25px 0;">
                                             <p style="margin: 0;"><strong>Employee:</strong> ${employeeName} (${loan.employeeId})</p>
                                             <p style="margin: 8px 0 0 0;"><strong>Type:</strong> ${type}</p>
                                             <p style="margin: 8px 0 0 0;"><strong>Amount:</strong> ${Number(amount || loan.amount).toLocaleString()}</p>
                                             <p style="margin: 8px 0 0 0;"><strong>Duration:</strong> ${duration || loan.duration} Months</p>
                                             <p style="margin: 8px 0 0 0;"><strong>Start Month:</strong> ${monthStart || loan.monthStart || 'Immediate'}</p>
                                              <p style="margin: 8px 0 0 0;"><strong>Reason:</strong> ${reason || loan.reason}</p>
                                         </div>
                                         
                                         <p style="text-align: center; margin: 35px 0;">
                                             <a href="${actionUrl}" style="background-color: #3b82f6; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 16px;">View Request</a>
                                         </p>
                                     </div>
                                 </div>
                             `;

                            await transporter.sendMail({
                                from: `"VeRP Portal" <${emailUser}>`,
                                to: reporteeEmail,
                                subject,
                                html
                            });
                        }
                    }
                }
            }
        }

        res.status(200).json({ message: "Loan details updated successfully", loan: savedLoan });

    } catch (error) {
        console.error("Error updating loan details:", error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: "Invalid loan ID format" });
        }
        res.status(500).json({ message: "Failed to update loan details" });
    }
};

/** Accounts party payable only — uses loan view permission (not Create). */
export const updateLoanPartyPayable = async (req, res) => {
    req.body = {
        ...(req.body || {}),
        partyPayableOnly: true,
    };
    return updateLoanDetails(req, res);
};
