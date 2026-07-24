import { generatePdf } from "../../utils/generatePdf.js";
import { resolveFrontendBaseUrl, emailFrontendUrl } from '../../utils/resolveFrontendBaseUrl.js';
import Loan from "../../models/Loan.js";
import User from "../../models/User.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import nodemailer from "nodemailer";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { sendHODAuthorizationEmail } from "../../utils/sendHODAuthorizationEmail.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { resolveEmployeeEmail, getFallbackEmailNote, addEmployeeEmailToSet } from "../../utils/resolveEmployeeEmail.js";
import { LOAN_PENDING_PAYMENT_STATUS } from "../../utils/loanStatusConstants.js";

export const approveLoan = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body; // Approved, Rejected, Pending (Submit), Cancelled

        if (!status || !['Approved', 'Rejected', 'Pending', 'Cancelled'].includes(status)) {
            return res.status(400).json({ message: "Invalid status" });
        }

        const loan = await Loan.findById(id);
        if (!loan) {
            return res.status(404).json({ message: "Loan not found" });
        }

        const requestingUserId = req.user?.id;
        if (!requestingUserId) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        // Identify Approver
        let approverBasic = null;
        let approverDetails = null;

        const userObj = await User.findById(requestingUserId);
        const isAdmin = req.user.isAdmin === true;

        if (isAdmin) {
            approverDetails = { name: 'Admin', designation: 'Administrator', isAdmin: true };
        } else {
            // Find Employee
            approverBasic = await EmployeeBasic.findOne({
                $or: [{ _id: requestingUserId }, { employeeId: userObj?.employeeId }]
            });

            if (!approverBasic && userObj?.employeeId) {
                approverBasic = await EmployeeBasic.findOne({ employeeId: userObj.employeeId });
            }
        }

        if (approverBasic) {
            approverDetails = {
                name: `${approverBasic.firstName} ${approverBasic.lastName}`,
                designation: approverBasic.designation,
                department: approverBasic.department,
                email: approverBasic.companyEmail,
                id: approverBasic._id
            };
        }

        // Determine Next Status and Notifications
        let finalStatus = status; // The status requested by the frontend (Approved/Rejected)
        let nextStage = loan.approvalStatus; // Internal tracking
        let publicStatus = 'Pending'; // Default public status for intermediate steps

        let nextApprover = null;
        let emailSubject = "";
        let emailType = "";

        // Determine Current Stage
        const currentStage = loan.approvalStatus || loan.status;

        // 0. SUBMIT / CANCEL STAGE
        if (status === 'Cancelled') {
            publicStatus = 'Cancelled';
            nextStage = 'Cancelled';
        }
        else if (status === 'Pending') {
            if (loan.status !== 'Draft') {
                return res.status(400).json({ message: "Only Draft requests can be submitted for approval." });
            }

            const applicant = await getCompleteEmployee(loan.employeeId);
            // VALIDATION: Check if required designations are assigned in Flowchart
            const hrHOD = await getDepartmentHOD('hr');
            const accountsHOD = await getDepartmentHOD('accounts');
            const managementHOD = await getManagementHOD();

            const missingDesignations = [];
            if (!hrHOD) missingDesignations.push('HR Admin');
            if (!accountsHOD) missingDesignations.push('Accounts/Finance');
            if (!managementHOD) missingDesignations.push('Management/CEO');

            if (missingDesignations.length > 0) {
                return res.status(400).json({
                    message: `Cannot submit for approval. The following designations are not assigned in Flowchart: ${missingDesignations.join(', ')}. Please assign these designations in Settings > FlowChart before submitting this loan request.`
                });
            }

            publicStatus = 'Pending';
            nextStage = 'Pending HR';

            let hrUser = null;
            if (hrHOD.employeeId) {
                hrUser = await User.findOne({ employeeId: hrHOD.employeeId });
            }
            const nextAssignmentId = hrUser ? hrUser._id : hrHOD._id;
            nextApprover = hrHOD;

            emailSubject = "New Loan/Advance Request for Review";
            emailType = "HR";

            // Set initial workflow
            loan.workflow = [{
                role: 'HR Admin',
                assignedTo: nextAssignmentId,
                status: 'Pending',
                assignedAt: new Date()
            }];

            console.log(`[ApproveLoan] Draft -> Pending HR transition. Assigned to: ${hrHOD.employeeId}`);
        }
        else if (status === 'Approved') {
            // APPROVAL LOGIC — Admin can act at any stage; only Management finalizes payment
            if (approverBasic || isAdmin) {

                // 1. HR STAGE (Pending OR Pending HR -> Pending Accounts)
                if (currentStage === 'Pending' || currentStage === 'Pending HR') {
                    const isHR = approverBasic?.department && /human resource|hr|hrm/i.test(approverBasic.department) || (approverBasic?.designation && /hr/i.test(approverBasic.designation));
                    const isAssignedHR = loan.submittedTo && (String(loan.submittedTo) === String(requestingUserId) || String(loan.submittedTo) === String(approverBasic?._id));

                    if (isHR || isAssignedHR || isAdmin) {
                        // VALIDATION: Check if Accounts HOD is assigned before proceeding
                        const accountsHOD = await getDepartmentHOD('finance');
                        if (!accountsHOD) {
                            return res.status(400).json({
                                message: "Cannot proceed. Accounts/Finance designation is not assigned in Flowchart. Please assign Accounts/Finance designation in Settings > FlowChart before approving this loan."
                            });
                        }

                        nextStage = 'Pending Accounts';
                        publicStatus = 'Pending'; // Keep visible status as Pending for Accounts

                        loan.hrApprovedBy = approverBasic?._id || requestingUserId;
                        nextApprover = accountsHOD;
                        console.log('[Loan]', loan.loanId, 'HR Approved. Next Finance Approver:', nextApprover ? `${nextApprover.firstName} ${nextApprover.lastName}` : 'NOT FOUND');
                        emailSubject = "Loan Pending Finance Approval";
                        emailType = "Accounts";
                    } else {
                        return res.status(403).json({ message: "Only HR can approve at this stage" });
                    }
                }
                // 3. ACCOUNTS STAGE (Pending Accounts -> Pending Authorization)
                else if (currentStage === 'Pending Accounts') {
                    const isFinance = approverBasic?.department && /finance|accounts|payroll/i.test(approverBasic.department) || (approverBasic?.designation && /account/i.test(approverBasic.designation));
                    const isAssignedFinance = loan.submittedTo && (String(loan.submittedTo) === String(requestingUserId) || String(loan.submittedTo) === String(approverBasic?._id));

                    if (isFinance || isAssignedFinance || isAdmin) {
                        if (!String(loan.expenseAccountId || '').trim()) {
                            return res.status(400).json({
                                message:
                                    'Accounts cannot approve until Expense Account is set on the Loan/Advance Parties card.',
                            });
                        }
                        if (!String(loan.paidThroughAccountId || '').trim()) {
                            return res.status(400).json({
                                message:
                                    'Accounts cannot approve until Paid Through is set on the Loan/Advance Parties card.',
                            });
                        }
                        if (
                            String(loan.expenseAccountId).trim() ===
                            String(loan.paidThroughAccountId).trim()
                        ) {
                            return res.status(400).json({
                                message:
                                    'Expense Account and Paid Through must be different Chart of Accounts.',
                            });
                        }

                        // VALIDATION: Check if Management HOD is assigned before proceeding
                        const managementHOD = await getManagementHOD();
                        if (!managementHOD) {
                            return res.status(400).json({
                                message: "Cannot proceed. Management/CEO designation is not assigned in Flowchart. Please assign Management designation in Settings > FlowChart before approving this loan."
                            });
                        }

                        nextStage = 'Pending Authorization';
                        publicStatus = 'Pending'; // Keep visible status as Pending for CEO

                        loan.accountsApprovedBy = approverBasic?._id || requestingUserId;
                        nextApprover = managementHOD;
                        console.log('[Loan]', loan.loanId, 'Finance Approved. Next Management:', nextApprover ? `${nextApprover.firstName} ${nextApprover.lastName}` : 'NOT FOUND');
                        emailSubject = "Loan Pending Final Authorization";
                        emailType = "Management";
                    } else {
                        return res.status(403).json({ message: "Only Finance/Accounts can approve at this stage" });
                    }
                }
                // 4. Management STAGE (Pending Authorization -> Pending Payment to Employee)
                else if (currentStage === 'Pending Authorization') {
                    const isMgtDept = approverBasic?.department && /management|corporate|board|executive/i.test(approverBasic.department);
                    const isMgtTitle = ['ceo', 'c.e.o', 'c.e.o.', 'chief executive officer', 'director', 'managing director', 'general manager', 'gm', 'g.m', 'g.m.'].includes(approverBasic?.designation?.toLowerCase());
                    const isAssignedMgt = loan.submittedTo && (String(loan.submittedTo) === String(requestingUserId) || String(loan.submittedTo) === String(approverBasic?._id));

                    if (isMgtTitle || isMgtDept || isAssignedMgt || isAdmin) {
                        nextStage = LOAN_PENDING_PAYMENT_STATUS;
                        publicStatus = LOAN_PENDING_PAYMENT_STATUS;
                    } else {
                        return res.status(403).json({ message: "Only Management can Authorize this loan" });
                    }
                }
            }
        } else if (status === 'Rejected') {
            const { rejectionReason } = req.body;
            if (!rejectionReason || rejectionReason.trim().length === 0) {
                return res.status(400).json({ message: "Reason for rejection is mandatory." });
            }
            publicStatus = 'Rejected';
            nextStage = 'Rejected';
            loan.rejectionReason = rejectionReason;
        }

        // Update Loan
        loan.status = publicStatus;
        loan.approvalStatus = nextStage;

        if (finalStatus === 'Approved' && nextStage === LOAN_PENDING_PAYMENT_STATUS) {
            loan.approvedBy = approverBasic ? approverBasic._id : requestingUserId;
            loan.approvedDate = new Date();
        } else if (finalStatus === 'Rejected') {
            loan.rejectedBy = approverBasic ? approverBasic._id : requestingUserId;
            loan.rejectedDate = new Date();
        } else if (finalStatus === 'Cancelled') {
            loan.cancelledBy = requestingUserId;
            loan.cancelledDate = new Date();
        }

        if (nextApprover) {
            // Find User ID for next approver to ensure dashboard visibility
            const nextUser = await User.findOne({ employeeId: nextApprover.employeeId });
            const nextAssignmentId = nextUser ? nextUser._id : nextApprover._id;

            loan.submittedTo = nextAssignmentId;

            // WORKFLOW UPDATES
            if (nextStage === 'Pending HR') {
                // If it got pushed to Pending HR, it means it was a Draft submission
                loan.workflow.push({
                    role: 'HR',
                    assignedTo: nextAssignmentId,
                    status: 'Pending',
                    assignedAt: new Date()
                });
            }
            else if (nextStage === 'Pending Accounts') {
                // 1. Mark HR Approved
                const hrEntry = loan.workflow ? loan.workflow.find(w => w.role === 'HR' && w.status === 'Pending') : null;
                if (hrEntry) {
                    hrEntry.status = 'Approved';
                    hrEntry.actionedAt = new Date();
                } else {
                    if (!loan.workflow) loan.workflow = [];
                    const hrUser = await User.findOne({ employeeId: approverBasic?.employeeId });
                    loan.workflow.push({
                        role: 'HR',
                        assignedTo: hrUser ? hrUser._id : (approverBasic ? approverBasic._id : requestingUserId),
                        status: 'Approved',
                        assignedAt: new Date(),
                        actionedAt: new Date()
                    });
                }

                // 2. Push Accounts (Pending)
                loan.workflow.push({
                    role: 'Accounts',
                    assignedTo: nextAssignmentId,
                    status: 'Pending',
                    assignedAt: new Date()
                });
            }
            else if (nextStage === 'Pending Authorization') {
                // 1. Mark Accounts Approved
                const accEntry = loan.workflow ? loan.workflow.find(w => w.role === 'Accounts' && w.status === 'Pending') : null;
                if (accEntry) {
                    accEntry.status = 'Approved';
                    accEntry.actionedAt = new Date();
                } else {
                    if (!loan.workflow) loan.workflow = [];
                    const accUser = await User.findOne({ employeeId: approverBasic?.employeeId });
                    loan.workflow.push({
                        role: 'Accounts',
                        assignedTo: accUser ? accUser._id : (approverBasic ? approverBasic._id : requestingUserId),
                        status: 'Approved',
                        assignedAt: new Date(),
                        actionedAt: new Date()
                    });
                }

                // 2. Push Management (Pending)
                loan.workflow.push({
                    role: 'Management',
                    assignedTo: nextAssignmentId,
                    status: 'Pending',
                    assignedAt: new Date()
                });
            }
        }

        if (nextStage === 'Rejected') {
            const rejectedStep = loan.workflow.find(w => w.status === 'Pending');
            if (rejectedStep) {
                rejectedStep.status = 'Rejected';
                rejectedStep.actionedAt = new Date();
                rejectedStep.comment = loan.rejectionReason;
            } else {
                loan.workflow.push({
                    role: 'Reviewer',
                    assignedTo: requestingUserId,
                    status: 'Rejected',
                    assignedAt: new Date(),
                    actionedAt: new Date(),
                    comment: loan.rejectionReason
                });
            }
        }

        // Final Authorization (Management) → Pending Payment to Employee
        if (nextStage === LOAN_PENDING_PAYMENT_STATUS) {
            const { snapshotLoanScheduleOnApproval } = await import('../../utils/loanDeductionScheduleSnapshot.js');
            snapshotLoanScheduleOnApproval(loan);
            if (loan.workflow) {
                const managementEntry = loan.workflow.find(w => w.role === 'Management' && w.status === 'Pending');
                if (managementEntry) {
                    managementEntry.status = 'Approved';
                    managementEntry.actionedAt = new Date();
                } else {
                    // Fallback
                    const managementUser = await User.findOne({ employeeId: approverBasic?.employeeId });
                    loan.workflow.push({
                        role: 'Management',
                        assignedTo: managementUser ? managementUser._id : (approverBasic ? approverBasic._id : requestingUserId),
                        status: 'Approved',
                        assignedAt: new Date(),
                        actionedAt: new Date()
                    });
                }
            }
        }

        await loan.save();

        // Sync Dashboard Action Table
        const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
        const applicant = await EmployeeBasic.findOne({ employeeId: loan.employeeId });

        // A. Resolve existing pending actions for this request
        const isManagementAuthorized =
            finalStatus === 'Approved' && nextStage === LOAN_PENDING_PAYMENT_STATUS;
        const isFinalStatus = isManagementAuthorized || finalStatus === 'Rejected';
        const needsAccountsDisbursement =
            isManagementAuthorized &&
            parseFloat(loan.amount || 0) - parseFloat(loan.paidAmount || 0) > 0.01;

        await syncDashboardAction({
            requestId: loan._id,
            requestType: 'Loan',
            // Specifically clear the acting user's task
            assignedTo: isFinalStatus ? null : req.user?._id,
            status: isManagementAuthorized ? 'Approved' : (isFinalStatus ? finalStatus : 'Approved'),
            subjectEmployee: applicant,
            requestedByName: req.user.name
        });

        // B. If there's a next approver, create a new pending action for them
        if (nextApprover && (nextStage.includes('Pending') || nextStage === 'Pending')) {
            await syncDashboardAction({
                requestId: loan._id,
                requestType: 'Loan',
                assignedTo: nextApprover._id,
                status: 'Pending',
                subjectEmployee: applicant,
                requestedByName: req.user.name,
                extra1: `AED ${loan.amount}`,
                extra2: `${loan.duration} Months`
            });
        }

        // C. After Management approval — Accounts "Paid to Employee" task (dashboard / bar / sidebar)
        let paymentDueAccountsHod = null;
        if (needsAccountsDisbursement) {
            try {
                const { syncLoanPaymentDueBell } = await import('../../utils/loanPaymentStatus.js');
                paymentDueAccountsHod = await syncLoanPaymentDueBell(
                    loan,
                    applicant,
                    req.user?.name || '',
                );
                await loan.save();
            } catch (payBellErr) {
                console.error(
                    '[ApproveLoan] Failed to sync Accounts pay-to-employee bell:',
                    payBellErr?.message || payBellErr,
                );
            }
        }

        // Handle Notifications
        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();

        if (emailUser && emailPass) {
            const transporter = nodemailer.createTransport({
                host: "smtp.office365.com",
                port: 587,
                secure: false,
                auth: { user: emailUser, pass: emailPass },
            });

            const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
            const baseUrl = resolveFrontendBaseUrl(req);
            const typeSlug = loan.type ? loan.type.replace(/\s+/g, '-') : 'Loan';
            const actionUrl = `${baseUrl}/HRM/LoanAndAdvance/${typeSlug}-${loan._id}`;

            // 1. Notify Next Approver
            if (nextApprover && (nextApprover.companyEmail || nextApprover.email)) {
                try {
                    let htmlContent = "";
                    const applicantName = loan.applicantName || (applicant ? `${applicant.firstName} ${applicant.lastName}` : 'Employee');
                    const workflowHistoryHtml = (loan.workflow || []).map(w => `
                        <div style="margin-bottom: 8px; font-size: 13px; display: flex; align-items: center; gap: 10px;">
                            <span style="color: ${w.status === 'Approved' ? '#059669' : w.status === 'Rejected' ? '#dc2626' : '#64748b'}; font-weight: 800; font-size: 14px;">${w.status === 'Approved' ? '✓' : w.status === 'Rejected' ? '✗' : '○'}</span>
                            <strong style="width: 80px; color: #475569;">${w.role}:</strong> 
                            <span style="color: #1e293b; font-weight: 600;">${w.status}</span>
                            ${w.actionedAt ? `<span style="color: #94a3b8; font-size: 11px;">(${new Date(w.actionedAt).toLocaleDateString()})</span>` : ''}
                        </div>
                    `).join('');

                    if (emailType === "Manager") {
                        const type = loan.type || 'Loan/Advance';
                        const amount = loan.amount;
                        const duration = loan.duration;
                        const reason = loan.reason;
                        const employeeId = loan.employeeId;

                        htmlContent = `
                            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                                <div style="background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); color: white; padding: 25px; text-align: center;">
                                    <h2 style="margin: 0; font-size: 20px; font-weight: 800;">PENDING REVIEW: ${type.toUpperCase()}</h2>
                                    <p style="margin: 5px 0 0 0; opacity: 0.85; font-size: 14px;">Reference: ${loan.loanId || loan._id}</p>
                                </div>
                                <div style="padding: 30px; background-color: #ffffff;">
                                    <p>Hello <strong>${nextApprover.firstName}</strong>,</p>
                                    <p>An application for <strong>${type}</strong> from <strong>${applicantName}</strong> is pending your review.</p>
                                    
                                    <div style="background-color: #f8fafc; padding: 25px; border-radius: 10px; border-left: 4px solid #0d9488; margin: 25px 0;">
                                        <table style="width: 100%; border-collapse: collapse;">
                                            <tr>
                                                <td style="padding: 6px 0; color: #64748b; font-size: 13px; width: 40%;"><strong>Applicant:</strong></td>
                                                <td style="padding: 6px 0; color: #1e293b; font-size: 14px; font-weight: 600;">${applicantName} (${employeeId})</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 6px 0; color: #64748b; font-size: 13px;"><strong>Amount:</strong></td>
                                                <td style="padding: 6px 0; color: #0d9488; font-size: 16px; font-weight: 800;">AED ${Number(amount).toLocaleString()}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 6px 0; color: #64748b; font-size: 13px;"><strong>Duration:</strong></td>
                                                <td style="padding: 6px 0; color: #1e293b; font-size: 14px;">${duration} Months</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 6px 0; color: #64748b; font-size: 13px;"><strong>Reason:</strong></td>
                                                <td style="padding: 6px 0; color: #475569; font-size: 13px; font-style: italic;">"${reason}"</td>
                                            </tr>
                                        </table>
                                    </div>

                                    <div style="margin-top: 25px; border: 1px solid #f1f5f9; padding: 20px; border-radius: 8px;">
                                        <h4 style="margin: 0 0 15px 0; font-size: 13px; color: #1e293b; text-transform: uppercase;">Application Progress:</h4>
                                        ${workflowHistoryHtml}
                                    </div>
                                    
                                    <p style="text-align: center; margin: 35px 0;">
                                        <a href="${actionUrl}" style="background-color: #0d9488; color: white; padding: 14px 35px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Action Request</a>
                                    </p>
                                </div>
                            </div>
                        `;
                    } else {
                        // Standard template for HR/Finance/CEO
                        htmlContent = `
                            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                                <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 25px; text-align: center;">
                                    <h2 style="margin: 0; font-size: 20px; font-weight: 800;">${emailSubject.toUpperCase()}</h2>
                                    <p style="margin: 5px 0 0 0; opacity: 0.85; font-size: 14px;">Reference: ${loan.loanId || loan._id}</p>
                                </div>
                                <div style="padding: 30px; background-color: #ffffff;">
                                    <p>Dear <strong>${nextApprover.firstName}</strong>,</p>
                                    <p>A loan application requires your review at the <strong>${emailType}</strong> stage.</p>
                                    
                                    <div style="background-color: #fffbeb; padding: 25px; border-radius: 10px; border-left: 4px solid #f59e0b; margin: 25px 0;">
                                        <table style="width: 100%; border-collapse: collapse;">
                                            <tr>
                                                <td style="padding: 6px 0; color: #78350f; font-size: 13px; width: 40%;"><strong>Applicant:</strong></td>
                                                <td style="padding: 6px 0; color: #451a03; font-size: 14px; font-weight: 600;">${applicantName}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 6px 0; color: #78350f; font-size: 13px;"><strong>Amount:</strong></td>
                                                <td style="padding: 6px 0; color: #b45309; font-size: 16px; font-weight: 800;">AED ${Number(loan.amount).toLocaleString()}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 6px 0; color: #78350f; font-size: 13px;"><strong>Reason:</strong></td>
                                                <td style="padding: 6px 0; color: #451a03; font-size: 13px;">${loan.reason}</td>
                                            </tr>
                                        </table>
                                    </div>

                                    <div style="margin-top: 25px; border: 1px solid #fef3c7; padding: 20px; border-radius: 8px;">
                                        <h4 style="margin: 0 0 15px 0; font-size: 13px; color: #451a03; text-transform: uppercase;">Current Approval Path:</h4>
                                        ${workflowHistoryHtml}
                                    </div>

                                    <div style="text-align: center; margin: 35px 0;">
                                        <a href="${actionUrl}" style="background-color: #f59e0b; color: white; padding: 14px 35px; text-decoration: none; border-radius: 8px; font-weight: bold;">Review Application</a>
                                    </div>
                                </div>
                            </div>
                        `;
                    }

                    const mailOptions = {
                        from: `"VeRP Notification" <${emailUser}>`,
                        to: nextApprover.companyEmail || nextApprover.email,
                        subject: emailSubject,
                        html: htmlContent
                    };
                    await transporter.sendMail(mailOptions);
                } catch (emailErr) {
                    console.error("Next Approver Email Error:", emailErr);
                }
            }

            // 2. Notify Employee on FULL Authorization (Pending Payment to Employee)
            if (finalStatus === 'Approved' && nextStage === LOAN_PENDING_PAYMENT_STATUS) {
                try {
                    const applicant = await EmployeeBasic.findOne({ employeeId: loan.employeeId }).populate('primaryReportee');
                    const creator = await User.findById(loan.createdBy);

                    if (applicant) {
                        const toEmails = new Set();
                        const ccEmails = new Set();

                        // 1. Applicant Email (fallback to primaryReportee when applicant has no email)
                        const { email: appEmail, isFallbackToReportee, employeeName, reporteeName } = resolveEmployeeEmail(applicant);
                        if (appEmail) toEmails.add(appEmail);

                        // 2. Manager Email (His Reportee/Supervisor) - only if not already added from fallback
                        if (applicant.primaryReportee) {
                            const { email: managerEmail } = resolveEmployeeEmail(applicant.primaryReportee);
                            if (managerEmail && !toEmails.has(managerEmail)) ccEmails.add(managerEmail);
                        }

                        if (creator?.companyEmail) {
                            const creatorEmail = String(creator.companyEmail).trim();
                            if (creatorEmail) ccEmails.add(creatorEmail);
                        }

                        try {
                            const hrHOD = await import("../../utils/getDepartmentHOD.js").then(m => m.getDepartmentHOD('hr', loan.employeeId));
                            addEmployeeEmailToSet(ccEmails, hrHOD);

                            const accountsHOD = await import("../../utils/getDepartmentHOD.js").then(m => m.getDepartmentHOD('finance', loan.employeeId));
                            addEmployeeEmailToSet(ccEmails, accountsHOD);

                            const managementHOD = await import("../../utils/getManagementHOD.js").then(m => m.getManagementHOD(loan.employeeId));
                            addEmployeeEmailToSet(ccEmails, managementHOD);
                        } catch (e) {
                            console.warn("[ApproveLoan] Could not fetch HOD emails for CC", e.message);
                        }

                        const toRecipients = Array.from(toEmails);
                        const ccRecipients = Array.from(ccEmails);

                        if (toRecipients.length > 0 || ccRecipients.length > 0) {
                            const { persistLoanApprovalAttachments, getLoanAcknowledgmentPdfBuffer } =
                                await import('../../utils/persistLoanApprovalAttachments.js');

                            await persistLoanApprovalAttachments(loan);
                            const pdfBuffer = await getLoanAcknowledgmentPdfBuffer(loan);
                            const typeSlug = loan.type === 'Advance' ? 'Advance' : 'Loan';
                            const ackFilename = `${typeSlug}_Acknowledgment_${loan.loanId || loan._id}.pdf`;

                            const mailOptions = {
                                from: `"VeRP Notification" <${emailUser}>`,
                                to: toRecipients,
                                cc: ccRecipients,
                                subject: `${typeSlug} Acknowledgment — Approved`,
                                html: `
                                     <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                                         <div style="background-color: #22c55e; color: white; padding: 20px; text-align: center;">
                                             <h2 style="margin: 0;">${typeSlug} Approved</h2>
                                         </div>
                                         <div style="padding: 30px; background-color: #ffffff;">
                                             ${isFallbackToReportee ? getFallbackEmailNote(employeeName, reporteeName) : ''}
                                             <p>Dear All,</p>
                                             <p>Please find attached the <strong>${typeSlug} Acknowledgment &amp; Salary Deduction Authorization</strong> for <strong>${applicant.firstName} ${applicant.lastName}</strong>, which has been <strong>fully approved</strong> by Management.</p>
                                             
                                             <div style="background-color: #f0fdfa; padding: 25px; border-radius: 10px; border-left: 4px solid #22c55e; margin: 25px 0;">
                                                 <table style="width: 100%; border-collapse: collapse;">
                                                     <tr>
                                                         <td style="padding: 6px 0; color: #166534; font-size: 13px; width: 40%;"><strong>Amount Approved:</strong></td>
                                                         <td style="padding: 6px 0; color: #14532d; font-size: 16px; font-weight: 800;">AED ${Number(loan.amount).toLocaleString()}</td>
                                                     </tr>
                                                     <tr>
                                                         <td style="padding: 6px 0; color: #166534; font-size: 13px;"><strong>Monthly Deduction:</strong></td>
                                                         <td style="padding: 6px 0; color: #14532d; font-size: 14px;">AED ${(Number(loan.amount) / Math.max(1, loan.duration)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                                     </tr>
                                                     <tr>
                                                         <td style="padding: 6px 0; color: #166534; font-size: 13px;"><strong>Approval Date:</strong></td>
                                                         <td style="padding: 6px 0; color: #14532d; font-size: 14px;">${new Date(loan.approvedDate || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                                                     </tr>
                                                 </table>
                                             </div>

                                             <p style="margin-top: 25px; color: #4b5563;">This acknowledgment has been shared with the Employee, HR, Accounts, and Management teams${loan.attachment?.url ? '. The original supporting documentation is also attached.' : '.'}</p>
                                             <p style="color: #4b5563;">Accounts will process <strong>payment to the employee</strong> next.</p>
                                             <p>Best Regards,<br><strong>VeRP System</strong></p>
                                          </div>
                                      </div>
                                  `,
                                attachments: pdfBuffer?.length > 500
                                    ? [{ filename: ackFilename, content: pdfBuffer, contentType: 'application/pdf' }]
                                    : [],
                            };

                            // Add original loan attachment if it exists
                            if (loan.attachment && (loan.attachment.url || loan.attachment.publicId)) {
                                try {
                                    const { getSignedFileUrl } = await import("../../utils/s3Upload.js");
                                    const axios = (await import("axios")).default;
                                    const refreshedUrl = await getSignedFileUrl(loan.attachment.publicId || loan.attachment.url);
                                    if (refreshedUrl) {
                                        console.log(`[ApproveLoan] Fetching original loan document from: ${refreshedUrl}`);
                                        const attResponse = await axios.get(refreshedUrl, {
                                            responseType: 'arraybuffer',
                                            timeout: 30000,
                                            maxContentLength: Infinity
                                        });

                                        mailOptions.attachments.push({
                                            filename: loan.attachment.name || 'Loan-Original-Documentation.pdf',
                                            content: Buffer.from(attResponse.data)
                                        });
                                        console.log(`[ApproveLoan] Success: Original loan attachment added to email.`);
                                    }
                                } catch (attErr) {
                                    console.error("[ApproveLoan] Failed to fetch original attachment:", attErr.message);
                                }
                            }

                            await transporter.sendMail(mailOptions);
                            console.log(`[ApproveLoan] Success email sent to ${toRecipients.length} TO and ${ccRecipients.length} CC recipients.`);
                        }
                    }
                } catch (emailErr) {
                    console.error("Employee Approval Email Error:", emailErr);
                }

                // Dedicated Accounts email: pay approved loan/advance to the employee
                if (needsAccountsDisbursement) {
                    try {
                        const { resolveLoanAccountsHod } = await import('../../utils/loanPaymentStatus.js');
                        const accountsHod =
                            paymentDueAccountsHod ||
                            (await resolveLoanAccountsHod(loan.employeeId));
                        const accountsEmail =
                            accountsHod?.companyEmail || accountsHod?.email || '';
                        if (accountsEmail) {
                            const typeSlug = loan.type === 'Advance' ? 'Advance' : 'Loan';
                            const applicantName = applicant
                                ? `${applicant.firstName || ''} ${applicant.lastName || ''}`.trim()
                                : loan.applicantName || 'Employee';
                            const payUrl = `${baseUrl}/HRM/LoanAndAdvance/${typeSlug}-${loan._id}`;
                            await transporter.sendMail({
                                from: `"VeRP Notification" <${emailUser}>`,
                                to: accountsEmail,
                                subject: `${typeSlug} Approved — Pay to Employee`,
                                html: `
                                    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                                        <div style="background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); color: white; padding: 25px; text-align: center;">
                                            <h2 style="margin: 0; font-size: 20px; font-weight: 800;">PAY TO EMPLOYEE</h2>
                                            <p style="margin: 5px 0 0 0; opacity: 0.85; font-size: 14px;">Reference: ${loan.loanId || loan._id}</p>
                                        </div>
                                        <div style="padding: 30px; background-color: #ffffff;">
                                            <p>Hello <strong>${accountsHod.firstName || 'Accounts'}</strong>,</p>
                                            <p>Management has approved this <strong>${typeSlug}</strong>. Please process <strong>payment to the employee</strong>.</p>
                                            <div style="background-color: #f0fdfa; padding: 25px; border-radius: 10px; border-left: 4px solid #0d9488; margin: 25px 0;">
                                                <table style="width: 100%; border-collapse: collapse;">
                                                    <tr>
                                                        <td style="padding: 6px 0; color: #64748b; font-size: 13px; width: 40%;"><strong>Employee:</strong></td>
                                                        <td style="padding: 6px 0; color: #1e293b; font-size: 14px; font-weight: 600;">${applicantName} (${loan.employeeId || '—'})</td>
                                                    </tr>
                                                    <tr>
                                                        <td style="padding: 6px 0; color: #64748b; font-size: 13px;"><strong>Amount:</strong></td>
                                                        <td style="padding: 6px 0; color: #0d9488; font-size: 16px; font-weight: 800;">AED ${Number(loan.amount).toLocaleString()}</td>
                                                    </tr>
                                                    <tr>
                                                        <td style="padding: 6px 0; color: #64748b; font-size: 13px;"><strong>Type:</strong></td>
                                                        <td style="padding: 6px 0; color: #1e293b; font-size: 14px;">${typeSlug}</td>
                                                    </tr>
                                                </table>
                                            </div>
                                            <p style="text-align: center; margin: 35px 0;">
                                                <a href="${payUrl}" style="background-color: #0d9488; color: white; padding: 14px 35px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Open &amp; Pay</a>
                                            </p>
                                        </div>
                                    </div>
                                `,
                            });
                            console.log(
                                `[ApproveLoan] Pay-to-employee email sent to Accounts (${accountsEmail}).`,
                            );
                        } else {
                            console.warn(
                                '[ApproveLoan] Accounts HOD has no email for pay-to-employee notice.',
                            );
                        }
                    } catch (payEmailErr) {
                        console.error(
                            '[ApproveLoan] Pay-to-employee Accounts email failed:',
                            payEmailErr?.message || payEmailErr,
                        );
                    }
                }
            }
            else if (finalStatus === 'Rejected') {
                // Notify Employee, Requester, and Previous Approvers on Rejection
                try {
                    const notificationIds = (loan.workflow || [])
                        .filter(w => w.status === 'Approved' && w.assignedTo)
                        .map(w => w.assignedTo.toString());

                    if (loan.createdBy) notificationIds.push(loan.createdBy.toString());

                    const [applicant, userObjects] = await Promise.all([
                        EmployeeBasic.findOne({ employeeId: loan.employeeId }).populate('primaryReportee').select('firstName lastName email companyEmail primaryReportee'),
                        User.find({ _id: { $in: notificationIds } }).select('email companyEmail')
                    ]);

                    if (applicant) {
                        const recipientEmails = new Set();

                        // 1. Add Applicant (fallback to primaryReportee when applicant has no email)
                        const { email: appEmail } = resolveEmployeeEmail(applicant);
                        if (appEmail) recipientEmails.add(appEmail);

                        // 2. Add Manager Email - only if not already added from fallback
                        if (applicant.primaryReportee) {
                            const managerEmail = applicant.primaryReportee.companyEmail || applicant.primaryReportee.email;
                            if (managerEmail && !recipientEmails.has(managerEmail)) recipientEmails.add(managerEmail);
                        }

                        // 3. Add Previous Approvers & Requester
                        if (userObjects && userObjects.length > 0) {
                            userObjects.forEach(u => {
                                const mail = u.companyEmail || u.email;
                                if (mail) recipientEmails.add(mail);
                            });
                        }

                        if (recipientEmails.size > 0) {
                            const mailOptions = {
                                from: `"VeRP Notification" <${emailUser}>`,
                                to: Array.from(recipientEmails).join(', '),
                                subject: `Update regarding your ${loan.type || 'Loan'} Application`,
                                html: `
                                    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                                        <div style="background-color: #ef4444; color: white; padding: 20px; text-align: center;">
                                            <h2 style="margin: 0;">Loan Application Update</h2>
                                        </div>
                                        <div style="padding: 30px;">
                                            <p>Dear All,</p>
                                            <p>The <strong>${loan.type || 'Loan/Advance'}</strong> application for <strong>${loan.applicantName}</strong> (AED ${Number(loan.amount).toLocaleString()}) has been <strong>Rejected</strong>.</p>
                                            <div style="background-color: #fef2f2; padding: 15px; border-radius: 6px; border: 1px solid #fee2e2; margin: 20px 0;">
                                                <p style="margin: 0;"><strong>Reason for Rejection:</strong> ${loan.rejectionReason}</p>
                                            </div>
                                            <p>If you have any questions, please contact the HR department.</p>
                                            <br>
                                            <p>Best Regards,</p>
                                            <p>VeRP System</p>
                                        </div>
                                    </div>
                                `
                            };
                            await transporter.sendMail(mailOptions);
                            console.log(`[ApproveLoan] Rejection email sent to ${recipientEmails.size} recipients`);
                        }
                    }
                } catch (emailErr) {
                    console.error("Loan Rejection Email Error:", emailErr);
                }
            }
        }

        await loan.save();

        res.status(200).json({ message: `Loan ${finalStatus === 'Pending Authorization' ? 'submitted for authorization' : status.toLowerCase()}`, loan });

    } catch (error) {
        console.error("Error approving loan:", error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: "Invalid loan ID format" });
        }
        res.status(500).json({ message: "Internal server error" });
    }
};
