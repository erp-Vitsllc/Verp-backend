import { generatePdf } from "../../utils/generatePdf.js";
import Loan from "../../models/Loan.js";
import User from "../../models/User.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import nodemailer from "nodemailer";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { sendHODAuthorizationEmail } from "../../utils/sendHODAuthorizationEmail.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";

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

            const applicant = await EmployeeBasic.findOne({ employeeId: loan.employeeId }).populate('primaryReportee');
            if (!applicant?.primaryReportee) {
                return res.status(400).json({ message: "Reporting manager not assigned. Please contact HR." });
            }

            publicStatus = 'Pending';
            nextStage = 'Pending';
            nextApprover = applicant.primaryReportee;

            // Define nextAssignmentId here
            const nextUser = await User.findOne({ employeeId: nextApprover.employeeId });
            const nextAssignmentId = nextUser ? nextUser._id : nextApprover._id;

            emailSubject = "New Loan/Advance Request for Review";
            emailType = "Manager";

            // Set initial workflow
            loan.workflow = [{
                role: 'Manager',
                assignedTo: nextAssignmentId,
                status: 'Pending',
                assignedAt: new Date()
            }];

            console.log(`[ApproveLoan] Draft -> Pending transition for Manager: ${nextApprover.employeeId}`);
        }
        else if (status === 'Approved') {
            // APPROVAL LOGIC
            if (isAdmin) {
                publicStatus = 'Approved';
                nextStage = 'Approved';
            } else if (approverBasic) {

                // 1. MANAGER STAGE (Pending -> Pending HR)
                if (currentStage === 'Pending') {
                    // Check if approver is the manager
                    const applicant = await EmployeeBasic.findOne({ employeeId: loan.employeeId }).populate('primaryReportee');
                    // NEW: Robust identity check (ID or Email)
                    const isReporteeManager = applicant?.primaryReportee?._id?.toString() === approverBasic._id.toString();
                    const reporterEmail = applicant?.primaryReportee?.companyEmail || applicant?.primaryReportee?.email;
                    const approverEmail = approverBasic.companyEmail || approverBasic.email;
                    const isEmailMatch = reporterEmail && approverEmail && reporterEmail.toLowerCase() === approverEmail.toLowerCase();

                    if (isReporteeManager || isEmailMatch) {
                        nextStage = 'Pending HR';
                        publicStatus = 'Pending'; // Keep visible status as Pending for HR

                        loan.managerApprovedBy = approverBasic._id;
                        nextApprover = await getDepartmentHOD('hr', loan.employeeObjectId);
                        console.log('[Loan]', loan.loanId, 'Manager Approved. Next HR Approver:', nextApprover ? `${nextApprover.firstName} ${nextApprover.lastName}` : 'NOT FOUND');
                        emailSubject = "Loan Pending HR Approval";
                        emailType = "HR";
                    } else {
                        return res.status(403).json({ message: "Only the reporting manager can approve at this stage" });
                    }
                }
                // 2. HR STAGE (Pending HR -> Pending Accounts)
                else if (currentStage === 'Pending HR') {
                    const isHR = approverBasic.department && /human resource|hr|hrm/i.test(approverBasic.department) || (approverBasic.designation && /hr/i.test(approverBasic.designation));
                    const isAssignedHR = loan.submittedTo && (String(loan.submittedTo) === String(requestingUserId) || String(loan.submittedTo) === String(approverBasic._id));

                    if (isHR || isAssignedHR || isAdmin) {
                        nextStage = 'Pending Accounts';
                        publicStatus = 'Pending'; // Keep visible status as Pending for Accounts

                        loan.hrApprovedBy = approverBasic._id;
                        nextApprover = await getDepartmentHOD('finance', loan.employeeObjectId);
                        console.log('[Loan]', loan.loanId, 'HR Approved. Next Finance Approver:', nextApprover ? `${nextApprover.firstName} ${nextApprover.lastName}` : 'NOT FOUND');
                        emailSubject = "Loan Pending Finance Approval";
                        emailType = "Accounts";
                    } else {
                        return res.status(403).json({ message: "Only HR can approve at this stage" });
                    }
                }
                // 3. ACCOUNTS STAGE (Pending Accounts -> Pending Authorization)
                else if (currentStage === 'Pending Accounts') {
                    const isFinance = approverBasic.department && /finance|accounts|payroll/i.test(approverBasic.department) || (approverBasic.designation && /account/i.test(approverBasic.designation));
                    const isAssignedFinance = loan.submittedTo && (String(loan.submittedTo) === String(requestingUserId) || String(loan.submittedTo) === String(approverBasic._id));

                    if (isFinance || isAssignedFinance || isAdmin) {
                        nextStage = 'Pending Authorization';
                        publicStatus = 'Pending'; // Keep visible status as Pending for CEO

                        loan.accountsApprovedBy = approverBasic._id;
                        nextApprover = await getManagementHOD(loan.employeeObjectId);
                        console.log('[Loan]', loan.loanId, 'Finance Approved. Next Management:', nextApprover ? `${nextApprover.firstName} ${nextApprover.lastName}` : 'NOT FOUND');
                        emailSubject = "Loan Pending Final Authorization";
                        emailType = "Management";
                    } else {
                        return res.status(403).json({ message: "Only Finance/Accounts can approve at this stage" });
                    }
                }
                // 4. Management STAGE (Pending Authorization -> Approved)
                else if (currentStage === 'Pending Authorization') {
                    const isManagement = approverBasic.department && /management/i.test(approverBasic.department) &&
                        ['ceo', 'c.e.o', 'c.e.o.', 'chief executive officer', 'director', 'managing director', 'general manager', 'gm', 'g.m', 'g.m.'].includes(approverBasic.designation?.toLowerCase());

                    if (isManagement) {
                        nextStage = 'Approved';
                        publicStatus = 'Approved'; // Final Approval
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

        if (finalStatus === 'Approved' && nextStage === 'Approved') {
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
                // 1. Manager Step (Approved)
                if (!loan.workflow) loan.workflow = [];
                const managerEntry = loan.workflow.find(w =>
                    w.status === 'Pending' &&
                    (w.role === 'Manager' || w.assignedTo?.toString() === approverBasic?._id?.toString() || w.assignedTo?.toString() === userObj?._id?.toString())
                );

                if (managerEntry) {
                    managerEntry.status = 'Approved';
                    managerEntry.actionedAt = new Date();
                    if (!managerEntry.role) managerEntry.role = 'Manager';
                } else {
                    // Fallback
                    const managerUser = await User.findOne({ employeeId: approverBasic?.employeeId });
                    loan.workflow.push({
                        role: 'Manager',
                        assignedTo: managerUser ? managerUser._id : (approverBasic ? approverBasic._id : requestingUserId),
                        status: 'Approved',
                        assignedAt: loan.createdAt,
                        actionedAt: new Date()
                    });
                }

                // 2. HR Step (Pending)
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

        // Final Approval (Management) Update
        if (nextStage === 'Approved') {
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
        const isFinalStatus = finalStatus === 'Approved' || finalStatus === 'Rejected';
        await syncDashboardAction({
            requestId: loan._id,
            requestType: 'Loan',
            // Specifically clear the acting user's task
            assignedTo: isFinalStatus ? null : req.user?._id,
            status: isFinalStatus ? finalStatus : 'Approved',
            subjectEmployee: applicant
        });

        // B. If there's a next approver, create a new pending action for them
        if (nextApprover && (nextStage.includes('Pending') || nextStage === 'Pending')) {
            await syncDashboardAction({
                requestId: loan._id,
                requestType: 'Loan',
                assignedTo: nextApprover._id,
                status: 'Pending',
                subjectEmployee: applicant,
                extra1: `AED ${loan.amount}`,
                extra2: `${loan.duration} Months`
            });
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
            const baseUrl = process.env.FRONTEND_URL || origin || "http://localhost:3000";
            const typeSlug = loan.type ? loan.type.replace(/\s+/g, '-') : 'Loan';
            const actionUrl = `${baseUrl}/HRM/LoanAndAdvance/${typeSlug}-${loan._id}`;

            // 1. Notify Next Approver
            if (nextApprover && (nextApprover.companyEmail || nextApprover.email)) {
                try {
                    let htmlContent = "";

                    if (emailType === "Manager") {
                        // High quality template for Manager (matches requestLoan.js)
                        const applicantName = loan.applicantName;
                        const type = loan.type || 'Loan/Advance';
                        const amount = loan.amount;
                        const duration = loan.duration;
                        const reason = loan.reason;
                        const employeeId = loan.employeeId;

                        htmlContent = `
                            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                                <div style="background-color: #0d9488; color: white; padding: 20px; text-align: center;">
                                    <h2 style="margin: 0;">${type} Application Review</h2>
                                </div>
                                <div style="padding: 30px;">
                                    <p>Hello <strong>${nextApprover.firstName}</strong>,</p>
                                    <p><strong>${applicantName}</strong> has submitted a request for ${type} (previously saved as Draft).</p>
                                    
                                    <div style="background-color: #f0fdfa; padding: 20px; border-radius: 8px; border: 1px solid #ccfbf1; margin: 25px 0;">
                                        <p style="margin: 0;"><strong>Employee:</strong> ${applicantName} (${employeeId})</p>
                                        <p style="margin: 8px 0 0 0;"><strong>Type:</strong> ${type}</p>
                                        <p style="margin: 8px 0 0 0;"><strong>Amount:</strong> AED ${Number(amount).toLocaleString()}</p>
                                        <p style="margin: 8px 0 0 0;"><strong>Duration:</strong> ${duration} Months</p>
                                        <p style="margin: 8px 0 0 0;"><strong>Reason:</strong> ${reason}</p>
                                    </div>
                                    
                                    <p style="text-align: center; margin: 35px 0;">
                                        <a href="${actionUrl}" style="background-color: #0d9488; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 16px;">View Request</a>
                                    </p>
                                </div>
                            </div>
                        `;
                    } else {
                        // Standard template for HR/Finance/CEO
                        htmlContent = `
                            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                                <div style="background-color: #f59e0b; color: white; padding: 20px; text-align: center;">
                                    <h2 style="margin: 0;">Action Required: ${emailSubject}</h2>
                                </div>
                                <div style="padding: 30px;">
                                    <p>Dear ${nextApprover.firstName},</p>
                                    <p>A loan application requires your review at the <strong>${emailType}</strong> stage.</p>
                                    <p><strong>Applicant:</strong> ${loan.applicantName}</p>
                                    <p><strong>Amount:</strong> AED ${Number(loan.amount).toLocaleString()}</p>
                                    <div style="text-align: center; margin: 30px 0;">
                                        <a href="${actionUrl}" style="background-color: #f59e0b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">Review Application</a>
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

            // 2. Notify Employee on FULL Approval ONLY
            if (finalStatus === 'Approved' && nextStage === 'Approved') {
                try {
                    const applicant = await EmployeeBasic.findOne({ employeeId: loan.employeeId }).populate('primaryReportee');
                    const creator = await User.findById(loan.createdBy);

                    if (applicant) {
                        const recipientEmails = new Set();

                        // 1. Applicant Email
                        const appEmail = applicant.companyEmail || applicant.email;
                        if (appEmail) recipientEmails.add(appEmail);

                        // 2. Manager Email (His Reportee/Supervisor)
                        if (applicant.primaryReportee) {
                            const managerEmail = applicant.primaryReportee.companyEmail || applicant.primaryReportee.email;
                            if (managerEmail) recipientEmails.add(managerEmail);
                        }

                        // 3. Creator Email
                        if (creator) {
                            const creatorEmail = creator.companyEmail || creator.email;
                            if (creatorEmail) recipientEmails.add(creatorEmail);
                        }

                        if (recipientEmails.size > 0) {
                            const permissions = { hrm_loan: { isView: true, isActive: true } };
                            const pdfBuffer = await generatePdf(actionUrl, req.headers.authorization?.split(' ')[1], { id: requestingUserId, isAdmin: isAdmin, role: userObj.role, employeeId: userObj.employeeId }, permissions);

                            const mailOptions = {
                                from: `"VeRP Notification" <${emailUser}>`,
                                to: Array.from(recipientEmails).join(', '),
                                subject: "Loan Application Approved",
                                html: `
                                    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                                        <div style="background-color: #22c55e; color: white; padding: 20px; text-align: center;">
                                            <h2 style="margin: 0;">Congratulations!</h2>
                                        </div>
                                        <div style="padding: 30px;">
                                            <p>Dear All,</p>
                                            <p>The loan application for <strong>${applicant.firstName} ${applicant.lastName}</strong> (AED ${Number(loan.amount).toLocaleString()}) has been fully approved by all departments including HR, Finance, and Management.</p>
                                            <p>Please find the approved document attached.</p>
                                            <br>
                                            <p>Best Regards,</p>
                                            <p>VeRP System</p>
                                        </div>
                                    </div>
                                `,
                                attachments: [{ filename: `Approved_Loan_${loan.loanId || loan._id}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
                            };
                            await transporter.sendMail(mailOptions);
                            console.log(`[ApproveLoan] Success email sent to ${recipientEmails.size} recipients: ${Array.from(recipientEmails).join(', ')}`);
                        }
                    }
                } catch (emailErr) {
                    console.error("Employee Approval Email Error:", emailErr);
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
                        EmployeeBasic.findOne({ employeeId: loan.employeeId }).select('firstName lastName email companyEmail'),
                        User.find({ _id: { $in: notificationIds } }).select('email companyEmail')
                    ]);

                    if (applicant) {
                        const recipientEmails = new Set();

                        // Add Applicant
                        const appEmail = applicant.companyEmail || applicant.email;
                        if (appEmail) recipientEmails.add(appEmail);

                        // Add Previous Approvers & Requester
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

        res.status(200).json({ message: `Loan ${finalStatus === 'Pending Authorization' ? 'submitted for authorization' : status.toLowerCase()}`, loan });

    } catch (error) {
        console.error("Error approving loan:", error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: "Invalid loan ID format" });
        }
        res.status(500).json({ message: "Internal server error" });
    }
};
