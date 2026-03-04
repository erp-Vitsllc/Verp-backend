import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';

/**
 * Sends fine approval notification emails to HR.
 * 
 * @param {Object} fine - The created fine object (mongoose document)
 * @param {Array} assignedEmployees - List of employees involved in the fine
 */
import { getDepartmentHOD } from './getDepartmentHOD.js';
export const sendFineApprovalEmail = async (fine, assignedEmployees) => {
    try {
        console.log(`[FineEmail] Starting notification process for Fine ${fine.fineId}`);

        const emailUser = process.env.EMAIL_USER;
        const emailPass = process.env.EMAIL_PASS;

        if (!emailUser || !emailPass) {
            console.error('[FineEmail] SMTP credentials missing.');
            return;
        }

        const smtpHost = emailUser.includes('@gmail.com') ? 'smtp.gmail.com' : 'smtp.office365.com';

        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: 587,
            secure: false,
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });

        // 1. Fetch full details for all assigned employees
        const employeeIds = assignedEmployees.map(e => e.employeeId);
        const fullEmployees = await EmployeeBasic.find({ employeeId: { $in: employeeIds } })
            .select('employeeId firstName lastName department designation')
            .lean();

        // 2. Map full details back to the assigned list
        const employeementDetails = [];

        for (const assigned of assignedEmployees) {
            const fullEmp = fullEmployees.find(e => e.employeeId === assigned.employeeId);

            if (!fullEmp) {
                console.warn(`[FineEmail] Employee ${assigned.employeeId} not found in DB, skipping.`);
                continue;
            }

            employeementDetails.push({
                employeeId: fullEmp.employeeId,
                name: `${fullEmp.firstName} ${fullEmp.lastName}`,
                department: fullEmp.department || 'N/A',
                designation: fullEmp.designation || 'N/A',
                amount: assigned.amount || 'Calculated Share'
            });
        }

        if (employeementDetails.length === 0) {
            console.warn('[FineEmail] No employee details found to send email.');
            return;
        }

        // Get HR Email
        const targetEmpId = assignedEmployees[0]?.employeeId;
        const hrHOD = await getDepartmentHOD('hr', targetEmpId);
        let hrEmail = hrHOD ? hrHOD.companyEmail : null;
        if (!hrEmail) hrEmail = process.env.HR_EMAIL || 'hr@verp.com';


        // 3. Send Emails
        // Use environment variable for frontend URL, fallback to localhost
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const fineLink = `${frontendUrl}/HRM/Fine/${fine._id}`;

        // Generate HTML Table for Employees
        const rows = employeementDetails.map(emp => `
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #eee;">${emp.employeeId}</td>
                <td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>${emp.name}</strong></td>
                <td style="padding: 10px; border-bottom: 1px solid #eee;">${emp.department}</td>
                <td style="padding: 10px; border-bottom: 1px solid #eee;">${emp.designation}</td>
            </tr>
        `).join('');

            const htmlContent = `
                <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                    <div style="background-color: #f8f9fa; padding: 20px; border-bottom: 1px solid #eaeaea;">
                        <h2 style="color: #d32f2f; margin: 0;">Fine Approval Required</h2>
                        <p style="margin: 5px 0 0; color: #666;">Fine ID: <strong>${fine.fineId}</strong></p>
                    </div>
                    
                    <div style="padding: 20px;">
                        <p>Dear HR,</p>
                        <p>The following employee(s) have been issued a fine pending your review and approval.</p>
                        
                        <div style="background-color: #fff3e0; padding: 15px; border-radius: 6px; margin: 20px 0;">
                            <p style="margin: 0;"><strong>Fine Type:</strong> ${fine.fineType}</p>
                            <p style="margin: 5px 0 0;"><strong>Category:</strong> ${fine.category}</p>
                            <p style="margin: 5px 0 0;"><strong>Date:</strong> ${new Date(fine.awardedDate).toLocaleDateString()}</p>
                        </div>

                        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                            <thead>
                                <tr style="background-color: #f5f5f5; text-align: left;">
                                    <th style="padding: 10px;">ID</th>
                                    <th style="padding: 10px;">Name</th>
                                    <th style="padding: 10px;">Dept</th>
                                    <th style="padding: 10px;">Designation</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rows}
                            </tbody>
                        </table>

                        <p>Please review the details and take necessary action.</p>

                        <div style="text-align: center; margin-top: 30px;">
                            <a href="${fineLink}" style="background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Review & Approve Fine</a>
                        </div>
                    </div>
                    
                    <div style="background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eaeaea;">
                        This is an automated system notification.
                    </div>
                </div>
            `;

            await transporter.sendMail({
                from: `"VeRP Notification" <${emailUser}>`,
                to: hrEmail,
                subject: `Action Required: Fine Approval for ${employeementDetails.length > 1 ? 'Multiple Employees' : employeementDetails[0].name} - ${fine.fineId}`,
                html: htmlContent
            });

            console.log(`[FineEmail] Email sent to ${hrEmail} for ${employeementDetails.length} employees.`);
        
    } catch (error) {
        console.error('[FineEmail] Error sending fine emails:', error);
    }
};
