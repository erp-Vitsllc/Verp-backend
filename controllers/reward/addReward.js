import Reward from "../../models/Reward.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import nodemailer from "nodemailer";

/**
 * Generate auto-incrementing reward ID in format: re1322, re1323, etc.
 * Ensures uniqueness by checking existing IDs and using atomic operations
 */
const generateRewardId = async () => {
    try {
        // Get all rewards and find the highest number
        const rewards = await Reward.find({})
            .select('rewardId')
            .lean();

        let maxNumber = 0;

        // Extract numbers - support both 're' and 'RWD' prefixes for backward compatibility
        rewards.forEach(reward => {
            if (reward.rewardId) {
                // Check for new VEGA-RWD format
                let match = reward.rewardId.match(/VEGA-RWD-(\d+)/i);

                // Fallback to previous RWD format
                if (!match) {
                    match = reward.rewardId.match(/RWD(\d+)/i);
                }

                // Fallback to old 're' format
                if (!match) {
                    match = reward.rewardId.match(/re(\d+)/i);
                }

                if (match && match[1]) {
                    const num = parseInt(match[1], 10);
                    if (!isNaN(num) && num > maxNumber) {
                        maxNumber = num;
                    }
                }
            }
        });

        // Start from the next number
        let nextNumber = maxNumber + 1;

        // Format: VEGA-RWD-0001, etc.
        let newRewardId = `VEGA-RWD-${nextNumber.toString().padStart(4, '0')}`;

        // Ensure uniqueness - check if this ID already exists
        let exists = await Reward.findOne({ rewardId: newRewardId }).lean();
        let attempts = 0;
        const maxAttempts = 100;

        // Keep incrementing until we find a unique ID
        while (exists && attempts < maxAttempts) {
            nextNumber++;
            newRewardId = `VEGA-RWD-${nextNumber.toString().padStart(4, '0')}`;
            exists = await Reward.findOne({ rewardId: newRewardId }).lean();
            attempts++;
        }

        // If we couldn't find a unique sequential ID after max attempts (rare)
        if (attempts >= maxAttempts || exists) {
            const timestamp = Date.now().toString().slice(-4);
            const randomSuffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
            newRewardId = `VEGA-RWD-${timestamp}${randomSuffix}`;
        }

        return newRewardId;
    } catch (error) {
        console.error('Error generating reward ID:', error);
        // Fallback: use timestamp-based ID
        return `VEGA-RWD-${Date.now().toString().slice(-6)}`;
    }
};

