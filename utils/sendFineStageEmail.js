import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl, emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import EmployeeBasic from '../models/EmployeeBasic.js';

export const sendFineStageEmail = async (fine, recipients, stageName, allAssignedEmployees = []) => {
    if (!recipients || recipients.length === 0) {
        console.warn(`[Email] No recipients for ${stageName} stage notification.`);
        return;
    }

    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;

    if (!emailUser || !emailPass) {
        console.error('[Email] SMTP credentials missing.');
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

    // Ensure recipients is an array or string
    const to = Array.isArray(recipients) ? recipients.join(',') : recipients;

    const frontendUrl = resolveFrontendBaseUrl();
    const actionLink = `${frontendUrl}/HRM/Fine/${fine._id}`;
    
    // Support group lists for the email body if provided, otherwise use fine.assignedEmployees
    const employeeList = (allAssignedEmployees && allAssignedEmployees.length > 0) 
        ? allAssignedEmployees 
        : (fine.assignedEmployees || []);

    const firstEmpName = employeeList[0]?.employeeName || 'Employee';
    const subject = `Action Required: ${stageName} Approval for Fine - ${employeeList.length > 1 ? 'Multiple Employees' : firstEmpName} (${fine.fineId})`;

    // Generate rows for the table
    const rows = employeeList.map(emp => {
        if (emp.employeeId === 'VEGA-HR-0000') return ''; // Skip company contribution from the list
        return `
            <tr>
                <td style="padding: 8px; border-bottom: 1px solid #eee;">${emp.employeeId || 'N/A'}</td>
                <td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>${emp.employeeName}</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #eee;">AED ${emp.individualAmount || emp.fineAmount || 'N/A'}</td>
            </tr>
        `;
    }).join('');

    const html = `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #2c3e50; border-bottom: 2px solid #eee; padding-bottom: 10px;">Fine Request - ${stageName} Approval</h2>
            <p>The following fine request has been approved by the previous stage and is now pending your review.</p>
            
            <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p><strong>Fine ID:</strong> ${fine.fineId}</p>
                <p><strong>Fine Type:</strong> ${fine.fineType || fine.category || 'N/A'}</p>
                <p><strong>Total Amount:</strong> AED ${fine.fineAmount}</p>
                <p><strong>Current Status:</strong> <span style="color: #e67e22; font-weight: bold;">Pending ${stageName}</span></p>
            </div>

            <h4 style="margin-bottom: 10px;">Employee Details:</h4>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <thead>
                    <tr style="background-color: #f5f5f5; text-align: left;">
                        <th style="padding: 8px;">ID</th>
                        <th style="padding: 8px;">Name</th>
                        <th style="padding: 8px;">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>

            <div style="text-align: center; margin-top: 30px;">
                <a href="${actionLink}" style="display: inline-block; padding: 12px 24px; background-color: #000; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Review & Approve Fine</a>
            </div>
            
            <p style="margin-top: 20px; font-size: 11px; color: #999; text-align: center;">This is an automated system notification from VeRP.</p>
        </div>
    `;

    try {
        await transporter.sendMail({
            fromName: "VeRP Fine System",
            to,
            subject,
            html
        });
        console.log(`[Email] Sent ${stageName} notification to ${to}`);
    } catch (error) {
        console.error(`[Email] Failed to send ${stageName} notification:`, error);
    }
};
