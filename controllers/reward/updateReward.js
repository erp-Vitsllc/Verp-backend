import Reward from "../../models/Reward.js";
import { resolveFrontendBaseUrl, emailFrontendUrl } from '../../utils/resolveFrontendBaseUrl.js';
import EmployeeBasic from "../../models/EmployeeBasic.js";
import Company from "../../models/Company.js";
import User from "../../models/User.js";
import nodemailer from "nodemailer";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { sendHODAuthorizationEmail } from "../../utils/sendHODAuthorizationEmail.js";
import { generatePdf } from "../../utils/generatePdf.js";
import { ensureAttachmentPersistedToS3 } from "../../utils/s3Upload.js";
import { resolveEmployeeEmail, getFallbackEmailNote, addEmployeeEmailToSet } from "../../utils/resolveEmployeeEmail.js";
import { isUsernameSystemSuperUser, isReqUserSystemSuperUser } from "../../utils/systemSuperUser.js";

export const updateReward = async (req, res) => {
    try {
        console.log("[UpdateReward] Hit. Params:", req.params, "Body:", req.body);
        const { id } = req.params;
        const {
            employeeId,
            rewardType,
            rewardStatus,
            amount,
            description,
            awardedDate,
            remarks,
            title,
            employeeName,
            certHeader,
            certSubHeader,
            certPresentationText,
            certSigner1Name,
            certSigner1Title,
            certSigner2Name,
            certSigner2Title,
            attachment
        } = req.body;

        const reward = await Reward.findById(id);
        if (!reward) {
            return res.status(404).json({ message: "Reward not found" });
        }

        const approvedStatuses = new Set(['Approved', 'Approved (Paid)', 'Paid', 'Completed', 'Active']);
        const certFieldsProvided = [
            title,
            employeeName,
            certHeader,
            certSubHeader,
            certPresentationText,
            certSigner1Name,
            certSigner1Title,
            certSigner2Name,
            certSigner2Title,
        ].some((v) => v !== undefined);
        if (certFieldsProvided && approvedStatuses.has(String(reward.rewardStatus || '').trim())) {
            const isSysAdmin = await isReqUserSystemSuperUser(req.user);
            if (!isSysAdmin) {
                return res.status(403).json({
                    message: 'Only system administrators can edit the certificate after the reward is approved.',
                });
            }
        }

        // If employeeId is being updated, verify employee exists and update name
        if (employeeId && employeeId !== reward.employeeId) {
            const employee = await EmployeeBasic.findOne({ employeeId }).select('firstName lastName employeeId').lean();
            if (!employee) {
                return res.status(404).json({ message: "Employee not found" });
            }
            reward.employeeId = employeeId;
            reward.employeeName = `${employee.firstName} ${employee.lastName}`;
        }

        // Update basic fields immediately
        if (rewardType) reward.rewardType = rewardType;
        if (amount !== undefined) reward.amount = amount;
        if (description !== undefined) reward.description = description;
        if (awardedDate) reward.awardedDate = new Date(awardedDate);
        if (remarks !== undefined) reward.remarks = remarks;

        // Update certificate fields immediately
        if (title !== undefined) reward.title = title;
        if (employeeName !== undefined) reward.employeeName = employeeName;
        if (certHeader !== undefined) reward.certHeader = certHeader;
        if (certSubHeader !== undefined) reward.certSubHeader = certSubHeader;
        if (certPresentationText !== undefined) reward.certPresentationText = certPresentationText;
        if (certSigner1Name !== undefined) reward.certSigner1Name = certSigner1Name;
        if (certSigner1Title !== undefined) reward.certSigner1Title = certSigner1Title;
        if (certSigner2Name !== undefined) reward.certSigner2Name = certSigner2Name;
        if (certSigner2Title !== undefined) reward.certSigner2Title = certSigner2Title;

        // Handle attachment for update/resubmit
        if (attachment && attachment.data) {
            try {
                console.log(`[UpdateReward] Processing attachment: ${attachment.name}`);
                reward.attachment = await ensureAttachmentPersistedToS3(attachment, {
                    folder: `rewards/${reward.employeeId}`,
                    fileName: attachment.name || 'reward-attachment.pdf',
                    resourceType: 'raw',
                });
                console.log(`[UpdateReward] Attachment updated in S3: ${reward.attachment?.publicId}`);
            } catch (uploadError) {
                console.error('[UpdateReward] Attachment upload failed:', uploadError);
                return res.status(500).json({
                    message: 'Failed to store attachment in storage. Please try uploading again.',
                });
            }
        }

        // Handle explicit approver fields from frontend
        if (req.body.hrApprovedBy) reward.hrApprovedBy = req.body.hrApprovedBy;
        if (req.body.accountsApprovedBy) reward.accountsApprovedBy = req.body.accountsApprovedBy;
        if (req.body.approvedBy) reward.approvedBy = req.body.approvedBy;

        if (rewardStatus !== undefined) {
            // Rejection mandatory reason check
            if (rewardStatus === 'Rejected' && (!remarks || remarks.trim().length === 0)) {
                return res.status(400).json({ message: "Reason for rejection is mandatory (Please fill in Remarks)." });
            }
            // === NEW APPROVAL LOGIC ===
            let finalStatus = rewardStatus;
            const currentStatus = reward.rewardStatus;
            let approverDetails = null;

            console.log(`[UpdateReward] Status Change Request: ${currentStatus} -> ${rewardStatus}`);

            // === RESUBMIT LOGIC ===
            if (req.body.resubmit && currentStatus === 'Rejected') {
                console.log("[UpdateReward] Resubmitting previously rejected reward.");
                const rejectedStep = (reward.workflow || []).find(w => w.status === 'Rejected');
                if (rejectedStep) {
                    // Reset the rejected step to Pending
                    rejectedStep.status = 'Pending';
                    rejectedStep.actionedAt = null;
                    if (remarks) rejectedStep.comment = `RESUBMITTED: ${remarks}`;

                    // Map the rejected role to the equivalent internal stage
                    const roleMap = {
                        'Manager': 'Pending',
                        'Reportee': 'Pending',
                        'Primary Reportee': 'Pending',
                        'Accounts': 'Pending Accounts',
                        'Management': 'Pending Authorization'
                    };

                    finalStatus = roleMap[rejectedStep.role] || 'Pending';
                    reward.approvalStatus = finalStatus;
                    reward.rewardStatus = 'Pending';
                    reward.submittedTo = rejectedStep.assignedTo;

                    console.log(`[UpdateReward] Resubmitting: Role=${rejectedStep.role} -> TargetStage=${finalStatus} -> AssignedTo=${reward.submittedTo}`);

                    // === RESUBMIT EMAIL NOTIFICATION ===
                    try {
                        const User = (await import("../../models/User.js")).default;
                        const nodemailer = (await import("nodemailer")).default;
                        const targetUser = await User.findById(reward.submittedTo).select('email companyEmail name username');

                        if (targetUser && (targetUser.email || targetUser.companyEmail)) {
                            const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
                            const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

                            if (emailUser && emailPass) {
                                let smtpHost = (emailUser.includes('@gmail.com') || process.env.GMAIL_USER) ? "smtp.gmail.com" : "smtp.office365.com";
                                const transporter = nodemailer.createTransport({
                                    host: smtpHost,
                                    port: 587,
                                    secure: false,
                                    auth: { user: emailUser, pass: emailPass }
                                });

                                const baseUrl = resolveFrontendBaseUrl();
                                const rewardUrl = `${baseUrl}/HRM/Reward/${reward._id}`;
                                const empName = reward.employeeName || "Employee";

                                const mailOptions = {
                                    from: `"VeRP Notification" <${emailUser}>`,
                                    to: targetUser.companyEmail || targetUser.email,
                                    subject: `Resubmitted Reward Request: ${reward.rewardType} - ${empName}`,
                                    html: `
                                        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
                                            <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-bottom: 1px solid #eee;">
                                                <h2 style="margin: 0; color: #1a2e35;">Reward Resubmitted</h2>
                                            </div>
                                            <div style="padding: 20px;">
                                                <p>Hello ${targetUser.name || targetUser.username},</p>
                                                <p>The reward request for <strong>${empName}</strong> has been resubmitted after your previous rejection.</p>
                                                <p><strong>Remarks from Requester:</strong> ${remarks || 'No remarks provided'}</p>
                                                <div style="text-align: center; margin-top: 30px; margin-bottom: 30px;">
                                                    <a href="${rewardUrl}" style="background-color: #007bff; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Review Resubmission</a>
                                                </div>
                                            </div>
                                        </div>
                                    `,
                                    attachments: []
                                };

                                if (reward.attachment && reward.attachment.url) {
                                    mailOptions.attachments.push({
                                        filename: reward.attachment.name || 'Reward-Attachment.pdf',
                                        path: reward.attachment.url
                                    });
                                }

                                await transporter.sendMail(mailOptions);
                                console.log(`[UpdateReward] Resubmit email sent to ${targetUser.email || targetUser.companyEmail}`);
                            }
                        }
                    } catch (mailErr) {
                        console.error("[UpdateReward] Failed to send resubmit email:", mailErr);
                    }
                }
            }


            // === SUBMIT FROM DRAFT LOGIC ===
            if (finalStatus === 'Pending' && reward.rewardStatus === 'Draft') {
                console.log("[UpdateReward] Submitting Draft Reward. Identifying Manager...");

                // Find Requester's Manager (Reportee)
                const employeeForSnapshot = await EmployeeBasic.findOne({ employeeId: reward.employeeId })
                    .select('primaryReportee employeeId firstName lastName department designation company')
                    .lean();

                if (employeeForSnapshot && !employeeForSnapshot.company) {
                    return res.status(400).json({ message: "Employee is not linked to any company. Cannot submit reward request." });
                }

                if (employeeForSnapshot && !employeeForSnapshot.primaryReportee) {
                    return res.status(400).json({ message: "Employee has no Primary Reportee assigned. Please assign a manager first." });
                }

                if (employeeForSnapshot && employeeForSnapshot.primaryReportee) {
                    const managerBasic = await EmployeeBasic.findById(employeeForSnapshot.primaryReportee)
                        .select('employeeId companyEmail email workEmail firstName lastName')
                        .lean();

                    if (managerBasic) {
                        let reporteeUser = null;
                        // Try to find Manager's User Account
                        if (managerBasic.employeeId) {
                            if (req.user && req.user.employeeId === managerBasic.employeeId) {
                                reporteeUser = req.user;
                            } else {
                                reporteeUser = await User.findOne({ employeeId: managerBasic.employeeId });
                            }
                        }
                        if (!reporteeUser && (managerBasic.companyEmail || managerBasic.email)) {
                            const email = managerBasic.companyEmail || managerBasic.email;
                            reporteeUser = await User.findOne({ $or: [{ email }, { username: email }] });
                        }

                        if (reporteeUser) {
                            console.log(`[UpdateReward] Found Manager: ${reporteeUser.name || reporteeUser.username || reporteeUser.email} (${reporteeUser._id})`);
                            reward.submittedTo = reporteeUser._id;
                            reward.approvalStatus = 'Pending';

                            const isCashOrGift = reward.rewardType === 'Cash Reward' || reward.rewardType === 'Gift Reward';

                            // Resolve Company String ID for HOD utilities
                            let resolvedCompanyIdForSnapshot = employeeForSnapshot.company;
                            if (!resolvedCompanyIdForSnapshot) {
                                const creator = await User.findById(req.user?.id).select('employeeId');
                                if (creator?.employeeId) {
                                    const creatorEmp = await EmployeeBasic.findOne({ employeeId: creator.employeeId }).select('company');
                                    if (creatorEmp?.company) resolvedCompanyIdForSnapshot = creatorEmp.company;
                                }
                            }

                            let hodContext = reward.employeeId;
                            if (resolvedCompanyIdForSnapshot) {
                                const companyObj = await Company.findById(resolvedCompanyIdForSnapshot).select('companyId');
                                if (companyObj?.companyId) hodContext = companyObj.companyId;
                            }

                            let finalRecipients = [];

                            // NEXT PERSON LOGIC: If the manager is the one submitting, move to Management next
                            if (reporteeUser._id.toString() === req.user?._id?.toString()) {
                                console.log("[UpdateReward] Submitter is the Manager. Moving to Management.");

                                let nextTarget = null;
                                let nextTargetRole = null;

                                const managementHOD = await getManagementHOD(hodContext);
                                if (managementHOD) {
                                    const managementUser = await User.findOne({ employeeId: managementHOD.employeeId });
                                    if (managementUser) {
                                        nextTarget = managementUser;
                                        nextTargetRole = 'Management';
                                        finalRecipients.push({
                                            email: managementHOD.companyEmail || managementHOD.email || managementUser.companyEmail || managementUser.email,
                                            name: `${managementHOD.firstName} ${managementHOD.lastName}`,
                                            role: 'Management (Manager)'
                                        });
                                    }
                                }

                                if (nextTarget) {
                                    reward.submittedTo = nextTarget._id;
                                    finalStatus = 'Pending Authorization';
                                    reward.workflow = [
                                        { role: 'Manager', assignedTo: req.user._id, status: 'Approved', assignedAt: new Date(), actionedAt: new Date() },
                                        { role: nextTargetRole || 'Management', assignedTo: nextTarget._id, status: 'Pending', assignedAt: new Date() }
                                    ];
                                    if (isCashOrGift) {
                                        const accountsHOD = await getDepartmentHOD('accounts', hodContext);
                                        if (accountsHOD) {
                                            const accountsUser = await User.findOne({ employeeId: accountsHOD.employeeId });
                                            if (accountsUser) {
                                                reward.workflow.push({
                                                    role: 'Accounts',
                                                    assignedTo: accountsUser._id,
                                                    status: 'Draft',
                                                    assignedAt: new Date()
                                                });
                                            }
                                        }
                                    }
                                } else {
                                    reward.submittedTo = reporteeUser._id;
                                    reward.workflow = [{ role: 'Manager', assignedTo: reporteeUser._id, status: 'Pending', assignedAt: new Date() }];
                                    finalRecipients.push({
                                        email: managerBasic.companyEmail || managerBasic.email || reporteeUser.companyEmail || reporteeUser.email,
                                        name: `${managerBasic.firstName} ${managerBasic.lastName}`,
                                        role: 'Primary Reportee'
                                    });
                                }
                            } else {
                                reward.submittedTo = reporteeUser._id;
                                reward.workflow = [{ role: 'Manager', assignedTo: reporteeUser._id, status: 'Pending', assignedAt: new Date() }];
                                finalRecipients.push({
                                    email: managerBasic.companyEmail || managerBasic.email || reporteeUser.companyEmail || reporteeUser.email,
                                    name: `${managerBasic.firstName} ${managerBasic.lastName}`,
                                    role: 'Primary Reportee'
                                });

                                // Tracker steps wait as Draft until their turn (Management before Accounts)
                                const managementHOD = await getManagementHOD(hodContext);
                                if (managementHOD) {
                                    const managementUser = await User.findOne({ employeeId: managementHOD.employeeId });
                                    if (managementUser) {
                                        reward.workflow.push({
                                            role: 'Management',
                                            assignedTo: managementUser._id,
                                            status: 'Draft',
                                            assignedAt: new Date()
                                        });
                                    }
                                }
                                if (isCashOrGift) {
                                    const accountsHOD = await getDepartmentHOD('accounts', hodContext);
                                    if (accountsHOD) {
                                        const accountsUser = await User.findOne({ employeeId: accountsHOD.employeeId });
                                        if (accountsUser) {
                                            reward.workflow.push({ role: 'Accounts', assignedTo: accountsUser._id, status: 'Draft', assignedAt: new Date() });
                                        }
                                    }
                                }
                            }

                            // Send Email Notifications
                            const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
                            const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

                            if (emailUser && emailPass && finalRecipients.length > 0) {
                                try {
                                    const smtpHost = (emailUser.includes('@gmail') || process.env.GMAIL_USER) ? "smtp.gmail.com" : "smtp.office365.com";
                                    const transporter = nodemailer.createTransport({
                                        host: smtpHost,
                                        port: 587,
                                        secure: false,
                                        auth: { user: emailUser, pass: emailPass }
                                    });

                                    const baseUrl = resolveFrontendBaseUrl();
                                    const rewardUrl = `${baseUrl}/HRM/Reward/${reward._id}`;
                                    const empNameForEmail = reward.employeeName;

                                    for (const recipient of finalRecipients) {
                                        await transporter.sendMail({
                                            from: `"VeRP System" <${emailUser}>`,
                                            to: recipient.email,
                                            subject: `Reward Approval Request: ${reward.rewardType} - ${empNameForEmail}`,
                                            html: `
                                                <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
                                                    <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-bottom: 1px solid #eee;">
                                                        <h2 style="margin: 0; color: #1a2e35;">Request for Reward Approval</h2>
                                                    </div>
                                                    <div style="padding: 20px;">
                                                        <p>Dear <strong>${recipient.name}</strong> (${recipient.role}),</p>
                                                        <p>A formal request for a <strong>${reward.rewardType}</strong> has been initiated for the following employee:</p>
                                                        <div style="background-color: #fce4ec; border-left: 4px solid #d81b60; padding: 15px; margin: 20px 0; border-radius: 4px;">
                                                            <p style="margin: 5px 0;"><strong>Employee Name:</strong> ${empNameForEmail}</p>
                                                            <p style="margin: 5px 0;"><strong>Employee ID:</strong> ${employeeForSnapshot.employeeId}</p>
                                                            <p style="margin: 5px 0;"><strong>Department:</strong> ${employeeForSnapshot.department || 'N/A'}</p>
                                                            <p style="margin: 5px 0;"><strong>Designation:</strong> ${employeeForSnapshot.designation || 'N/A'}</p>
                                                            <p style="margin: 5px 0;"><strong>Reward Type:</strong> ${reward.rewardType}</p>
                                                        </div>
                                                        <p>Kindly review the details and take appropriate action.</p>
                                                        <div style="text-align: center; margin-top: 30px; margin-bottom: 30px;">
                                                            <a href="${rewardUrl}" style="background-color: #007bff; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Review Request</a>
                                                        </div>
                                                    </div>
                                                </div>
                                            `
                                        });
                                    }
                                    console.log("Approval Emails Sent");
                                } catch (e) {
                                    console.error("Email Error:", e);
                                }
                            }
                        }
                    }
                }
            }

            if (rewardStatus === 'Approved' || rewardStatus === 'Pending Authorization' || rewardStatus === 'Pending HR' || rewardStatus === 'Pending Accounts') {
                // Identify Approver
                let approverBasic = null;
                const approverUserId = req.user?.id;

                console.log("[UpdateReward] Approver Logic Start. UserID:", approverUserId, "Target Status:", rewardStatus);


                // Get Approver Employee Profile
                if (approverUserId) {
                    // Check if Admin
                    const userObj = await User.findById(approverUserId);
                    const isAdmin = isUsernameSystemSuperUser(userObj?.username);

                    if (isAdmin) {
                        approverDetails = { name: 'Admin', designation: 'Administrator', isAdmin: true };
                        console.log("[UpdateReward] Approver is Admin");
                    } else {
                        // Find Employee using linked employeeId
                        if (userObj?.employeeId) {
                            approverBasic = await EmployeeBasic.findOne({ employeeId: userObj.employeeId });
                        }

                        // Fallback Match by email if needed
                        if (!approverBasic && (userObj?.email || userObj?.companyEmail)) {
                            approverBasic = await EmployeeBasic.findOne({
                                $or: [
                                    { companyEmail: userObj.companyEmail },
                                    { email: userObj.email }
                                ]
                            });
                        }

                        console.log("[UpdateReward] Approver Employee Found:", approverBasic ? `${approverBasic.firstName} (${approverBasic.employeeId})` : 'NO - Using Fallback');
                    }
                }

                if (!approverDetails && approverBasic) {
                    approverDetails = {
                        name: `${approverBasic.firstName} ${approverBasic.lastName}`,
                        designation: approverBasic.designation,
                        department: approverBasic.department,
                        email: approverBasic.companyEmail,
                        id: approverBasic._id
                    };


                    // Check Management Validity (Dynamic - from Company Responsibilities)
                    const targetManagementHOD = await getManagementHOD(reward.employeeId);
                    const isManagement = targetManagementHOD && targetManagementHOD._id.toString() === approverBasic._id.toString();

                    // Check HR Validity (Dynamic)
                    const targetHRHOD = await getDepartmentHOD('hr', reward.employeeId);
                    const isHR = targetHRHOD && targetHRHOD._id.toString() === approverBasic._id.toString();

                    // Check Accounts Validity (Dynamic)
                    const targetAccountsHOD = await getDepartmentHOD('accounts', reward.employeeId);
                    const isAccounts = targetAccountsHOD && targetAccountsHOD._id.toString() === approverBasic._id.toString();

                    // Check Reportee Status (of the reward receiver)
                    const rewardReceiver = await EmployeeBasic.findOne({ employeeId: reward.employeeId }).populate('primaryReportee');
                    let isReporteeManager = false;
                    if (rewardReceiver && rewardReceiver.primaryReportee) {
                        const pRep = rewardReceiver.primaryReportee;
                        const pRepId = pRep._id ? pRep._id.toString() : pRep.toString();
                        if (pRepId === approverBasic._id.toString()) {
                            isReporteeManager = true;
                        }
                    }

                    console.log("[UpdateReward] Roles - Management:", isManagement, "HR:", isHR, "Accounts:", isAccounts, "Reportee:", isReporteeManager);
                    console.log("[UpdateReward] Current Status:", reward.rewardStatus);


                    // Internal state tracking
                    const currentStage = reward.approvalStatus || reward.rewardStatus;
                    console.log("[UpdateReward] Current Internal Stage:", currentStage);

                    // LOGIC: Manager -> Management -> [Accounts (if Cash/Gift)] -> Approved
                    const isCashOrGift = reward.rewardType === 'Cash Reward' || reward.rewardType === 'Gift Reward';

                    // 1. Manager Step -> Management
                    if (currentStage === 'Pending' && isReporteeManager) {
                        finalStatus = isManagement && !isCashOrGift ? 'Approved' : 'Pending Authorization';
                    }
                    // 2. Management Step -> Accounts (Cash/Gift) or Approved (Certificate)
                    else if (currentStage === 'Pending Authorization' && isManagement) {
                        if (isCashOrGift) {
                            finalStatus = 'Pending Accounts';
                        } else {
                            finalStatus = 'Approved';
                        }
                    }
                    // 3. Accounts Step -> Approved (Cash/Gift only)
                    else if (currentStage === 'Pending Accounts' && isAccounts) {
                        if (!String(reward.expenseAccountId || '').trim()) {
                            return res.status(400).json({
                                message:
                                    'Accounts cannot approve until Expense Account is set on the Reward Parties card.',
                            });
                        }
                        if (!String(reward.paidThroughAccountId || '').trim()) {
                            return res.status(400).json({
                                message:
                                    'Accounts cannot approve until Paid Through is set on the Reward Parties card.',
                            });
                        }
                        if (
                            String(reward.expenseAccountId).trim() ===
                            String(reward.paidThroughAccountId).trim()
                        ) {
                            return res.status(400).json({
                                message:
                                    'Expense Account and Paid Through must be different Chart of Accounts.',
                            });
                        }
                        finalStatus = 'Approved';
                    }
                    // Management Override (Certificate / non-cash only — Cash/Gift still need Accounts)
                    else if (isManagement && reward.rewardStatus !== 'Rejected' && !isCashOrGift) {
                        finalStatus = 'Approved';
                    } else if (isManagement && isCashOrGift && currentStage === 'Pending') {
                        finalStatus = 'Pending Authorization';
                    }
                }
                console.log("[UpdateReward] Final ApproverDetails:", approverDetails ? "Set" : "NULL");

                // === REWARD LIFECYCLE SNAPSHOT (ACTION) ===
                console.log(`
┌──────────────────────────────────────────────────────────┐
│             REWARD ACTION & WORKFLOW TRANSITION          │
├──────────────────────────────────────────────────────────┤
│ Reward ID:    ${reward.rewardId}
│ Subject:      ${reward.employeeName} (${reward.employeeId})
│ Action By:    ${approverDetails?.name || 'System'} (${req.user?._id})
│ Requested:    ${rewardStatus}
│ Calculated:   ${finalStatus}
├──────────────────────────────────────────────────────────┤
│ UPDATED WORKFLOW:
${reward.workflow ? reward.workflow.map((w, i) => `│ ${i + 1}. Role: ${w.role.padEnd(12)} AssignedTo: ${w.assignedTo} (Status: ${w.status})`).join('\n') : '│ No Workflow Defined'}
└──────────────────────────────────────────────────────────┘
`);
            }

            // Update Statuses
            const nextInternalStage = finalStatus;
            
            // Allow publicStatus to reflect the exact current progression stage
            let publicStatus = finalStatus;

            // Cash/Gift Accounts approve: require Expense Account + Paid Through (Loan-style)
            if (
                nextInternalStage === 'Approved' &&
                (reward.approvalStatus || reward.rewardStatus) === 'Pending Accounts' &&
                (reward.rewardType === 'Cash Reward' ||
                    reward.rewardType === 'Gift Reward' ||
                    parseFloat(reward.amount || 0) > 0)
            ) {
                if (!String(reward.expenseAccountId || '').trim()) {
                    return res.status(400).json({
                        message:
                            'Accounts cannot approve until Expense Account is set on the Reward Parties card.',
                    });
                }
                if (!String(reward.paidThroughAccountId || '').trim()) {
                    return res.status(400).json({
                        message:
                            'Accounts cannot approve until Paid Through is set on the Reward Parties card.',
                    });
                }
                if (
                    String(reward.expenseAccountId).trim() ===
                    String(reward.paidThroughAccountId).trim()
                ) {
                    return res.status(400).json({
                        message:
                            'Expense Account and Paid Through must be different Chart of Accounts.',
                    });
                }
            }

            reward.approvalStatus = nextInternalStage;
            reward.rewardStatus = publicStatus;

            // Handle Transitions & Emails
            // Resolve hodContext for transitions
            const empContext = await EmployeeBasic.findOne({ employeeId: reward.employeeId }).select('company').lean();
            let resolvedCompanyId = empContext?.company;
            if (!resolvedCompanyId) {
                const creator = await User.findById(req.user?.id).select('employeeId');
                if (creator?.employeeId) {
                    const creatorEmp = await EmployeeBasic.findOne({ employeeId: creator.employeeId }).select('company');
                    if (creatorEmp?.company) resolvedCompanyId = creatorEmp.company;
                }
            }
            let hodContext = reward.employeeId;
            if (resolvedCompanyId) {
                const companyObj = await Company.findById(resolvedCompanyId).select('companyId');
                if (companyObj?.companyId) {
                    hodContext = companyObj.companyId;
                    console.log(`[UpdateReward] Company Context: ${resolvedCompanyId} (HOD Context: ${hodContext})`);
                }
            }

            if (nextInternalStage === 'Pending Accounts') {
                console.log(`[UpdateReward] Transitioning to Pending Accounts`);
                const targetHOD = await getDepartmentHOD('accounts', hodContext);
                if (targetHOD && approverDetails) {
                    const hodUser = await User.findOne({ employeeId: targetHOD.employeeId });
                    if (hodUser) {
                        reward.submittedTo = hodUser._id;
                        if (!reward.workflow) reward.workflow = [];

                        // Mark prior pending step (Manager or Management) approved
                        const priorPending = reward.workflow.find(
                            (w) => w.status === 'Pending' && w.role !== 'Accounts'
                        );
                        if (priorPending) {
                            priorPending.status = 'Approved';
                            priorPending.actionedAt = new Date();
                            if (priorPending.role === 'Manager') {
                                reward.managerApprovedBy = approverDetails.id;
                            } else if (priorPending.role === 'Management' || priorPending.role === 'CEO') {
                                reward.approvedBy = reward.approvedBy || req.user?.id || null;
                            }
                        }

                        let accountsStep = reward.workflow.find(w => w.role === 'Accounts');
                        if (accountsStep) {
                            accountsStep.status = 'Pending';
                            accountsStep.assignedAt = new Date();
                            accountsStep.assignedTo = hodUser._id;
                        } else {
                            reward.workflow.push({
                                role: 'Accounts',
                                assignedTo: hodUser._id,
                                status: 'Pending',
                                assignedAt: new Date()
                            });
                        }

                        try {
                            await sendHODAuthorizationEmail('Reward', reward, targetHOD, approverDetails);
                        } catch (mailErr) {
                            console.error('[UpdateReward] Accounts stage email failed:', mailErr);
                        }
                    }
                }
            } else if (nextInternalStage === 'Pending Authorization') {
                console.log(`[UpdateReward] Triggering Management Email logic`);

                const targetHOD = await getManagementHOD(hodContext);
                const emailType = "Management";

                console.log(`[UpdateReward] Target HOD (Management):`, targetHOD ? targetHOD.email : 'None');

                if (targetHOD && approverDetails) {
                    const hodUser = await User.findOne({ employeeId: targetHOD.employeeId });
                    if (hodUser) {
                        console.log(`[UpdateReward] Found Management User: ${hodUser.username} (${hodUser._id}). Assigning ticket.`);
                        reward.submittedTo = hodUser._id;

                        if (!reward.workflow) reward.workflow = [];

                        // Find whatever step was pending (Manager — Accounts no longer precedes Management)
                        const currentPending = reward.workflow.find(w => w.status === 'Pending' && w.role !== 'Management');
                        if (currentPending) {
                            currentPending.status = 'Approved';
                            currentPending.actionedAt = new Date();
                        }

                        // Activate Management Step
                        const managementStep = reward.workflow.find(w => w.role === 'Management');
                        if (managementStep) {
                            managementStep.status = 'Pending';
                            managementStep.assignedAt = new Date();
                            managementStep.assignedTo = hodUser._id;
                        } else {
                            reward.workflow.push({
                                role: 'Management',
                                assignedTo: hodUser._id,
                                status: 'Pending',
                                assignedAt: new Date()
                            });
                        }

                        // Set persistent approver field
                        if (currentPending?.role === 'Manager') {
                            reward.managerApprovedBy = approverDetails.id;
                        }

                        await sendHODAuthorizationEmail('Reward', reward, targetHOD, approverDetails);
                    } else {
                        console.error(`[UpdateReward] CRITICAL: Found Management Employee but NO LINKED USER ACCOUNT found for ID ${targetHOD.employeeId}.`);
                    }
                } else {
                    console.warn(`[UpdateReward] Skipping Management Email. Reason: HOD found=${!!targetHOD}, ApproverDetails=${!!approverDetails}`);
                }
            }

            // If status is being approved (Final), ensure metadata and workflow are updated
            if (finalStatus === 'Approved') {
                console.log("[UpdateReward] Entering Final Approval Block");
                if (!reward.approvedBy) reward.approvedBy = req.user?.id || null;

                if (!reward.approvedDate) reward.approvedDate = new Date();

                // Update Management / Accounts Workflow to Approved
                if (reward.workflow?.length) {

                    console.log(
                        `[UpdateReward] Management Workflow Update Check: User=${req.user?._id}`
                    );

                    if (reward.workflow) {
                        console.log("Current Workflow:", JSON.stringify(reward.workflow, null, 2));
                    }

                    const managementEntry = reward.workflow.find(w =>
                        (w.role === 'Management' || w.role === 'CEO') &&
                        w.status === 'Pending'
                    );

                    console.log(
                        `[UpdateReward] Found Pending Management Entry:`,
                        managementEntry ? "YES" : "NO"
                    );

                    if (managementEntry) {
                        managementEntry.status = 'Approved';
                        managementEntry.actionedAt = new Date();
                    }

                    const accountsEntry = reward.workflow.find(
                        (w) => w.role === 'Accounts' && w.status === 'Pending'
                    );
                    if (accountsEntry) {
                        accountsEntry.status = 'Approved';
                        accountsEntry.actionedAt = new Date();
                        reward.accountsApprovedBy = req.user?.id || reward.accountsApprovedBy || null;
                    }

                    // Explicitly ensure reward status is Approved
                    finalStatus = 'Approved';
                    reward.rewardStatus = 'Approved';

                    // Update skipped/pending workflows to Approved
                    if (reward.workflow) {
                        reward.workflow.forEach(w => {
                            if (w.status === 'Pending') {
                                w.status = 'Approved';
                                w.actionedAt = new Date();
                            }
                        });
                    }
                }

                // Cash/Gift: post Zoho Expense on Accounts approve (reference + notes = reward description)
                // Persist certificate PDF first so it can be uploaded to Zoho "Upload your Files".
                const isCashOrGiftZoho =
                    reward.rewardType === 'Cash Reward' ||
                    reward.rewardType === 'Gift Reward' ||
                    (parseFloat(reward.amount || 0) > 0);
                if (
                    isCashOrGiftZoho &&
                    currentStatus === 'Pending Accounts' &&
                    !String(reward.zohoExpenseId || '').trim()
                ) {
                    try {
                        let certificatePdfForZoho = req.body.certificatePdf || '';
                        if (
                            certificatePdfForZoho &&
                            !(reward.certificateAttachment?.url || reward.certificateAttachment?.publicId)
                        ) {
                            try {
                                let base64Data = String(certificatePdfForZoho);
                                if (base64Data.includes(',')) base64Data = base64Data.split(',')[1];
                                const certName = `Certificate-${reward.rewardId || reward._id}.pdf`;
                                reward.certificateAttachment = await ensureAttachmentPersistedToS3(
                                    {
                                        data: `data:application/pdf;base64,${base64Data}`,
                                        name: certName,
                                        mimeType: 'application/pdf',
                                    },
                                    {
                                        folder: 'rewards',
                                        fileName: certName,
                                    },
                                );
                                console.log(
                                    '[UpdateReward] Certificate saved before Zoho Expense upload',
                                );
                            } catch (certStoreErr) {
                                console.warn(
                                    '[UpdateReward] Certificate pre-store for Zoho failed:',
                                    certStoreErr?.message || certStoreErr,
                                );
                            }
                        }

                        const { syncRewardApprovalToZohoExpense } = await import(
                            '../../utils/syncRewardPaymentToZoho.js'
                        );
                        const employeeForZoho = await EmployeeBasic.findOne({
                            employeeId: reward.employeeId,
                        })
                            .select('employeeId company firstName lastName')
                            .lean();
                        const zohoResult = await syncRewardApprovalToZohoExpense({
                            reward,
                            employee: employeeForZoho,
                            certificatePdfBase64: certificatePdfForZoho,
                        });
                        if (zohoResult?.ok) {
                            if (zohoResult.expenseId) {
                                reward.zohoExpenseId = zohoResult.expenseId;
                                reward.zohoExpenseNumber = zohoResult.expenseNumber || '';
                                reward.zohoOrganizationId =
                                    zohoResult.organizationId || reward.zohoOrganizationId || '';
                                reward.zohoSyncedAt = new Date();
                                reward.zohoSyncError = '';
                            }
                            console.log(
                                '[UpdateReward] Zoho Expense on Accounts approve:',
                                zohoResult.message || zohoResult.expenseId,
                                zohoResult.attachment?.uploaded || zohoResult.attachment?.filename || '',
                            );
                        } else {
                            reward.zohoSyncError = zohoResult?.message || 'Zoho Expense sync failed';
                            console.warn('[UpdateReward] Zoho Expense failed:', reward.zohoSyncError);
                        }
                    } catch (zohoErr) {
                        reward.zohoSyncError = zohoErr?.message || 'Zoho Expense sync failed';
                        console.error('[UpdateReward] Zoho Expense error:', zohoErr);
                    }
                }

            }

            // If status is being approved (Final), send email to recipient
            if (finalStatus === 'Approved' && currentStatus !== 'Approved') {
                const isCashOrGiftFinal =
                    reward.rewardType === 'Cash Reward' ||
                    reward.rewardType === 'Gift Reward' ||
                    (parseFloat(reward.amount || 0) > 0);

                try {
                    // Emails: reward target (TO); reportee, creator, management, accounts, HR, all@vegadigital.ae (CC)
                    const employeeForEmail = await EmployeeBasic.findOne({ employeeId: reward.employeeId })
                        .select('firstName lastName email companyEmail primaryReportee')
                        .populate('primaryReportee', 'firstName lastName email companyEmail')
                        .lean();

                    const creator = await User.findById(reward.createdBy).select('email companyEmail name username').lean();

                    if (employeeForEmail) {
                        const toEmails = new Set();
                        const ccEmails = new Set();

                        const { email: empEmail, isFallbackToReportee, employeeName, reporteeName } = resolveEmployeeEmail(employeeForEmail);
                        if (empEmail) toEmails.add(empEmail);

                        if (employeeForEmail.primaryReportee) {
                            const { email: managerEmail } = resolveEmployeeEmail(employeeForEmail.primaryReportee);
                            if (managerEmail && !toEmails.has(managerEmail)) ccEmails.add(managerEmail);
                        }

                        if (creator?.companyEmail || creator?.email) {
                            const creatorEmail = String(creator.companyEmail || creator.email).trim();
                            if (creatorEmail) ccEmails.add(creatorEmail);
                        }

                        // Always CC company-wide + Accounts / HR / Management flowchart HODs
                        ccEmails.add('all@vegadigital.ae');

                        try {
                            const managementHOD = await getManagementHOD(hodContext);
                            addEmployeeEmailToSet(ccEmails, managementHOD);
                        } catch (e) {
                            console.warn("[UpdateReward] Could not fetch Management HOD email for CC", e.message);
                        }

                        try {
                            const accountsHOD = await getDepartmentHOD('accounts', hodContext);
                            addEmployeeEmailToSet(ccEmails, accountsHOD);
                        } catch (e) {
                            console.warn("[UpdateReward] Could not fetch Accounts HOD email for CC", e.message);
                        }

                        try {
                            const hrHOD = await getDepartmentHOD('hr', hodContext);
                            addEmployeeEmailToSet(ccEmails, hrHOD);
                        } catch (e) {
                            console.warn("[UpdateReward] Could not fetch HR HOD email for CC", e.message);
                        }

                        // Avoid duplicating TO addresses in CC
                        for (const to of toEmails) {
                            ccEmails.delete(to);
                        }

                        const toRecipients = Array.from(toEmails);
                        const ccRecipients = Array.from(ccEmails);

                        if (toRecipients.length > 0 || ccRecipients.length > 0) {
                            const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
                            const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

                            if (emailUser && emailPass) {
                                let smtpHost = "smtp.office365.com";
                                let smtpPort = 587;
                                if (emailUser.includes('@gmail.com') || process.env.GMAIL_USER) {
                                    smtpHost = "smtp.gmail.com";
                                }

                                const transporter = nodemailer.createTransport({
                                    host: smtpHost,
                                    port: smtpPort,
                                    secure: false,
                                    auth: { user: emailUser, pass: emailPass }
                                });

                                const statusLabel = isCashOrGiftFinal ? 'Approved (Not Paid)' : 'Approved';
                                const subject = isCashOrGiftFinal
                                    ? `Reward Approved (Not Paid): ${reward.rewardType} - ${employeeForEmail.firstName} ${employeeForEmail.lastName}`
                                    : "Congratulations! Reward Request Approved";
                                const html = `
                                    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                                        <h2 style="color: #2e7d32; text-align: center;">Reward ${statusLabel}</h2>
                                        ${isFallbackToReportee ? getFallbackEmailNote(employeeName, reporteeName) : ''}
                                        <p>Dear All,</p>
                                        <p>We are pleased to inform you that the reward request for <strong>${employeeForEmail.firstName} ${employeeForEmail.lastName}</strong> regarding <strong>${reward.rewardType}</strong> (${reward.title}) has been <strong>${statusLabel}</strong>.</p>
                                        ${isCashOrGiftFinal ? `<p>Amount: <strong>AED ${Number(reward.amount || 0).toLocaleString()}</strong>. Accounts will process payment next.</p>` : ''}
                                        <p>Please find the reward certificate ${reward.attachment && (reward.attachment.url || reward.attachment.publicId) ? 'and original documentation' : ''} attached to this email.</p>
                                        <br>
                                        <p>Best Regards,</p>
                                        <p>Management Team</p>
                                    </div>
                                `;

                                const mailOptions = {
                                    from: `"VeRP Notification" <${emailUser}>`,
                                    to: toRecipients,
                                    cc: ccRecipients,
                                    subject: subject,
                                    html: html,
                                    attachments: []
                                };

                                // --- 1. Add Original Attachment (if any) ---
                                if (reward.attachment && (reward.attachment.url || reward.attachment.publicId)) {
                                    try {
                                        const { getSignedFileUrl } = await import("../../utils/s3Upload.js");
                                        const axios = (await import("axios")).default;
                                        const refreshedUrl = await getSignedFileUrl(reward.attachment.publicId || reward.attachment.url);

                                        if (refreshedUrl) {
                                            console.log(`[UpdateReward] Fetching original attachment from: ${refreshedUrl}`);
                                            const attResponse = await axios.get(refreshedUrl, {
                                                responseType: 'arraybuffer',
                                                timeout: 30000,
                                                maxContentLength: Infinity
                                            });

                                            mailOptions.attachments.push({
                                                filename: reward.attachment.name || 'original_attachment.pdf',
                                                content: Buffer.from(attResponse.data)
                                            });
                                            console.log(`[UpdateReward] Success: Original attachment added to email.`);
                                        }
                                    } catch (attErr) {
                                        console.error("[UpdateReward] Failed to fetch original attachment:", attErr.message);
                                    }
                                }

                                // --- 2. Generate and Add Certificate PDF ---
                                const requestingUserId = req.user?.id || req.body.createdBy?._id;
                                let userPayload = { id: requestingUserId, role: 'Admin' };
                                let token = req.headers.authorization?.split(' ')[1] || '';

                                try {
                                    if (requestingUserId) {
                                        const userObj = await User.findById(requestingUserId);
                                        if (userObj) {
                                            userPayload = {
                                                id: userObj._id,
                                                isAdmin: isUsernameSystemSuperUser(userObj?.username),
                                                role: userObj.role,
                                                employeeId: userObj.employeeId
                                            };
                                        }
                                    }
                                } catch (uErr) {
                                    console.warn("[UpdateReward] Failed to build user payload for Puppeteer:", uErr);
                                }

                                const baseUrl = resolveFrontendBaseUrl(req);
                                const printUrl = `${baseUrl}/HRM/Reward/${reward._id}`;
                                const selector = '#certificate-container';

                                console.log(`[UpdateReward] Generating Certificate PDF via Puppeteer from: ${printUrl}`);

                                try {
                                    await reward.save();

                                    let pdfBuffer = null;

                                    if (req.body.certificatePdf) {
                                        console.log(`[UpdateReward] Received frontend-generated Base64 Certificate PDF. String length: ${req.body.certificatePdf.length}`);

                                        let base64Data = req.body.certificatePdf;
                                        if (base64Data.includes(',')) {
                                            console.log("[UpdateReward] Stripping Data URI prefix from certificatePdf");
                                            base64Data = base64Data.split(',')[1];
                                        }

                                        pdfBuffer = Buffer.from(base64Data, 'base64');
                                        console.log(`[UpdateReward] Converted to Buffer. Buffer size: ${pdfBuffer.length} bytes`);
                                    } else {
                                        console.log(`[UpdateReward] Generating Certificate PDF via Puppeteer from: ${printUrl}`);
                                        const { generatePdf } = await import("../../utils/generatePdf.js");
                                        pdfBuffer = await generatePdf(printUrl, token, userPayload, { hrm_reward: { isView: true, isActive: true } }, selector);
                                        console.log(`[UpdateReward] Puppeteer PDF generated. Buffer size: ${pdfBuffer ? pdfBuffer.length : 0} bytes`);
                                    }

                                    if (pdfBuffer && pdfBuffer.length > 1000) {
                                        mailOptions.attachments.push({
                                            filename: `Certificate-${reward.rewardId || reward._id}.pdf`,
                                            content: pdfBuffer,
                                            contentType: 'application/pdf'
                                        });
                                        console.log(`[UpdateReward] Success: Certificate PDF attached. Size: ${pdfBuffer.length}`);

                                        // Persist certificate on the reward so Attachment tab can open it
                                        try {
                                            const base64Pdf = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
                                            reward.certificateAttachment = await ensureAttachmentPersistedToS3(
                                                {
                                                    data: base64Pdf,
                                                    name: `Certificate-${reward.rewardId || reward._id}.pdf`,
                                                    mimeType: 'application/pdf',
                                                },
                                                {
                                                    folder: 'rewards',
                                                    fileName: `Certificate-${reward.rewardId || reward._id}.pdf`,
                                                },
                                            );
                                            await reward.save();
                                            console.log(`[UpdateReward] Certificate saved to reward.certificateAttachment`);
                                        } catch (storeErr) {
                                            console.error('[UpdateReward] Failed to store certificate on reward:', storeErr?.message || storeErr);
                                        }
                                    } else {
                                        console.warn(`[UpdateReward] Warning: PDF buffer too small or null: ${pdfBuffer ? pdfBuffer.length : 'null'}`);
                                    }
                                } catch (pdfErr) {
                                    console.error("[UpdateReward] ERROR: PDF Generation or Attachment Failed:", pdfErr.message);
                                }

                                // --- 3. Send Email ---
                                if (mailOptions.attachments.length > 0) {
                                    await transporter.sendMail(mailOptions);
                                    console.log(`[UpdateReward] SUCCESS: Final Approval email with ${mailOptions.attachments.length} attachments sent to ${toRecipients.length} TO and ${ccRecipients.length} CC recipients.`);
                                } else {
                                    console.warn("[UpdateReward] WARNING: Sending email with ZERO attachments.");
                                    await transporter.sendMail(mailOptions);
                                }
                            } else {
                                console.error("[UpdateReward] ERROR: Missing EMAIL_USER or EMAIL_PASS environment variables");
                            }
                        } else {
                            console.warn(`[UpdateReward] WARNING: Employee has no email address. Skipping email.`);
                        }
                    } else {
                        console.error(`[UpdateReward] ERROR: Employee not found for ID ${reward.employeeId}`);
                    }
                } catch (emailError) {
                    console.error("[UpdateReward] EXCEPTION: Failed to send reward approval email:", emailError);
                }
            } else if (rewardStatus === 'Rejected') {
                // Update Workflow to Rejected
                if (!reward.workflow) reward.workflow = [];
                const pendingStep = reward.workflow.find(w => w.status === 'Pending' && (w.assignedTo?.toString() === (req.user?._id || approverUserId)?.toString() || w.role === 'Management')); // Management usually is the one rejecting at final stage, or Manager/HR

                if (pendingStep) {
                    pendingStep.status = 'Rejected';
                    pendingStep.actionedAt = new Date();
                    pendingStep.comment = remarks;
                } else {
                    // Fallback log rejection
                    reward.workflow.push({
                        role: approverDetails ? approverDetails.designation : 'Reviewer',
                        assignedTo: req.user?._id || approverUserId,
                        status: 'Rejected',
                        assignedAt: new Date(),
                        actionedAt: new Date(),
                        comment: remarks
                    });
                }

                // === REJECTION EMAIL LOGIC ===
                try {
                    // Logic to include all previous approvers and the requester
                    const notificationIds = (reward.workflow || [])
                        .filter(w => w.status === 'Approved' && w.assignedTo)
                        .map(w => w.assignedTo.toString());

                    if (reward.createdBy) notificationIds.push(reward.createdBy.toString());

                    const [employeeForEmail, userObjects] = await Promise.all([
                        EmployeeBasic.findOne({ employeeId: reward.employeeId })
                            .select('firstName lastName email companyEmail primaryReportee')
                            .populate('primaryReportee', 'firstName lastName email companyEmail')
                            .lean(),
                        User.find({ _id: { $in: notificationIds } })
                    ]);

                    if (employeeForEmail) {
                        const recipientEmails = new Set();

                        // Target employee is NOT emailed on reject — only after final approval.
                        // Notify manager, prior approvers, and requester only.
                        if (employeeForEmail.primaryReportee) {
                            const managerEmail = employeeForEmail.primaryReportee.companyEmail || employeeForEmail.primaryReportee.email;
                            if (managerEmail) recipientEmails.add(managerEmail);
                        }

                        // Add User Emails (Approvers & Requester)
                        if (userObjects && userObjects.length > 0) {
                            userObjects.forEach(u => {
                                const mail = u.companyEmail || u.email;
                                if (mail) recipientEmails.add(mail);
                            });
                        }

                        const empName = `${employeeForEmail.firstName} ${employeeForEmail.lastName}`.trim();

                        if (recipientEmails.size > 0) {
                            const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
                            const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

                            if (emailUser && emailPass) {
                                let smtpHost = "smtp.office365.com";
                                let smtpPort = 587;
                                if (emailUser.includes('@gmail.com') || process.env.GMAIL_USER) {
                                    smtpHost = "smtp.gmail.com";
                                }

                                const transporter = nodemailer.createTransport({
                                    host: smtpHost,
                                    port: smtpPort,
                                    secure: false,
                                    auth: { user: emailUser, pass: emailPass }
                                });

                                const subject = `Update regarding Reward Request: ${reward.rewardType} for ${empName}`;
                                const html = `
                                     <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
                                         <h2 style="color: #d32f2f; text-align: center;">Reward Request Update</h2>
                                         <p>Dear All,</p>
                                         <p>This is to inform you that the <strong>${reward.rewardType}</strong> request for <strong>${empName}</strong> has been <strong>Rejected</strong>.</p>
                                         <div style="background-color: #fff5f5; border-left: 4px solid #f44336; padding: 15px; margin: 20px 0;">
                                            <p style="margin: 0;"><strong>Rejection Reason:</strong> ${remarks || 'No reason provided'}</p>
                                         </div>
                                         <p>For more details, please visit the portal.</p>
                                         <br>
                                         <p>Best Regards,</p>
                                         <p>VeRP System</p>
                                     </div>
                                 `;

                                await transporter.sendMail({
                                    from: `"VeRP Notification" <${emailUser}>`,
                                    to: Array.from(recipientEmails).join(', '),
                                    subject: subject,
                                    html: html
                                });
                                console.log(`[UpdateReward] SUCCESS: Reward rejection email sent to ${Array.from(recipientEmails).length} recipients (target employee excluded)`);
                            } else {
                                console.error("[UpdateReward] ERROR: Missing EMAIL_USER or EMAIL_PASS for rejection email");
                            }
                        } else {
                            console.warn(`[UpdateReward] WARNING: No emails found for recipients of rejected reward ${reward.rewardId}`);
                        }
                    }
                } catch (emailError) {
                    console.error("[UpdateReward] EXCEPTION: Failed to send reward rejection email:", emailError);
                }
            } else if (rewardStatus === 'Cancelled') {
                // Update Workflow to Cancelled
                if (!reward.workflow) reward.workflow = [];
                // If it's a draft, there might not be a pending step yet, but let's try to find one or add one
                const pendingStep = reward.workflow.find(w => w.status === 'Pending');

                if (pendingStep) {
                    pendingStep.status = 'Cancelled';
                    pendingStep.actionedAt = new Date();
                } else {
                    reward.workflow.push({
                        role: 'Requester',
                        assignedTo: req.user?._id || reward.createdBy,
                        status: 'Cancelled',
                        assignedAt: new Date(),
                        actionedAt: new Date()
                    });
                }
            }
        }


        await reward.save();

        // === SYNC DASHBOARD ACTION ===
        try {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            const { syncRewardPaymentDueBell } = await import("../../utils/rewardPaymentStatus.js");
            const employee = await EmployeeBasic.findOne({ employeeId: reward.employeeId });

            const amountDue = parseFloat(reward.amount || 0);
            const isCashOrGiftDash =
                reward.rewardType === 'Cash Reward' ||
                reward.rewardType === 'Gift Reward' ||
                amountDue > 0;
            const needsAccountsPayment =
                reward.rewardStatus === 'Approved' &&
                isCashOrGiftDash &&
                amountDue > 0 &&
                amountDue - parseFloat(reward.paidAmount || 0) > 0.01;

            // Terminal = no further approval/payment tasks (certificate Approved, or Paid / Rejected / Cancelled)
            const isTerminalStatus =
                ['Rejected', 'Cancelled', 'Approved (Paid)'].includes(reward.rewardStatus) ||
                (reward.rewardStatus === 'Approved' && !needsAccountsPayment);

            if (needsAccountsPayment) {
                // Clear approval bells, then create Accounts pay task
                await syncDashboardAction({
                    requestId: reward._id,
                    requestType: 'Reward',
                    assignedTo: null,
                    status: 'Approved',
                    subjectEmployee: employee,
                    requestedByName: req.user?.name,
                    actionedBy: req.user?._id,
                    comment: remarks
                });
                console.log('[UpdateReward] Syncing Accounts Pay bell after Approved (Not Paid)');
                await syncRewardPaymentDueBell(reward, employee, req.user?.name || '');
            } else {
                const { rewardStageBellLabel } = await import("../../utils/rewardStageBellLabel.js");

                // Clear previous stage bells for this reward, then open the next assignee's bell
                await syncDashboardAction({
                    requestId: reward._id,
                    requestType: 'Reward',
                    assignedTo: null,
                    status: isTerminalStatus
                        ? (reward.rewardStatus === 'Approved (Paid)' ? 'Approved' : reward.rewardStatus)
                        : 'Approved',
                    subjectEmployee: employee,
                    requestedByName: req.user?.name,
                    actionedBy: req.user?._id,
                    comment: remarks
                });

                const nextPendingStep = reward.workflow?.find(w => w.status === 'Pending');
                if (nextPendingStep) {
                    console.log(`[UpdateReward] Syncing Next Dashboard Action for: ${nextPendingStep.assignedTo} (Role: ${nextPendingStep.role})`);
                    await syncDashboardAction({
                        requestId: reward._id,
                        requestType: 'Reward',
                        assignedTo: nextPendingStep.assignedTo,
                        status: 'Pending',
                        subjectEmployee: employee,
                        requestedByName: req.user?.name,
                        extra1: rewardStageBellLabel(nextPendingStep.role, {
                            rewardType: reward.rewardType,
                            rewardStatus: reward.rewardStatus,
                        }),
                        extra2: reward.amount ? `AED ${reward.amount}` : reward.title
                    });
                }
            }
        } catch (syncErr) {
            console.error("[UpdateReward] Dashboard Sync Error:", syncErr);
        }

        await reward.save();

        return res.status(200).json({
            message: "Reward updated successfully",
            reward
        });
    } catch (error) {
        console.error('Error updating reward:', error);

        if (error.name === 'ValidationError') {
            return res.status(400).json({
                message: `Validation error: ${error.message}`
            });
        }

        return res.status(500).json({
            message: error.message || "Failed to update reward"
        });
    }
};

















