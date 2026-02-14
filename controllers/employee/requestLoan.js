import nodemailer from "nodemailer";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import Loan from "../../models/Loan.js";
import EmployeeSalary from "../../models/EmployeeSalary.js";
import User from "../../models/User.js";
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

        const reportee = employeeBasic.primaryReportee;
        const targetStatus = status || 'Draft';

        if (!reportee) {
            return res.status(400).json({ message: "Primary reportee not assigned. Please assign a manager first." });
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

        if (targetStatus === 'Pending') {
            // SNAPSHOT: Find Reportee's USER Object for "submittedTo"
            // This ensures consistent dashboard behavior across modules (Reward, Fine, Loan)
            let reporteeUser = null;

            if (reportee.employeeId) {
                // Try finding by employeeId first
                reporteeUser = await User.findOne({ employeeId: reportee.employeeId });
            }

            if (!reporteeUser) {
                // Fallback: search by email
                const mEmail = reportee.companyEmail || reportee.workEmail || reportee.email;
                if (mEmail) {
                    reporteeUser = await User.findOne({
                        $or: [{ email: mEmail }, { username: mEmail }, { companyEmail: mEmail }]
                    });
                }
            }

            // Assign ID (Prefer User ID, fallback to Employee ID if no user account exists)
            const assignmentId = reporteeUser ? reporteeUser._id : reportee._id;

            loanData.submittedTo = assignmentId;
            loanData.workflow = [{
                role: 'Manager',
                assignedTo: assignmentId,
                status: 'Pending',
                assignedAt: new Date()
            }];

            console.log(`[RequestLoan] Loan Pushed for Manager: ${reportee.employeeId} (Account: ${reporteeUser ? 'Found' : 'Missing - Falling back to Employee ID'})`);
        }

        const newLoan = new Loan(loanData);
        const savedLoan = await newLoan.save();

        // 3. Sync with Dashboard Action Table
        if (targetStatus === 'Pending') {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            await syncDashboardAction({
                requestId: savedLoan._id,
                requestType: 'Loan',
                assignedTo: reportee._id, // Use Employee ID for assignment
                status: 'Pending',
                subjectEmployee: employeeBasic,
                extra1: `AED ${amount}`,
                extra2: `${duration} Months`
            });
        }

        // 4. Send Email ONLY if Submit for Approval
        if (targetStatus === 'Pending' && reportee) {
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
                    const subject = `${type} Application: ${employeeName}`;

                    // Dynamic URL
                    const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
                    const baseUrl = process.env.FRONTEND_URL || origin || "http://localhost:3000";
                    const typeSlug = type ? type.replace(/\s+/g, '-') : 'Loan';
                    const actionUrl = `${baseUrl}/HRM/LoanAndAdvance/${typeSlug}-${savedLoan._id}`; // type-id slug

                    const html = `
                        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                            <div style="background-color: #0d9488; color: white; padding: 20px; text-align: center;">
                                <h2 style="margin: 0;">${type} Application Review</h2>
                            </div>
                            <div style="padding: 30px;">
                                <p>Hello <strong>${reporteeName}</strong>,</p>
                                <p><strong>${employeeName}</strong> has submitted a request for ${type}.</p>
                                
                                <div style="background-color: #f0fdfa; padding: 20px; border-radius: 8px; border: 1px solid #ccfbf1; margin: 25px 0;">
                                    <p style="margin: 0;"><strong>Employee:</strong> ${employeeName} (${employeeId})</p>
                                    <p style="margin: 8px 0 0 0;"><strong>Type:</strong> ${type}</p>
                                    <p style="margin: 8px 0 0 0;"><strong>Amount:</strong> ${Number(amount).toLocaleString()}</p>
                                    <p style="margin: 8px 0 0 0;"><strong>Duration:</strong> ${duration} Months</p>
                                    <p style="margin: 8px 0 0 0;"><strong>Start Month:</strong> ${monthStart || 'Immediate'}</p>
                                    <p style="margin: 8px 0 0 0;"><strong>Reason:</strong> ${reason}</p>
                                </div>
                                
                                <p style="text-align: center; margin: 35px 0;">
                                    <a href="${actionUrl}" style="background-color: #0d9488; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 16px;">View Request</a>
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