export const addReward = async (req, res) => {
    try {
        console.log('=== ADD REWARD START ===');
        console.log('Request body:', JSON.stringify({ ...req.body, attachment: req.body.attachment ? '[ATTACHMENT]' : null }, null, 2));

        const { employeeId, rewardType, amount, description, title, giftName, rewardStatus, awardedDate, remarks, attachment } = req.body;

        // Basic validation
        if (!employeeId || !rewardType || !title) {
            return res.status(400).json({ message: "Employee ID, Title, and Reward Type are required" });
        }

        if (!rewardType) {
            return res.status(400).json({ message: "Reward Type is required" });
        }

        console.log('Looking up employee:', employeeId);
        // Verify employee exists
        const employee = await EmployeeBasic.findOne({ employeeId })
            .select('firstName lastName employeeId')
            .lean();

        if (!employee) {
            console.log('Employee not found');
            return res.status(404).json({ message: "Employee not found" });
        }

        // Ensure employee has required fields
        if (!employee.firstName || !employee.lastName) {
            console.error('Employee missing name fields:', employee);
            return res.status(400).json({ message: "Employee data is incomplete" });
        }

        const employeeName = `${employee.firstName || ''} ${employee.lastName || ''}`.trim();
        if (!employeeName) {
            console.error('Employee name is empty:', employee);
            return res.status(400).json({ message: "Employee name is required" });
        }

        console.log('Employee found:', employeeName);

        // Validate fields based on reward type
        if (rewardType === 'Cash Reward') {
            // Cash Reward: amount required
            if (!amount || isNaN(amount) || amount <= 0) {
                return res.status(400).json({ message: "Amount is required for Cash Reward" });
            }
        } else if (rewardType === 'Gift Reward') {
            // Gift Reward: gift name (description) and amount required
            if (!description || description.trim() === '' || !description.includes('Gift:')) {
                return res.status(400).json({ message: "Gift name is required for Gift Reward" });
            }
            if (!amount || isNaN(amount) || amount <= 0) {
                return res.status(400).json({ message: "Amount is required for Gift Reward" });
            }
        }
        // Certificate: no extra fields required beyond title (which is already checked)

        // Generate unique reward ID
        console.log('Generating reward ID...');
        let rewardId;
        try {
            rewardId = await generateRewardId();
            console.log('Generated reward ID:', rewardId);
        } catch (idError) {
            console.error('Error generating reward ID:', idError);
            console.error('ID error stack:', idError.stack);
            return res.status(500).json({
                message: "Failed to generate reward ID",
                error: process.env.NODE_ENV === 'development' ? idError.message : undefined
            });
        }

        // Build reward data object
        const rewardData = {
            rewardId,
            employeeId,
            employeeName: employeeName, // Use the validated employeeName from above
            rewardType,
            rewardStatus: rewardStatus || 'Pending',
            awardedDate: awardedDate ? new Date(awardedDate) : new Date(),
            remarks: remarks || '',
            remarks: remarks || '',
            title,
            createdBy: req.user ? req.user._id : null
        };

        // SNAPSHOT LOGIC: Find Reportee's USER Object for "submittedTo"
        // Only run if not Draft
        if (rewardData.rewardStatus !== 'Draft') {
            // 1. Get the EmployeeBasic of the Requester to find their Primary Reportee ID (ObjectId)
            const employeeForSnapshot = await EmployeeBasic.findOne({ employeeId })
                .select('primaryReportee')
                .lean();

            if (employeeForSnapshot && employeeForSnapshot.primaryReportee) {
                // 2. The primaryReportee in EmployeeBasic is an ObjectId ref to another EmployeeBasic
                // We need to fetch THAT Manager's EmployeeBasic to get their string 'employeeId' (e.g. "VITS005")
                // Because the User model links via the string 'employeeId', not the ObjectId.
                const managerBasic = await EmployeeBasic.findById(employeeForSnapshot.primaryReportee)
                    .select('employeeId companyEmail email workEmail firstName lastName')
                    .lean();

                if (managerBasic) {
                    // 3. Now find the User associated with that Manager
                    // Try by employeeId first
                    let reporteeUser = null;

                    if (managerBasic.employeeId) {
                        // Fix: Prefer the logged-in user if they are the manager, to avoid picking up duplicate/stale User accounts
                        if (req.user && req.user.employeeId === managerBasic.employeeId) {
                            reporteeUser = req.user;
                            console.log(`[AddReward] Manager is the requesting user. Using req.user (Preferred): ${req.user._id}`);
                        } else {
                            reporteeUser = await User.findOne({ employeeId: managerBasic.employeeId });
                        }
                    }

                    // If not found by ID, try email (fallback)
                    if (!reporteeUser) {
                        const managerEmail = managerBasic.companyEmail || managerBasic.workEmail || managerBasic.email;
                        if (managerEmail) {
                            console.log(`[AddReward] Manager User not found by ID. Trying email: ${managerEmail}`);
                            reporteeUser = await User.findOne({
                                $or: [
                                    { email: managerEmail },
                                    { username: managerEmail }
                                ]
                            });
                        }
                    }

                    if (reporteeUser) {
                        console.log(`[AddReward] Found Manager User: ${reporteeUser.username} (${reporteeUser._id}) for Reportee: ${managerBasic.employeeId}`);
                        rewardData.submittedTo = reporteeUser._id;

                        // WORKFLOW: Initial Pending Step (Pushed to Dashboard)
                        // The duration clock starts ticking for the Reportee from NOW.
                        rewardData.workflow = [{
                            role: 'Manager',
                            assignedTo: reporteeUser._id,
                            status: 'Pending',
                            assignedAt: new Date()
                        }];
                        console.log(`[AddReward] Dashboard Request Pushed for Manager: ${reporteeUser.username} at ${new Date().toISOString()}`);

                        // SNAPSHOT: Log Dashboard State
                        const currentPending = await Reward.countDocuments({
                            workflow: { $elemMatch: { assignedTo: reporteeUser._id, status: 'Pending' } },
                            rewardStatus: { $nin: ['Approved', 'Rejected', 'Withdrawn'] }
                        });

                        console.log("Stats Debug:", {
                            mode: 'Workflow Assignment',
                            currentUserId: req.user ? req.user._id : 'N/A',
                            requestTargetId: null,
                            managerId: managerBasic._id,
                            managerEmpId: managerBasic.employeeId,
                            targetUserFound: !!reporteeUser,
                            targetUserId: reporteeUser._id
                        });

                        console.log(`
    ===================================================
    [DASHBOARD PREVIEW - REWARD]
    ---------------------------------------------------
    Target Manager    : ${reporteeUser.username}
    Target User ID    : ${reporteeUser._id}
    Target Emp ID     : ${managerBasic.employeeId}
    Target Email      : ${reporteeUser.email || reporteeUser.companyEmail}
    ---------------------------------------------------
    Pending Rewards (Pre-Save) : ${currentPending}
    New Item Pushed            : +1
    ---------------------------------------------------
    TOTAL PENDING ON DASHBOARD : ${currentPending + 1}
    ===================================================`);
                    } else {
                        console.warn(`[AddReward] Manager (ID: ${managerBasic.employeeId}) has no User account linked. Dashboard request cannot be created.`);
                    }
                } else {
                    console.warn(`[AddReward] Primary Reportee (ID: ${employeeForSnapshot.primaryReportee}) not found in EmployeeBasic.`);
                }
            }
        }

        // Add amount based on reward type
        if (rewardType === 'Cash Reward' || rewardType === 'Gift Reward') {
            rewardData.amount = parseFloat(amount);
        } else {
            // Certificate doesn't need amount
            rewardData.amount = null;
        }

        // Add description based on reward type
        if (rewardType === 'Gift Reward') {
            rewardData.description = description || '';
        } else {
            // Cash Reward and Certificate don't need description
            rewardData.description = '';
        }

        // Create and save reward
        console.log('Creating reward object...');
        console.log('Reward data:', JSON.stringify({ ...rewardData, attachment: rewardData.attachment ? '[ATTACHMENT]' : null }, null, 2));

        let reward;
        try {
            reward = new Reward(rewardData);
            console.log('Reward object created');
        } catch (createError) {
            console.error('Error creating Reward object:', createError);
            console.error('Create error stack:', createError.stack);
            return res.status(500).json({
                message: "Failed to create reward object",
                error: process.env.NODE_ENV === 'development' ? createError.message : undefined
            });
        }

        // Validate before saving
        console.log('Validating reward...');
        const validationError = reward.validateSync();
        if (validationError) {
            console.error('Validation error:', validationError.errors);
            const errors = Object.values(validationError.errors).map(err => err.message).join(', ');
            return res.status(400).json({
                message: errors || "Validation error",
                errors: validationError.errors
            });
        }
        console.log('Validation passed');

        console.log('Saving reward to database...');
        try {
            const savedReward = await reward.save();
            console.log('Reward saved successfully!');
            console.log('Saved reward ID:', savedReward.rewardId);

            // === EMAIL NOTIFICATION LOGIC ===
            if (savedReward.rewardStatus !== 'Draft') {
                try {
                    // Fetch complete employee details to get reportee info
                    // We need to fetch again or populate the initial fetch if we didn't before.
                    // Since we need primaryReportee which is a ref, we should populate it.
                    // The initial fetch at line 97 was lean and selected specific fields.
                    // Let's do a fresh fetch to be safe and clean.
                    const employeeForEmail = await EmployeeBasic.findOne({ employeeId })
                        .populate('primaryReportee', 'firstName lastName email companyEmail employeeId')
                        .select('firstName lastName employeeId department designation primaryReportee')
                        .lean();

                    if (employeeForEmail && employeeForEmail.primaryReportee && employeeForEmail.primaryReportee.email) {
                        const reportee = employeeForEmail.primaryReportee;
                        const reporteeEmail = reportee.companyEmail || reportee.workEmail || reportee.email;
                        const reporteeName = `${reportee.firstName} ${reportee.lastName}`.trim();

                        // Employee Details
                        const empName = `${employeeForEmail.firstName} ${employeeForEmail.lastName}`;
                        const empId = employeeForEmail.employeeId;
                        const empDept = employeeForEmail.department || 'N/A';
                        const empDesig = employeeForEmail.designation || 'N/A';

                        // Email Credentials
                        // Check all possible environment variable names
                        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
                        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

                        if (emailUser && emailPass) {
                            // Determine SMTP host based on email domain or preference
                            let smtpHost = "smtp.office365.com"; // Default to Outlook
                            let smtpPort = 587;

                            if (emailUser.includes('@gmail.com') || process.env.GMAIL_USER) {
                                smtpHost = "smtp.gmail.com";
                                // For secure: false (TLS), use 587
                            }

                            console.log(`Using SMTP Host: ${smtpHost} for user: ${emailUser}`);

                            const transporter = nodemailer.createTransport({
                                host: smtpHost,
                                port: smtpPort,
                                secure: false, // true for 465, false for other ports
                                auth: {
                                    user: emailUser,
                                    pass: emailPass,
                                },
                            });

                            const subject = "Request for Reward Approval";

                            // Use Configured URL or localhost fallback
                            const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
                            const rewardUrl = `${baseUrl}/HRM/Reward/${savedReward.rewardId}`;

                            const html = `
                                <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
                                    <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-bottom: 1px solid #eee;">
                                        <h2 style="margin: 0; color: #1a2e35;">Request for Reward Approval</h2>
                                    </div>
                                    
                                    <div style="padding: 20px;">
                                        <p>Dear <strong>${reporteeName}</strong>,</p>
                                        
                                        <p>We would like to inform you that a formal request for a <strong>${rewardType}</strong> has been initiated for the following employee:</p>
                                        
                                        <div style="background-color: #fce4ec; border-left: 4px solid #d81b60; padding: 15px; margin: 20px 0; border-radius: 4px;">
                                            <p style="margin: 5px 0;"><strong>Employee Name:</strong> ${empName}</p>
                                            <p style="margin: 5px 0;"><strong>Employee ID:</strong> ${empId}</p>
                                            <p style="margin: 5px 0;"><strong>Department:</strong> ${empDept}</p>
                                            <p style="margin: 5px 0;"><strong>Designation:</strong> ${empDesig}</p>
                                            <p style="margin: 5px 0;"><strong>Reward Type:</strong> ${rewardType}</p>
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
                            `;

                            // Send Email
                            try {
                                const info = await transporter.sendMail({
                                    from: `"VeRP System" <${emailUser}>`,
                                    to: reporteeEmail,
                                    subject: subject,
                                    html: html,
                                });
                                console.log(`[DEBUG] Email sent successfully. MessageID: ${info.messageId}`);
                                console.log(`Approval email sent to ${reporteeEmail}`);
                            } catch (sendError) {
                                console.error('[DEBUG] Transporter Send Error:', sendError);
                            }
                        } else {
                            console.log('Email credentials missing, skipping notification.');
                        }
                    } else {
                        console.log('No primary reportee found or email missing, skipping notification.');
                    }
                } catch (emailError) {
                    console.error('Failed to send approval email:', emailError);
                    // Don't block the response, just log the error
                }
            }

            return res.status(201).json({
                message: "Reward created successfully and approval request sent to reportee.",
                reward: savedReward
            });
        } catch (saveError) {
            console.error('=== ERROR SAVING REWARD ===');
            console.error('Save error:', saveError);
            console.error('Save error code:', saveError.code);
            console.error('Save error name:', saveError.name);
            console.error('Save error message:', saveError.message);
            console.error('Save error stack:', saveError.stack);

            // If it's a duplicate key error, handle it in the outer catch
            if (saveError.code === 11000) {
                throw saveError; // Re-throw to be caught by outer catch for retry logic
            }

            // For other save errors, return immediately
            if (saveError.name === 'ValidationError') {
                const validationErrors = Object.values(saveError.errors || {})
                    .map(err => err.message)
                    .join(', ');
                return res.status(400).json({
                    message: validationErrors || "Validation error",
                    errors: saveError.errors
                });
            }

            return res.status(500).json({
                message: "Failed to save reward",
                error: process.env.NODE_ENV === 'development' ? saveError.message : undefined
            });
        }
    } catch (error) {
        console.error('=== ERROR CREATING REWARD ===');
        console.error('Error:', error);
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error code:', error.code);
        console.error('Error stack:', error.stack);

        if (error.code === 11000) {
            // Duplicate key error - rewardId already exists
            // Regenerate ID and retry once
            try {
                const { employeeId, rewardType, rewardStatus, amount, description, awardedDate, remarks, attachment } = req.body;

                const employee = await EmployeeBasic.findOne({ employeeId })
                    .select('firstName lastName employeeId')
                    .lean();

                if (!employee) {
                    return res.status(404).json({ message: "Employee not found" });
                }

                // Regenerate reward ID
                const newRewardId = await generateRewardId();

                // Rebuild reward data
                // Re-validate employee
                const retryEmployee = await EmployeeBasic.findOne({ employeeId })
                    .select('firstName lastName employeeId')
                    .lean();

                if (!retryEmployee || !retryEmployee.firstName || !retryEmployee.lastName) {
                    return res.status(400).json({ message: "Employee data is incomplete" });
                }

                const retryEmployeeName = `${retryEmployee.firstName} ${retryEmployee.lastName}`.trim();

                const retryRewardData = {
                    rewardId: newRewardId,
                    employeeId,
                    employeeName: retryEmployeeName,
                    rewardType,
                    rewardStatus: rewardStatus || 'Pending',
                    awardedDate: awardedDate ? new Date(awardedDate) : new Date(),
                    remarks: remarks || ''
                };

                if (rewardType === 'Cash Reward' || rewardType === 'Gift Reward') {
                    retryRewardData.amount = parseFloat(amount);
                } else {
                    retryRewardData.amount = null;
                }

                if (rewardType === 'Gift Reward') {
                    retryRewardData.description = description || '';
                } else {
                    retryRewardData.description = '';
                }

                // Handle attachment for retry
                if (attachment && attachment.data) {
                    try {
                        const attachmentDataStr = typeof attachment.data === 'string' ? attachment.data : String(attachment.data);

                        const uploadResult = await uploadDocumentToS3(
                            attachmentDataStr,
                            `rewards/${employeeId}`,
                            attachment.name || 'reward-attachment.pdf',
                            'raw'
                        );

                        retryRewardData.attachment = {
                            url: uploadResult.url,
                            publicId: uploadResult.publicId,
                            name: attachment.name || '',
                            mimeType: attachment.mimeType || 'application/pdf'
                        };
                    } catch (uploadError) {
                        retryRewardData.attachment = {
                            data: attachment.data,
                            name: attachment.name || '',
                            mimeType: attachment.mimeType || 'application/pdf'
                        };
                    }
                }

                const retryReward = new Reward(retryRewardData);
                await retryReward.save();

                return res.status(201).json({
                    message: "Reward created successfully",
                    reward: retryReward
                });
            } catch (retryError) {
                console.error('Retry failed:', retryError);
                console.error('Retry error code:', retryError.code);

                // If retry also fails with duplicate, use timestamp-based ID as final fallback
                if (retryError.code === 11000) {
                    try {
                        const { employeeId, rewardType, rewardStatus, amount, description, awardedDate, remarks, attachment } = req.body;

                        const employee = await EmployeeBasic.findOne({ employeeId })
                            .select('firstName lastName employeeId')
                            .lean();

                        if (!employee) {
                            return res.status(404).json({ message: "Employee not found" });
                        }

                        // Use timestamp-based ID as final fallback
                        const fallbackId = `re${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

                        // Re-validate employee for fallback
                        const fallbackEmployee = await EmployeeBasic.findOne({ employeeId })
                            .select('firstName lastName employeeId')
                            .lean();

                        if (!fallbackEmployee || !fallbackEmployee.firstName || !fallbackEmployee.lastName) {
                            return res.status(400).json({ message: "Employee data is incomplete" });
                        }

                        const fallbackEmployeeName = `${fallbackEmployee.firstName} ${fallbackEmployee.lastName}`.trim();

                        const fallbackRewardData = {
                            rewardId: fallbackId,
                            employeeId,
                            employeeName: fallbackEmployeeName,
                            rewardType,
                            rewardStatus: rewardStatus || 'Pending',
                            awardedDate: awardedDate ? new Date(awardedDate) : new Date(),
                            remarks: remarks || ''
                        };

                        if (rewardType === 'Cash Reward' || rewardType === 'Gift Reward') {
                            fallbackRewardData.amount = parseFloat(amount);
                        } else {
                            fallbackRewardData.amount = null;
                        }

                        if (rewardType === 'Gift Reward') {
                            fallbackRewardData.description = description || '';
                        } else {
                            fallbackRewardData.description = '';
                        }

                        if (attachment && attachment.data) {
                            try {
                                const attachmentDataStr = typeof attachment.data === 'string' ? attachment.data : String(attachment.data);

                                const uploadResult = await uploadDocumentToS3(
                                    attachmentDataStr,
                                    `rewards/${employeeId}`,
                                    attachment.name || 'reward-attachment.pdf',
                                    'raw'
                                );

                                fallbackRewardData.attachment = {
                                    url: uploadResult.url,
                                    publicId: uploadResult.publicId,
                                    name: attachment.name || '',
                                    mimeType: attachment.mimeType || 'application/pdf'
                                };
                            } catch (uploadError) {
                                fallbackRewardData.attachment = {
                                    data: attachment.data,
                                    name: attachment.name || '',
                                    mimeType: attachment.mimeType || 'application/pdf'
                                };
                            }
                        }

                        const fallbackReward = new Reward(fallbackRewardData);
                        await fallbackReward.save();

                        return res.status(201).json({
                            message: "Reward created successfully",
                            reward: fallbackReward
                        });
                    } catch (fallbackError) {
                        console.error('Fallback also failed:', fallbackError);
                        return res.status(500).json({
                            message: "Failed to create reward. Please try again."
                        });
                    }
                }

                return res.status(400).json({
                    message: retryError.message || "Reward ID conflict. Please try again."
                });
            }
        }

        if (error.name === 'ValidationError') {
            const validationErrors = Object.values(error.errors || {})
                .map(err => err.message)
                .join(', ');
            return res.status(400).json({
                message: validationErrors || "Validation error",
                errors: error.errors
            });
        }

        console.error('=== UNEXPECTED ERROR ===');
        console.error('Error details:', {
            name: error.name,
            message: error.message,
            code: error.code,
            stack: error.stack
        });

        return res.status(500).json({
            message: error.message || "Failed to create reward. Please try again.",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};
