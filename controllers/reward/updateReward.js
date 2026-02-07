import Reward from "../../models/Reward.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import nodemailer from "nodemailer";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { sendHODAuthorizationEmail } from "../../utils/sendHODAuthorizationEmail.js";
import { generatePdf } from "../../utils/generatePdf.js";

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
            certSigner2Title
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

        // Update fields
        if (rewardType) reward.rewardType = rewardType;
        if (rewardType) reward.rewardType = rewardType;

        // Handle explicit approver fields from frontend
        if (req.body.hrApprovedBy) reward.hrApprovedBy = req.body.hrApprovedBy;
        if (req.body.accountsApprovedBy) reward.accountsApprovedBy = req.body.accountsApprovedBy;
        if (req.body.approvedBy) reward.approvedBy = req.body.approvedBy;

        if (rewardStatus !== undefined) {
            // === NEW APPROVAL LOGIC ===
            let finalStatus = rewardStatus;
            const currentStatus = reward.rewardStatus;
            let approverDetails = null;

            console.log(`[UpdateReward] Status Change Request: ${currentStatus} -> ${rewardStatus}`);


            // === SUBMIT FROM DRAFT LOGIC ===
            if (finalStatus === 'Pending' && reward.rewardStatus === 'Draft') {
                console.log("[UpdateReward] Submitting Draft Reward. Identifying Manager...");

                // Find Requester's Manager (Reportee)
                const employeeForSnapshot = await EmployeeBasic.findOne({ employeeId: reward.employeeId })
                    .select('primaryReportee employeeId firstName lastName department designation')
                    .lean();

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

                            // Initialize Workflow
                            reward.workflow = [{
                                role: 'Manager',
                                assignedTo: reporteeUser._id,
                                status: 'Pending',
                                assignedAt: new Date()
                            }];

                            // Send Email Notification to Manager
                            const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
                            const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

                            if (emailUser && emailPass) {
                                try {
                                    const transporter = nodemailer.createTransport({
                                        host: (emailUser.includes('@gmail') || process.env.GMAIL_USER) ? "smtp.gmail.com" : "smtp.office365.com",
                                        port: 587,
                                        secure: false,
                                        auth: { user: emailUser, pass: emailPass }
                                    });

                                    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
                                    const rewardUrl = `${baseUrl}/HRM/Reward/${reward.rewardId}`;
                                    const empName = reward.employeeName;
                                    const managerName = `${managerBasic.firstName} ${managerBasic.lastName}`;

                                    await transporter.sendMail({
                                        from: `"VeRP System" <${emailUser}>`,
                                        to: managerBasic.companyEmail || reporteeUser.companyEmail || reporteeUser.email,
                                        subject: "Request for Reward Approval",
                                        html: `
                                            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
                                                <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-bottom: 1px solid #eee;">
                                                    <h2 style="margin: 0; color: #1a2e35;">Request for Reward Approval</h2>
                                                </div>
                                                
                                                <div style="padding: 20px;">
                                                    <p>Dear <strong>${managerName}</strong>,</p>
                                                    
                                                    <p>We would like to inform you that a formal request for a <strong>${reward.rewardType}</strong> has been initiated for the following employee:</p>
                                                    
                                                    <div style="background-color: #fce4ec; border-left: 4px solid #d81b60; padding: 15px; margin: 20px 0; border-radius: 4px;">
                                                        <p style="margin: 5px 0;"><strong>Employee Name:</strong> ${empName}</p>
                                                        <p style="margin: 5px 0;"><strong>Employee ID:</strong> ${employeeForSnapshot.employeeId}</p>
                                                        <p style="margin: 5px 0;"><strong>Department:</strong> ${employeeForSnapshot.department || 'N/A'}</p>
                                                        <p style="margin: 5px 0;"><strong>Designation:</strong> ${employeeForSnapshot.designation || 'N/A'}</p>
                                                        <p style="margin: 5px 0;"><strong>Reward Type:</strong> ${reward.rewardType}</p>
                                                    </div>
                                                    
                                                    <p>Kindly review the details and take appropriate action by approving or rejecting the request.</p>
                                                    
                                                    <div style="text-align: center; margin-top: 30px; margin-bottom: 30px;">
                                                        <a href="${rewardUrl}" style="background-color: #007bff; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Review Request</a>
                                                    </div>
                                                </div>
                                                
                                                <div style="background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 0.8em; color: #888; border-top: 1px solid #eee;">
                                                    <p style="margin: 0;">This is an automated message from the VeRP System.<br>Please do not reply to this email.</p>
                                                </div>
                                            </div>
                                        `
                                    });
                                    console.log("Approval Email Sent");
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

                    // Check CEO Validity (Strict)
                    const isCEO = approverBasic.department && (approverBasic.department.toLowerCase() === 'management' || approverBasic.department.toLowerCase() === 'administration' || approverBasic.department.toLowerCase() === 'board of directors') &&
                        ['ceo', 'c.e.o', 'c.e.o.', 'chief executive officer', 'director', 'managing director', 'general manager', 'gm', 'g.m', 'g.m.'].includes(approverBasic.designation?.toLowerCase()?.trim());

                    // Check HR Validity
                    const isHR = approverBasic.department && (approverBasic.department.toLowerCase() === 'hr' || approverBasic.department.toLowerCase() === 'human resource' || approverBasic.department.toLowerCase() === 'human resources');

                    // Check Accounts Validity
                    const isAccounts = approverBasic.department && (approverBasic.department.toLowerCase() === 'accounts' || approverBasic.department.toLowerCase() === 'finance' || approverBasic.department.toLowerCase() === 'account');

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

                    console.log("[UpdateReward] Roles - CEO:", isCEO, "HR:", isHR, "Accounts:", isAccounts, "Reportee:", isReporteeManager);
                    console.log("[UpdateReward] Current Status:", reward.rewardStatus);


                    // Internal state tracking
                    const currentStage = reward.approvalStatus || reward.rewardStatus;
                    console.log("[UpdateReward] Current Internal Stage:", currentStage);

                    // LOGIC: Manager -> CEO -> Approved
                    // 1. Manager Step -> CEO
                    if (currentStage === 'Pending' && isReporteeManager) {
                        finalStatus = isCEO ? 'Approved' : 'Pending Authorization';
                    }
                    // 2. CEO Step -> Approved
                    else if (currentStage === 'Pending Authorization' && isCEO) {
                        finalStatus = 'Approved';
                    }
                    // CEO Override
                    else if (isCEO && reward.rewardStatus !== 'Rejected') {
                        finalStatus = 'Approved';
                    }
                }
                console.log("[UpdateReward] Calculated Final Status:", finalStatus);

                if (!approverDetails) {
                    console.warn("[UpdateReward] Approver Details missing. Using fallback.");
                    approverDetails = {
                        name: 'System User',
                        designation: 'Staff',
                        email: '',
                        department: 'General'
                    };
                }

                console.log("[UpdateReward] Final ApproverDetails:", approverDetails ? "Set" : "NULL");
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
            if (nextInternalStage === 'Pending Authorization') {
                console.log(`[UpdateReward] Triggering CEO Email logic`);

                const targetHOD = await getManagementHOD();
                const emailType = "CEO";

                console.log(`[UpdateReward] Target HOD (CEO):`, targetHOD ? targetHOD.email : 'None');

                if (targetHOD && approverDetails) {
                    const hodUser = await User.findOne({ employeeId: targetHOD.employeeId });
                    if (hodUser) {
                        console.log(`[UpdateReward] Found CEO User: ${hodUser.username} (${hodUser._id}). Assigning ticket.`);
                        reward.submittedTo = hodUser._id;

                        if (!reward.workflow) reward.workflow = [];

                        const currentPending = reward.workflow.find(w => w.status === 'Pending');
                        if (currentPending) {
                            currentPending.status = 'Approved';
                            currentPending.actionedAt = new Date();
                        }

                        // Add CEO Workflow Step
                        reward.workflow.push({
                            role: emailType,
                            assignedTo: hodUser._id,
                            status: 'Pending',
                            assignedAt: new Date()
                        });

                        // Set persistent approver field for historical tracking
                        // (Manager just approved, so technically managerApprovedBy = approverDetails.id, 
                        // but sticking to standard fields if we want to track who sent it to CEO)
                        reward.managerApprovedBy = approverDetails.id;

                        await sendHODAuthorizationEmail('Reward', reward, targetHOD, approverDetails);
                    } else {
                        console.error(`[UpdateReward] CRITICAL: Found CEO Employee but NO LINKED USER ACCOUNT found for ID ${targetHOD.employeeId}.`);
                    }
                } else {
                    console.warn(`[UpdateReward] Skipping CEO Email. Reason: HOD found=${!!targetHOD}, ApproverDetails=${!!approverDetails}`);
                }
            }

            // If status is being approved (Final), ensure metadata and workflow are updated
            if (finalStatus === 'Approved') {
                console.log("[UpdateReward] Entering Final Approval Block");
                if (!reward.approvedBy) reward.approvedBy = req.user?.id || null;

                if (!reward.approvedDate) reward.approvedDate = new Date();

                // Update CEO Workflow to Approved
                if (reward.workflow?.length) {

                    console.log(
                        `[UpdateReward] CEO Workflow Update Check: User=${req.user?._id}`
                    );

                    if (reward.workflow) {
                        console.log("Current Workflow:", JSON.stringify(reward.workflow, null, 2));
                    }

                    const ceoEntry = reward.workflow.find(w =>
                        w.role === 'CEO' &&
                        w.status === 'Pending'
                    );

                    console.log(
                        `[UpdateReward] Found Pending CEO Entry:`,
                        ceoEntry ? "YES" : "NO"
                    );

                    if (ceoEntry) {
                        ceoEntry.status = 'Approved';
                        ceoEntry.actionedAt = new Date();

                        // Explicitly ensure reward status is Approved
                        finalStatus = 'Approved';
                        reward.rewardStatus = 'Approved';
                    }
                }

            }
            // If status is being approved (Final), send email to recipient
            if (finalStatus === 'Approved' && currentStatus !== 'Approved') {
                try {
                    // Send email to the *Employee* (receiver of reward)
                    const employeeForEmail = await EmployeeBasic.findOne({ employeeId: reward.employeeId })
                        .select('firstName lastName email companyEmail')
                        .lean();

                    if (employeeForEmail) {
                        const empEmail = employeeForEmail.companyEmail || employeeForEmail.email;
                        const empName = `${employeeForEmail.firstName} ${employeeForEmail.lastName}`.trim();

                        if (empEmail) {
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

                                const subject = "Congratulations! Your Reward has been Approved";
                                const html = `
                                    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                                        <h2 style="color: #2e7d32;">Reward Appointment</h2>
                                        <p>Dear ${empName},</p>
                                        <p>We are pleased to inform you that your reward request for <strong>${reward.rewardType}</strong> (${reward.title}) has been <strong>Approved</strong>.</p>
                                        <p>You can view your reward details and download the certificate (if applicable) through the Employee Portal.</p>
                                        <br>
                                        <p>Best Regards,</p>
                                        <p>Management Team</p>
                                    </div>
                                `;

                                const mailOptions = {
                                    from: `"VeRP Notification" <${emailUser}>`,
                                    to: empEmail,
                                    subject: subject,
                                    html: html,
                                    attachments: []
                                };

                                // Prepare Permissions and User Payload for Puppeteer
                                const requestingUserId = req.user?.id || req.body.createdBy?._id;
                                let userPayload = { id: requestingUserId, role: 'Admin' }; // Default fallback
                                let token = req.headers.authorization?.split(' ')[1] || '';

                                try {
                                    if (requestingUserId) {
                                        const User = await import("../../models/User.js").then(m => m.default);
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
                                const baseUrl = process.env.FRONTEND_URL || origin || "http://localhost:3000";
                                const printUrl = `${baseUrl}/HRM/Reward/${reward._id}`;
                                const selector = '#certificate-container';

                                console.log(`[UpdateReward] Generating Certificate PDF via Puppeteer from: ${printUrl}`);

                                try {
                                    // Save first so Puppeteer sees updated status if needed (though certificate is static)
                                    // But we are in a block that hasn't saved yet? 
                                    // We must save 'reward' to DB to ensure consistency for the headless browser
                                    await reward.save();
                                    console.log("[UpdateReward] Reward saved to DB before PDF generation.");

                                    const pdfBuffer = await generatePdf(printUrl, token, userPayload, {}, selector);

                                    if (pdfBuffer) {
                                        mailOptions.attachments.push({
                                            filename: `Certificate-${reward.employeeId}.pdf`,
                                            content: pdfBuffer,
                                            contentType: 'application/pdf'
                                        });
                                        console.log(`[UpdateReward] Puppeteer PDF attached successfully. Size: ${pdfBuffer.length}`);
                                    }
                                } catch (pdfErr) {
                                    console.error("[UpdateReward] Puppeteer PDF Generation Failed:", pdfErr);
                                    // Continue sending email without attachment or handle error?
                                    // We'll continue.
                                }

                                await transporter.sendMail(mailOptions);
                                console.log(`[UpdateReward] SUCCESS: Reward approval email sent to ${empEmail}`);
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
                const pendingStep = reward.workflow.find(w => w.status === 'Pending' && (w.assignedTo?.toString() === (req.user?._id || approverUserId)?.toString() || w.role === 'CEO')); // CEO usually is the one rejecting at final stage, or Manager/HR

                if (pendingStep) {
                    pendingStep.status = 'Rejected';
                    pendingStep.actionedAt = new Date();
                } else {
                    // Fallback log rejection
                    reward.workflow.push({
                        role: approverDetails ? approverDetails.designation : 'Reviewer',
                        assignedTo: req.user?._id || approverUserId,
                        status: 'Rejected',
                        assignedAt: new Date(),
                        actionedAt: new Date()
                    });
                }

                // === REJECTION EMAIL LOGIC ===
                try {
                    const employeeForEmail = await EmployeeBasic.findOne({ employeeId: reward.employeeId })
                        .select('firstName lastName email companyEmail')
                        .lean();

                    if (employeeForEmail) {
                        const empEmail = employeeForEmail.companyEmail || employeeForEmail.email;
                        const empName = `${employeeForEmail.firstName} ${employeeForEmail.lastName}`.trim();

                        if (empEmail) {
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

                                const subject = "Update regarding your Reward Request";
                                const html = `
                                     <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                                         <h2 style="color: #d32f2f;">Reward Request Update</h2>
                                         <p>Dear ${empName},</p>
                                         <p>We regret to inform you that your <strong>${reward.rewardType}</strong> reward request has been rejected.</p>
                                         ${remarks ? `<p><strong>Remarks:</strong> ${remarks}</p>` : ''}
                                         <br>
                                         <p>Best Regards,</p>
                                         <p>HR Team</p>
                                     </div>
                                 `;

                                await transporter.sendMail({
                                    from: `"VeRP Notification" <${emailUser}>`,
                                    to: empEmail,
                                    subject: subject,
                                    html: html
                                });
                                console.log(`[UpdateReward] SUCCESS: Reward rejection email sent to ${empEmail}`);
                            } else {
                                console.error("[UpdateReward] ERROR: Missing EMAIL_USER or EMAIL_PASS for rejection email");
                            }
                        } else {
                            console.warn(`[UpdateReward] WARNING: No email found for rejected employee ${reward.employeeId}`);
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
        if (amount !== undefined) reward.amount = amount;
        if (description !== undefined) reward.description = description;
        if (awardedDate) reward.awardedDate = new Date(awardedDate);
        if (remarks !== undefined) reward.remarks = remarks;

        // Update certificate fields
        if (title !== undefined) reward.title = title;
        if (employeeName !== undefined) reward.employeeName = employeeName;
        if (certHeader !== undefined) reward.certHeader = certHeader;
        if (certSubHeader !== undefined) reward.certSubHeader = certSubHeader;
        if (certPresentationText !== undefined) reward.certPresentationText = certPresentationText;
        if (certSigner1Name !== undefined) reward.certSigner1Name = certSigner1Name;
        if (certSigner1Title !== undefined) reward.certSigner1Title = certSigner1Title;
        if (certSigner2Name !== undefined) reward.certSigner2Name = certSigner2Name;
        if (certSigner2Title !== undefined) reward.certSigner2Title = certSigner2Title;

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















