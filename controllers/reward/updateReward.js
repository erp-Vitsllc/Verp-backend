import Reward from "../../models/Reward.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import nodemailer from "nodemailer";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { sendHODAuthorizationEmail } from "../../utils/sendHODAuthorizationEmail.js";

export const updateReward = async (req, res) => {
    try {
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
            let approverDetails = null;

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

                console.log("[UpdateReward] Approver Logic Start. UserID:", approverUserId, "Status:", rewardStatus);

                // Get Approver Employee Profile
                if (approverUserId) {
                    // Check if Admin
                    const userObj = await User.findById(approverUserId);
                    const isAdmin = userObj?.isAdmin || userObj?.role === 'Admin' || userObj?.role === 'SuperAdmin';

                    if (isAdmin) {
                        approverDetails = { name: 'Admin', designation: 'Administrator', isAdmin: true };
                        console.log("[UpdateReward] Approver is Admin");
                    } else {
                        // Find Employee
                        approverBasic = await EmployeeBasic.findOne({
                            $or: [{ _id: approverUserId }, { employeeId: userObj?.employeeId }] // Best effort match
                        });

                        if (!approverBasic && userObj?.employeeId) {
                            approverBasic = await EmployeeBasic.findOne({ employeeId: userObj.employeeId });
                        }

                        console.log("[UpdateReward] Approver Employee Found:", approverBasic ? approverBasic.employeeId : 'No');
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
                    const isCEO = approverBasic.department && approverBasic.department.toLowerCase() === 'management' &&
                        ['ceo', 'c.e.o', 'c.e.o.', 'director', 'managing director', 'general manager'].includes(approverBasic.designation?.toLowerCase());

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

                    // LOGIC: Simplified 2-Stage Flow (Requester -> Reportee -> CEO)
                    // 1. Pending -> Reportee -> Pending Authorization (CEO)
                    // 2. Pending Authorization -> CEO -> Approved

                    if (reward.rewardStatus === 'Pending' && isReporteeManager) {
                        finalStatus = 'Pending Authorization';
                    }
                    else if (reward.rewardStatus === 'Pending Authorization' && isCEO) {
                        finalStatus = 'Approved';
                    }
                    else if (isCEO && reward.rewardStatus !== 'Rejected') {
                        // CEO Override if needed
                    }
                }

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

            // Update Status
            reward.rewardStatus = finalStatus;

            // Handle Email Notifications for Pending States (HR, Accounts, CEO)
            if (['Pending Authorization'].includes(finalStatus)) {
                console.log(`[UpdateReward] Triggering Email logic for ${finalStatus}`);

                let targetHOD = null;

                if (finalStatus === 'Pending Authorization') {
                    targetHOD = await getManagementHOD();
                }

                console.log(`[UpdateReward] Target HOD for ${finalStatus}:`, targetHOD ? targetHOD.email : 'None');

                // PUSH TO DASHBOARD: Update workflow & submittedTo
                if (targetHOD && approverDetails) {
                    // Update submittedTo snapshot if needed (though usually for direct reports)
                    // We can skip setting submittedTo for intermediate steps or set it effectively
                    const hodUser = await import("../../models/User.js").then(m => m.default.findOne({ employeeId: targetHOD.employeeId }));
                    if (hodUser) {
                        console.log(`[UpdateReward] Found HOD User: ${hodUser.username} (${hodUser._id}). Assigning ticket.`);
                        console.log(`[UpdateReward] VISIBILITY CHECK: Ticket is being assigned EXCLUSIVELY to UserID: ${hodUser._id}`);
                        console.log(`[UpdateReward] This item will ONLY appear on the dashboard of: ${targetHOD.firstName} ${targetHOD.lastName}`);

                        reward.submittedTo = hodUser._id;

                        // WORKFLOW UPDATES
                        if (finalStatus === 'Pending Authorization') {
                            // 1. Mark Manager (Reportee) as Approved
                            if (!reward.workflow || reward.workflow.length === 0) {
                                reward.workflow = [];
                            }

                            const managerEntry = reward.workflow.find(w =>
                                w.status === 'Pending' &&
                                (w.role === 'Manager' || w.assignedTo?.toString() === (req.user?._id || approverDetails.id)?.toString())
                            );

                            if (managerEntry) {
                                managerEntry.status = 'Approved';
                                managerEntry.actionedAt = new Date();
                            } else {
                                // Fallback: Insert completed Manager step
                                reward.workflow.push({
                                    role: 'Manager',
                                    assignedTo: req.user?._id || approverDetails.id,
                                    status: 'Approved',
                                    assignedAt: reward.createdAt,
                                    actionedAt: new Date()
                                });
                            }

                            // 2. Push CEO
                            reward.workflow.push({
                                role: 'CEO',
                                assignedTo: hodUser._id,
                                status: 'Pending',
                                assignedAt: new Date()
                            });
                        }

                    } else {
                        console.error(`[UpdateReward] CRITICAL: Found HOD Employee (${targetHOD.firstName}) but NO LINKED USER ACCOUNT found for ID ${targetHOD.employeeId}. Request will be unassigned!`);
                    }

                    // Send Email
                    // Reuse sendHODAuthorizationEmail but maybe customize subject internally if needed
                    // For now, it sends "Authorization Required", which fits.
                    await sendHODAuthorizationEmail('Reward', reward, targetHOD, approverDetails);
                } else {
                    console.warn(`[UpdateReward] Skipping Email for ${finalStatus}. Reason: HOD found=${!!targetHOD}, ApproverDetails=${!!approverDetails}`);
                    if (!targetHOD) console.warn("[UpdateReward] Failed to find HOD for", finalStatus);
                }
            }

            // If status is being approved (Final), set approvedBy and approvedDate
            if (finalStatus === 'Approved' && !reward.approvedBy) {
                reward.approvedBy = req.user?.id || null;
                reward.approvedDate = new Date();

                // Update CEO Workflow to Approved
                if (reward.workflow) {
                    const ceoEntry = reward.workflow.find(w => w.role === 'CEO' && w.status === 'Pending');
                    if (ceoEntry) {
                        ceoEntry.status = 'Approved';
                        ceoEntry.actionedAt = new Date();
                    } else {
                        // Fallback logic for direct approval or admin override
                        reward.workflow.push({
                            role: 'CEO',
                            assignedTo: req.user?._id,
                            status: 'Approved',
                            assignedAt: new Date(),
                            actionedAt: new Date()
                        });
                    }
                }

                // === EMAIL NOTIFICATION LOGIC (Existing for Employee) ===
                try {
                    // Send email to the *Employee* (receiver of reward)
                    const employeeForEmail = await EmployeeBasic.findOne({ employeeId: reward.employeeId })
                        .select('firstName lastName email companyEmail employeeId')
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
                                    secure: false, // true for 465, false for other ports
                                    auth: { user: emailUser, pass: emailPass }
                                });

                                // Get Approver Name Dynamic Logic (Simplified as we have details)
                                let approverName = approverDetails ? approverDetails.name : "Admin";

                                const subject = "Congratulations! You have received a Reward";
                                const html = `
                                     <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                                         <h2 style="color: #1a2e35;">Congratulations, ${empName}!</h2>
                                         <p>We are pleased to inform you that your <strong>${reward.rewardType}</strong> reward has been approved.</p>
                                         <p>This reward was approved by <strong>${approverName}</strong>.</p>
                                         <p>Please find your certificate attached to this email.</p>
                                         <br>
                                         <p>Best Regards,</p>
                                         <p>HR Team</p>
                                     </div>
                                 `;

                                const mailOptions = {
                                    from: `"VeRP Notification" <${emailUser}>`,
                                    to: empEmail,
                                    subject: subject,
                                    html: html,
                                    attachments: []
                                };

                                // Add PDF Attachment if exists
                                if (req.body.certificatePdf) {
                                    mailOptions.attachments.push({
                                        filename: `Certificate-${reward.employeeId}.pdf`,
                                        content: req.body.certificatePdf,
                                        encoding: 'base64'
                                    });
                                }

                                await transporter.sendMail(mailOptions);
                                console.log(`Reward approval email sent to ${empEmail}`);
                            }
                        }
                    }
                } catch (emailError) {
                    console.error("Failed to send reward approval email:", emailError);
                }
            } else if (rewardStatus === 'Rejected') {
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
                                console.log(`Reward rejection email sent to ${empEmail}`);
                            }
                        }
                    }
                } catch (emailError) {
                    console.error("Failed to send reward rejection email:", emailError);
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













