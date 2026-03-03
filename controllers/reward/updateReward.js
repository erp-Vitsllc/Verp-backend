import Reward from "../../models/Reward.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import Company from "../../models/Company.js";
import User from "../../models/User.js";
import nodemailer from "nodemailer";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { sendHODAuthorizationEmail } from "../../utils/sendHODAuthorizationEmail.js";
import { generatePdf } from "../../utils/generatePdf.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";

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
                const attachmentDataStr = typeof attachment.data === 'string' ? attachment.data : String(attachment.data);

                const uploadResult = await uploadDocumentToS3(
                    attachmentDataStr,
                    `rewards/${reward.employeeId}`,
                    attachment.name || 'reward-attachment.pdf',
                    'raw'
                );

                reward.attachment = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: attachment.name || '',
                    mimeType: attachment.mimeType || 'application/pdf'
                };
                console.log(`[UpdateReward] Attachment updated in S3: ${uploadResult.url}`);
            } catch (uploadError) {
                console.error(`[UpdateReward] Attachment upload failed:`, uploadError);
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

                                const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
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

                            // NEXT PERSON LOGIC: If the manager is the one submitting, move to next step
                            if (reporteeUser._id.toString() === req.user?._id?.toString()) {
                                console.log("[UpdateReward] Submitter is the Manager. Moving to next workflow step.");

                                let nextTarget = null;
                                let nextTargetRole = null;

                                if (isCashOrGift) {
                                    // Move to Accounts
                                    const accountsHOD = await getDepartmentHOD('accounts', hodContext);
                                    if (accountsHOD) {
                                        const accountsUser = await User.findOne({ employeeId: accountsHOD.employeeId });
                                        if (accountsUser) {
                                            nextTarget = accountsUser;
                                            nextTargetRole = 'Accounts';
                                            finalRecipients.push({
                                                email: accountsHOD.companyEmail || accountsHOD.email || accountsUser.companyEmail || accountsUser.email,
                                                name: `${accountsHOD.firstName} ${accountsHOD.lastName}`,
                                                role: 'Accounts HOD'
                                            });
                                        }
                                    }
                                }

                                if (!nextTarget) {
                                    // Move to Management
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
                                }

                                if (nextTarget) {
                                    reward.submittedTo = nextTarget._id;
                                    reward.workflow = [
                                        { role: 'Manager', assignedTo: req.user._id, status: 'Approved', assignedAt: new Date(), actionedAt: new Date() },
                                        { role: nextTargetRole || 'Next', assignedTo: nextTarget._id, status: 'Pending', assignedAt: new Date() }
                                    ];
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

                                // Add other steps for tracker visibility if not already added
                                if (isCashOrGift) {
                                    const accountsHOD = await getDepartmentHOD('accounts', hodContext);
                                    if (accountsHOD) {
                                        const accountsUser = await User.findOne({ employeeId: accountsHOD.employeeId });
                                        if (accountsUser) {
                                            reward.workflow.push({ role: 'Accounts', assignedTo: accountsUser._id, status: 'Pending', assignedAt: new Date() });
                                        }
                                    }
                                }
                                const managementHOD = await getManagementHOD(hodContext);
                                if (managementHOD) {
                                    const managementUser = await User.findOne({ employeeId: managementHOD.employeeId });
                                    if (managementUser) {
                                        reward.workflow.push({
                                            role: 'Management',
                                            assignedTo: managementUser._id,
                                            status: isCashOrGift ? 'Pending' : 'Draft',
                                            assignedAt: new Date()
                                        });
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

                                    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
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
                    const isAdmin = userObj?.isAdmin || userObj?.role === 'Admin' || userObj?.role === 'SuperAdmin';

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

                    // LOGIC: Manager -> [Accounts (if Cash/Gift)] -> Management -> Approved
                    const isCashOrGift = reward.rewardType === 'Cash Reward' || reward.rewardType === 'Gift Reward';

                    // 1. Manager Step -> Accounts or Management
                    if (currentStage === 'Pending' && isReporteeManager) {
                        if (isCashOrGift) {
                            finalStatus = 'Pending Accounts';
                        } else {
                            finalStatus = isManagement ? 'Approved' : 'Pending Authorization';
                        }
                    }
                    // 2. Accounts Step -> Management
                    else if (currentStage === 'Pending Accounts' && isAccounts) {
                        finalStatus = isManagement ? 'Approved' : 'Pending Authorization';
                    }
                    // 3. Management Step -> Approved
                    else if (currentStage === 'Pending Authorization' && isManagement) {
                        finalStatus = 'Approved';
                    }
                    // Management Override
                    else if (isManagement && reward.rewardStatus !== 'Rejected') {
                        finalStatus = 'Approved';
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
            let publicStatus = 'Pending';

            if (nextInternalStage === 'Approved') publicStatus = 'Approved';
            else if (nextInternalStage === 'Rejected') publicStatus = 'Rejected';
            else if (nextInternalStage === 'Cancelled') publicStatus = 'Cancelled';
            else if (nextInternalStage === 'Draft') publicStatus = 'Draft';

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

                        const managerStep = reward.workflow.find(w => w.role === 'Manager' && w.status === 'Pending');
                        if (managerStep) {
                            managerStep.status = 'Approved';
                            managerStep.actionedAt = new Date();
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

                        // Find whatever step was pending (Manager or Accounts)
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
                        } else if (currentPending?.role === 'Accounts') {
                            reward.accountsApprovedBy = approverDetails.id;
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

                // Update Management Workflow to Approved
                if (reward.workflow?.length) {

                    console.log(
                        `[UpdateReward] Management Workflow Update Check: User=${req.user?._id}`
                    );

                    if (reward.workflow) {
                        console.log("Current Workflow:", JSON.stringify(reward.workflow, null, 2));
                    }

                    const managementEntry = reward.workflow.find(w =>
                        w.role === 'Management' &&
                        w.status === 'Pending'
                    );

                    console.log(
                        `[UpdateReward] Found Pending Management Entry:`,
                        managementEntry ? "YES" : "NO"
                    );

                    if (managementEntry) {
                        managementEntry.status = 'Approved';
                        managementEntry.actionedAt = new Date();

                        // Explicitly ensure reward status is Approved
                        finalStatus = 'Approved';
                        reward.rewardStatus = 'Approved';
                    }
                }

            }

            // If status is being approved (Final), send email to recipient
            if (finalStatus === 'Approved' && currentStatus !== 'Approved') {
                try {
                    // Send email to the *Employee* (receiver of reward), Manager, and Creator
                    const employeeForEmail = await EmployeeBasic.findOne({ employeeId: reward.employeeId })
                        .select('firstName lastName email companyEmail primaryReportee')
                        .populate('primaryReportee', 'firstName lastName email companyEmail')
                        .lean();

                    const creator = await User.findById(reward.createdBy).select('email companyEmail').lean();

                    if (employeeForEmail) {
                        const recipientEmails = new Set();

                        // 1. Employee Email
                        const empEmail = employeeForEmail.companyEmail || employeeForEmail.email;
                        if (empEmail) recipientEmails.add(empEmail);

                        // 2. Manager Email (His Reportee/Supervisor)
                        if (employeeForEmail.primaryReportee) {
                            const managerEmail = employeeForEmail.primaryReportee.companyEmail || employeeForEmail.primaryReportee.email;
                            if (managerEmail) recipientEmails.add(managerEmail);
                        }

                        // 3. Creator Email
                        if (creator) {
                            const creatorEmail = creator.companyEmail || creator.email;
                            if (creatorEmail) recipientEmails.add(creatorEmail);
                        }

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

                                const subject = "Congratulations! Reward Request Approved";
                                const html = `
                                    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                                        <h2 style="color: #2e7d32; text-align: center;">Reward Approved</h2>
                                        <p>Dear All,</p>
                                        <p>We are pleased to inform you that the reward request for <strong>${employeeForEmail.firstName} ${employeeForEmail.lastName}</strong> regarding <strong>${reward.rewardType}</strong> (${reward.title}) has been <strong>Approved</strong>.</p>
                                        <p>Please find the reward certificate ${reward.attachment && (reward.attachment.url || reward.attachment.publicId) ? 'and original documentation' : ''} attached to this email.</p>
                                        <br>
                                        <p>Best Regards,</p>
                                        <p>Management Team</p>
                                    </div>
                                `;

                                const mailOptions = {
                                    from: `"VeRP Notification" <${emailUser}>`,
                                    to: Array.from(recipientEmails).join(', '),
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
                                // Prepare Permissions and User Payload for Puppeteer
                                const requestingUserId = req.user?.id || req.body.createdBy?._id;
                                let userPayload = { id: requestingUserId, role: 'Admin' }; // Default fallback
                                let token = req.headers.authorization?.split(' ')[1] || '';

                                try {
                                    if (requestingUserId) {
                                        const userObj = await User.findById(requestingUserId);
                                        if (userObj) {
                                            userPayload = {
                                                id: userObj._id,
                                                isAdmin: userObj.isAdmin || userObj.role === 'Admin',
                                                role: userObj.role,
                                                employeeId: userObj.employeeId
                                            };
                                        }
                                    }
                                } catch (uErr) {
                                    console.warn("[UpdateReward] Failed to build user payload for Puppeteer:", uErr);
                                }

                                // Construct URL
                                const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
                                const baseUrl = origin || process.env.FRONTEND_URL || "http://localhost:3000";
                                const printUrl = `${baseUrl}/HRM/Reward/${reward._id}`;
                                const selector = '#certificate-container';

                                console.log(`[UpdateReward] Generating Certificate PDF via Puppeteer from: ${printUrl}`);

                                try {
                                    // Ensure reward state is saved so emails are accurate
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
                                    } else {
                                        console.warn(`[UpdateReward] Warning: PDF buffer too small or null: ${pdfBuffer ? pdfBuffer.length : 'null'}`);
                                    }
                                } catch (pdfErr) {
                                    console.error("[UpdateReward] ERROR: PDF Generation or Attachment Failed:", pdfErr.message);
                                }

                                // --- 3. Send Email ---
                                if (mailOptions.attachments.length > 0) {
                                    await transporter.sendMail(mailOptions);
                                    console.log(`[UpdateReward] SUCCESS: Final Approval email with ${mailOptions.attachments.length} attachments sent to ${Array.from(recipientEmails).join(', ')}`);
                                } else {
                                    console.warn("[UpdateReward] WARNING: Sending email with ZERO attachments.");
                                    await transporter.sendMail(mailOptions);
                                }
                            } else {
                                console.error("[UpdateReward] ERROR: Missing EMAIL_USER or EMAIL_PASS environment variables");
                            }
                        } else {
                            console.warn(`[UpdateReward] WARNING: Employee ${empName} has no email address. Skipping email.`);
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

                        // Add Employee (Receiver)
                        const empEmail = employeeForEmail.companyEmail || employeeForEmail.email;
                        if (empEmail) recipientEmails.add(empEmail);

                        // Add Manager Email
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
                                console.log(`[UpdateReward] SUCCESS: Reward rejection email sent to ${Array.from(recipientEmails).length} recipients`);
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
            const employee = await EmployeeBasic.findOne({ employeeId: reward.employeeId });

            // 1. Resolve current pending steps
            // If this was an approval/rejection action, we should mark the ACTIONING user's pending task as done.
            const isFinalStatus = ['Approved', 'Rejected', 'Cancelled'].includes(reward.rewardStatus);
            await syncDashboardAction({
                requestId: reward._id,
                requestType: 'Reward',
                // For final statuses, clear all pending for this request. 
                // For intermediate (where status might still be 'Pending' but approvalStatus changed),
                // we specifically clear the caller's pending task to support parallel workflows.
                assignedTo: isFinalStatus ? null : req.user?._id,
                status: isFinalStatus ? reward.rewardStatus : 'Approved',
                subjectEmployee: employee,
                actionedBy: req.user?._id,
                comment: remarks
            });

            // 2. If there's a new pending step, create it
            const nextPendingStep = reward.workflow?.find(w => w.status === 'Pending');
            if (nextPendingStep) {
                console.log(`[UpdateReward] Syncing Next Dashboard Action for: ${nextPendingStep.assignedTo} (Role: ${nextPendingStep.role})`);
                await syncDashboardAction({
                    requestId: reward._id,
                    requestType: 'Reward',
                    assignedTo: nextPendingStep.assignedTo,
                    status: 'Pending',
                    subjectEmployee: employee,
                    extra1: reward.rewardType,
                    extra2: reward.amount ? `AED ${reward.amount}` : reward.title
                });
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
















