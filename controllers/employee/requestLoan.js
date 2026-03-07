import nodemailer from "nodemailer";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import Loan from "../../models/Loan.js";
import EmployeeSalary from "../../models/EmployeeSalary.js";
import User from "../../models/User.js";
import Company from "../../models/Company.js";
import { getCompleteEmployee } from "../../services/employeeService.js";


/**
 * Generate sequential ID based on type
 * Loan -> loan001, loan002...
 * Advance -> adv001, adv002...
 */
const generateLoanId = async (type) => {
    try {
        const isAdvance = (type && type.toLowerCase().includes('advance'));
        const prefix = isAdvance ? 'VEGA-ADV-' : 'VEGA-LON-';

        // Find existing IDs with the specific prefix pattern
        const regex = new RegExp(`^${prefix}(\\d+)$`, 'i');

        // We use find().lean() and process in memory for safer regex matching across potentially mixed legacy ID types
        // Or specific regex query. 
        // Let's use specific regex query but sorting might be tricky if formats mix. 
        // Best to load relevant IDs and calc max.

        const records = await Loan.find({ loanId: { $regex: regex } }).select('loanId').lean();

        let maxNum = 0;
        records.forEach(r => {
            const match = r.loanId.match(regex);
            if (match && match[1]) {
                const num = parseInt(match[1], 10);
                if (num > maxNum) maxNum = num;
            }
        });

        // If no VEGA- format found, fallback check for legacy 'loan001' or 'adv001' just to be safe they don't overlap?
        // Actually, 'VEGA-LON-0001' is distinct from 'loan001'. No overlap risk in string uniqueness.
        // We can start fresh sequence for the new format if no previous VEGA- IDs exist.

        const nextNum = maxNum + 1;
        return `${prefix}${nextNum.toString().padStart(4, '0')}`;

    } catch (error) {
        console.error('Error generating loan ID:', error);
        const prefix = (type && type.toLowerCase().includes('advance')) ? 'VEGA-ADV-' : 'VEGA-LON-';
        const timestamp = Date.now().toString().slice(-4);
        return `${prefix}ERR-${timestamp}`;
    }
};

