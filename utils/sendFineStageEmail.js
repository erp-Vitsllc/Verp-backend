import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false, // true for 465, false for other ports
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

export const sendFineStageEmail = async (fine, recipients, stageName) => {
    if (!recipients || recipients.length === 0) {
        console.warn(`[Email] No recipients for ${stageName} stage notification.`);
        return;
    }

    // Ensure recipients is an array or string
    const to = Array.isArray(recipients) ? recipients.join(',') : recipients;

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const actionLink = `${frontendUrl}/HRM/Fine/${fine._id}`;
    const subject = `Action Required: ${stageName} Approval for Fine - ${fine.assignedEmployees[0]?.employeeName || 'Employee'}`;

    const html = `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
            <h2 style="color: #2c3e50;">Fine Request - ${stageName} Approval</h2>
            <p>The following fine request has been approved by the previous stage and is now pending your review.</p>
            
            <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p><strong>Employee:</strong> ${fine.assignedEmployees[0]?.employeeName || 'N/A'}</p>
                <p><strong>Fine Type:</strong> ${fine.fineType || fine.category || 'N/A'}</p>
                <p><strong>Amount:</strong> AED ${fine.fineAmount}</p>
                <p><strong>Current Status:</strong> Pending ${stageName}</p>
            </div>

            <div style="text-align: center; margin-top: 30px;">
                <a href="${actionLink}" style="display: inline-block; padding: 12px 24px; background-color: #000; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Review & Approve Fine</a>
            </div>
            
            <p style="margin-top: 20px; font-size: 12px; color: #666;">If the button above doesn't work, copy and paste this link:</p>
            <p style="font-size: 12px; color: #666;"><a href="${actionLink}">${actionLink}</a></p>
        </div>
    `;

    try {
        await transporter.sendMail({
            from: `"VeRP Notification" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            html
        });
        console.log(`[Email] Sent ${stageName} notification to ${to}`);
    } catch (error) {
        console.error(`[Email] Failed to send ${stageName} notification:`, error);
    }
};
