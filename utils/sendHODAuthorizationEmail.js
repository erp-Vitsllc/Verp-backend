import nodemailer from 'nodemailer';

/**
 * Sends an email to the HOD requesting authorization for an action (Fine, Reward, Loan).
 * 
 * @param {string} type - 'Fine', 'Reward', or 'Loan'
 * @param {Object} item - The item object (Fine, Reward, Loan)
 * @param {Object} hod - The HOD employee object
 * @param {Object} requester - The person who initially approved/requested (Reportee)
 */
export const sendHODAuthorizationEmail = async (type, item, hod, requester) => {
    try {
        const hEmail = hod.companyEmail || hod.email;
        if (!hEmail) {
            console.warn('[HODEmail] HOD has no email (companyEmail or email), skipping.');
            return;
        }

        // Initialize transporter inside to ensure environment variables are loaded
        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;

        if (!emailUser || !emailPass) {
            console.error('[HODEmail] Email credentials missing (EMAIL_USER/PASS).');
            return;
        }

        // Determine SMTP host based on email domain or preference
        let smtpHost = process.env.SMTP_HOST || "smtp.office365.com"; // Default to Outlook
        if (emailUser.includes('@gmail.com') || process.env.GMAIL_USER) {
            smtpHost = "smtp.gmail.com";
        }

        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        let link = '';
        let detailsHtml = '';
        let subjectId = '';

        if (type === 'Fine') {
            link = `${frontendUrl}/HRM/Fine/${item._id}`;
            subjectId = item.fineId;
            detailsHtml = `
                <p><strong>Fine ID:</strong> ${item.fineId}</p>
                <p><strong>Type:</strong> ${item.fineType}</p>
                <p><strong>Amount:</strong> AED ${item.fineAmount || 0}</p>
            `;
        } else if (type === 'Reward') {
            link = `${frontendUrl}/HRM/Reward/${item._id}`;
            subjectId = item.rewardId || `REWARD-${item._id.toString().slice(-6)}`;
            detailsHtml = `
                <p><strong>Reward Type:</strong> ${item.rewardType}</p>
                <p><strong>Amount:</strong> AED ${item.amount || 0}</p>
            `;
        } else if (type === 'Loan' || type === 'Advance') {
            const typeSlug = item.type ? item.type.replace(/\s+/g, '-') : type;
            link = `${frontendUrl}/HRM/LoanAndAdvance/${typeSlug}-${item._id}`;
            subjectId = `LOAN-${item._id.toString().slice(-6)}`;
            detailsHtml = `
                <p><strong>Request Type:</strong> ${type}</p>
                <p><strong>Amount:</strong> AED ${item.amount}</p>
                <p><strong>Reason:</strong> ${item.reason}</p>
            `;
        }

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #f8f9fa; padding: 20px; border-bottom: 1px solid #eaeaea;">
                    <h2 style="color: #0d6efd; margin: 0;">Authorization Required</h2>
                    <p style="margin: 5px 0 0; color: #666;">For ${type} Request: <strong>${subjectId}</strong></p>
                </div>
                
                <div style="padding: 20px;">
                    <p>Dear ${hod.firstName},</p>
                    <p>The following request has been reviewed and approved by <strong>${requester.name}</strong> (${requester.designation}) and is now forwarded to you for final authorization.</p>
                    
                    <div style="background-color: #e3f2fd; padding: 15px; border-radius: 6px; margin: 20px 0;">
                        ${detailsHtml}
                    </div>

                    <p>Please click the button below to view details and authorize.</p>

                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${link}" style="background-color: #0d6efd; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Review & Authorize</a>
                    </div>
                </div>
                
                <div style="background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eaeaea;">
                    This is an automated system notification.
                </div>
            </div>
        `;

        await transporter.sendMail({
            fromName: requester.name,
            to: hEmail,
            subject: `Action Required: Authorize ${type} - ${subjectId}`,
            html: htmlContent
        });

        console.log(`[HODEmail] Email sent to ${hEmail} for ${type} ${subjectId}`);

    } catch (error) {
        console.error('[HODEmail] Error sending email:', error);
    }
};