export const requestLoan = async (req, res) => {
    const { employeeId, type, amount, duration, reason, employeeObjectId, monthStart, status } = req.body;

    try {
        // 1. Fetch Employee Info FIRST to identify Manager
        const employeeBasic = await getCompleteEmployee(employeeObjectId);

        if (!employeeBasic) {
            return res.status(404).json({ message: "Employee details not found." });
        }

        if (!employeeBasic.company) {
            return res.status(400).json({ message: "Employee is not linked to any company. Cannot proceed." });
        }

        let hrResp = null;
        if (employeeBasic.company?._id) {
            const applicantCompany = await Company.findById(employeeBasic.company._id);
            hrResp = applicantCompany?.responsibilities?.find(r => r.category === 'hr' && r.status === 'Active');
        }
        const targetStatus = status === 'Pending' ? 'Pending HR' : (status || 'Draft');

        if (status === 'Pending' && !hrResp) {
            return res.status(400).json({ message: "HR Admin not assigned for your company. Please wait until an HR is assigned." });
        }

        // --- VALIDATION: Existing Loan Check ---
        // Block if employee already has an Approved or In-Progress loan/advance
        const existingLoan = await Loan.findOne({
            employeeId: employeeBasic.employeeId,
            status: { $in: ['Approved', 'Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'] }
        }).lean();

        if (existingLoan) {
            const isApproved = existingLoan.status === 'Approved';
            return res.status(400).json({
                message: isApproved
                    ? `This employee already has an Approved ${existingLoan.type} (${existingLoan.loanId}). A new request cannot be submitted while a loan is active.`
                    : `This employee already has a ${existingLoan.type} application in progress (${existingLoan.loanId} - ${existingLoan.status}).`
            });
        }

        // --- VALIDATION: Probation & Salary Checks ---
        const salaryRecord = await EmployeeSalary.findOne({ employeeId: employeeBasic.employeeId });

        if (type && type.includes('Loan') && employeeBasic.status === 'Probation') {
            return res.status(400).json({ message: "Employees on probation cannot apply for personal loans." });
        }

        if (type && type.includes('Advance')) {
            // Rule: Advance Amount <= Monthly Salary
            if (salaryRecord && Number(amount) > salaryRecord.totalSalary) {
                return res.status(400).json({
                    message: `Advance amount cannot exceed your monthly salary (AED ${salaryRecord.totalSalary}).`
                });
            }

            // Rule: Probation -> Max 1 Month Duration
            if (employeeBasic.status === 'Probation' && parseInt(duration) > 1) {
                return res.status(400).json({ message: "Employees on probation can only apply for a 1-month salary advance." });
            }
        }
        // ---------------------------------------------

        const newLoanId = await generateLoanId(type);

        // 2. Create Loan Record with Sticky Assignment
        const loanData = {
            loanId: newLoanId,
            employeeId, // String ID
            employeeObjectId, // MongoDB ObjectId
            type,
            amount,
            duration,
            monthStart: monthStart || '',
            reason,
            status: targetStatus,
            approvalStatus: targetStatus,
            createdBy: req.user ? req.user.id : null,
            workflow: []
        };

        // Handle attachment if provided in request body
        const { attachment } = req.body;
        if (attachment && attachment.data) {
            try {
                const { uploadDocumentToS3 } = await import("../../utils/s3Upload.js");
                console.log(`[RequestLoan] Processing attachment: ${attachment.name}`);
                const uploadResult = await uploadDocumentToS3(
                    attachment.data,
                    `loans/${employeeId}`,
                    attachment.name || 'loan-attachment.pdf',
                    'raw'
                );

                loanData.attachment = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: attachment.name || '',
                    mimeType: attachment.mimeType || 'application/pdf'
                };
                console.log(`[RequestLoan] Attachment uploaded to S3: ${uploadResult.url}`);
            } catch (uploadError) {
                console.error(`[RequestLoan] Attachment upload failed:`, uploadError);
                // Continue without attachment if upload fails
            }
        }

        if (targetStatus === 'Pending HR') {
            let hrUser = null;

            if (hrResp.employeeId) {
                hrUser = await User.findOne({ employeeId: hrResp.employeeId });
            }

            const assignmentId = hrUser ? hrUser._id : hrResp.empObjectId;

            loanData.submittedTo = assignmentId;
            loanData.workflow = [{
                role: 'HR Admin',
                assignedTo: assignmentId,
                status: 'Pending',
                assignedAt: new Date()
            }];

            console.log(`[RequestLoan] Loan Pushed for HR: ${hrResp.employeeId} (Account: ${hrUser ? 'Found' : 'Missing'})`);
        }

        const newLoan = new Loan(loanData);
        const savedLoan = await newLoan.save();

        // 3. Sync with Dashboard Action Table
        if (targetStatus === 'Pending HR') {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            await syncDashboardAction({
                requestId: savedLoan._id,
                requestType: 'Loan',
                assignedTo: hrResp.empObjectId, // Use Employee Object ID for assignment
                status: 'Pending',
                subjectEmployee: employeeBasic,
                extra1: `AED ${amount}`,
                extra2: `${duration} Months`
            });
        }

        // 4. Send Email ONLY if Submit for Approval
        if (targetStatus === 'Pending HR' && hrResp) {
            // Find HR employee basic to get their email
            const hrEmployee = await EmployeeBasic.findById(hrResp.empObjectId);
            const reporteeEmail = hrEmployee?.companyEmail || hrEmployee?.workEmail || hrEmployee?.email || hrResp.email || 'hr@vitsllc.com';

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
                    const reporteeName = hrEmployee ? `${hrEmployee.firstName || ""} ${hrEmployee.lastName || ""}`.trim() : 'HR Administrator';
                    const subject = `[NEW] ${type} Application: ${employeeName}`;

                    // Dynamic URL
                    const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
                    const baseUrl = process.env.FRONTEND_URL || origin || "http://localhost:3000";
                    const typeSlug = type ? type.replace(/\s+/g, '-') : 'Loan';
                    const actionUrl = `${baseUrl}/HRM/LoanAndAdvance/${typeSlug}-${savedLoan._id}`;

                    const html = `
                        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                            <div style="background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); color: white; padding: 25px; text-align: center;">
                                <h2 style="margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.025em;">${type.toUpperCase()} APPLICATION</h2>
                                <p style="margin: 5px 0 0 0; opacity: 0.9; font-size: 14px;">Reference ID: ${newLoanId}</p>
                            </div>
                            <div style="padding: 30px; background-color: #ffffff;">
                                <p style="font-size: 16px;">Hello <strong>${reporteeName}</strong>,</p>
                                <p style="color: #4b5563;"><strong>${employeeName}</strong> has submitted a new application for a ${type}. Please review the details below:</p>
                                
                                <div style="background-color: #f8fafc; padding: 25px; border-radius: 10px; border-left: 4px solid #0d9488; margin: 25px 0;">
                                    <table style="width: 100%; border-collapse: collapse;">
                                        <tr>
                                            <td style="padding: 8px 0; color: #64748b; font-size: 13px; width: 40%;"><strong>Applied By:</strong></td>
                                            <td style="padding: 8px 0; color: #1e293b; font-size: 14px; font-weight: 600;">${employeeName} (${employeeId})</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 8px 0; color: #64748b; font-size: 13px;"><strong>Amount:</strong></td>
                                            <td style="padding: 8px 0; color: #0d9488; font-size: 16px; font-weight: 800;">AED ${Number(amount).toLocaleString()}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 8px 0; color: #64748b; font-size: 13px;"><strong>Current Status:</strong></td>
                                            <td style="padding: 8px 0;"><span style="background-color: #fef3c7; color: #92400e; padding: 4px 10px; border-radius: 9999px; font-size: 11px; font-weight: 800; text-transform: uppercase;">${targetStatus}</span></td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 8px 0; color: #64748b; font-size: 13px;"><strong>Created On:</strong></td>
                                            <td style="padding: 8px 0; color: #1e293b; font-size: 14px;">${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 8px 0; color: #64748b; font-size: 13px;"><strong>Duration:</strong></td>
                                            <td style="padding: 8px 0; color: #1e293b; font-size: 14px;">${duration} Months</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 8px 0; color: #64748b; font-size: 13px;"><strong>Reason:</strong></td>
                                            <td style="padding: 8px 0; color: #475569; font-size: 14px; font-style: italic;">"${reason}"</td>
                                        </tr>
                                    </table>
                                </div>

                                <div style="margin-top: 20px; border-top: 1px dashed #e2e8f0; padding-top: 20px;">
                                    <h4 style="margin: 0 0 10px 0; font-size: 14px; color: #1e293b; text-transform: uppercase; letter-spacing: 0.05em;">Initial Workflow Steps:</h4>
                                    <div style="font-size: 12px; color: #64748b;">
                                        <div style="margin-bottom: 5px;">✅ 1. Submission (Completed)</div>
                                        <div style="margin-bottom: 5px;">⏳ 2. HR Verification (Pending)</div>
                                        <div style="margin-bottom: 5px;">◽ 3. Finance Approval</div>
                                        <div style="margin-bottom: 5px;">◽ 4. Final Management Authorization</div>
                                    </div>
                                </div>
                                
                                <p style="text-align: center; margin: 40px 0 20px 0;">
                                    <a href="${actionUrl}" style="background: #0d9488; color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 16px; box-shadow: 0 4px 6px -1px rgba(13, 148, 136, 0.3);">Review & Action</a>
                                </p>
                                
                                <p style="font-size: 12px; color: #94a3b8; text-align: center;">This is an automated notification from the VeRP System. Please do not reply directly to this email.</p>
                            </div>
                        </div>
                    `;

                    const mailOptions = {
                        from: `"VeRP Portal" <${emailUser}>`,
                        to: reporteeEmail,
                        subject,
                        html,
                        attachments: []
                    };

                    // Add attachment if it exists
                    if (savedLoan.attachment && savedLoan.attachment.url) {
                        mailOptions.attachments.push({
                            filename: savedLoan.attachment.name || 'Loan-Attachment.pdf',
                            path: savedLoan.attachment.url
                        });
                        console.log(`[Loan] Attachment added to email for ${reporteeEmail}: ${savedLoan.attachment.url}`);
                    }

                    await transporter.sendMail(mailOptions);
                    console.log(`[Loan] Email sent to ${reporteeEmail}`);
                }
            }
        }

        res.status(201).json({ message: `${type} application ${targetStatus === 'Draft' ? 'saved as draft' : 'submitted successfully'}.`, loan: savedLoan });

    } catch (error) {
        console.error("Error requesting loan:", error);
        res.status(500).json({ message: "Failed to submit application." });
    }
};
