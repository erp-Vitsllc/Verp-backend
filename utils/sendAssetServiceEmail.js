import nodemailer from "nodemailer";
import { resolveEmployeeEmail } from "./resolveEmployeeEmail.js";

/**
 * Sends email notifications for asset service events.
 * @param {Object} asset - The asset item document.
 * @param {Object} recipient - The employee receiving the email.
 * @param {String} type - 'Started', 'Done', 'Warning', 'Reminder', 'DurationComplete', or 'Extended'.
 * @param {Object} details - Additional service details (duration, description, etc.).
 * @param {Object} sender - The employee who initiated the action.
 */
export const sendAssetServiceEmail = async ({ asset, recipient, type, details, sender }) => {
    try {
        const { email: recipientEmail } = resolveEmployeeEmail(recipient);
        if (!recipientEmail) {
            console.warn(`[Email Warning] No email found for recipient ${recipient?.firstName || ''} ${recipient?.lastName || ''}`);
            return;
        }

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();

        if (!emailUser || !emailPass) {
            console.error("[Email Error] Email credentials are not configured.");
            return;
        }

        const transporter = nodemailer.createTransport({
            host: "smtp.office365.com",
            port: 587,
            secure: false,
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });

        let subject = "";
        let headerColor = "#3b82f6"; // Default blue
        let headerTitle = "";
        let message = "";

        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, "");
        const buttonUrl = `${frontendUrl}/HRM/Asset/details/${asset._id}`;

        if (type === 'Started') {
            subject = `Asset Sent to Service: ${asset.assetId} - ${asset.name}`;
            headerTitle = "Service Started";
            headerColor = "#3b82f6"; // Blue
            message = `The asset has been sent for service by <strong>${sender.firstName} ${sender.lastName}</strong>.`;
        } else if (type === 'Done') {
            subject = `Service Completed: ${asset.assetId} - ${asset.name}`;
            headerTitle = "Service Done";
            headerColor = "#10b981"; // Emerald
            message = `The service for <strong>${asset.name}</strong> has been completed and it is now set to Live by <strong>${sender.firstName} ${sender.lastName}</strong>.`;
        } else if (type === 'Warning') {
            subject = `Service Overdue Warning: ${asset.assetId} - ${asset.name}`;
            headerTitle = "Service Overdue";
            headerColor = "#ef4444"; // Red
            message = `The expected service duration for this asset has passed, but the service status has not been updated yet.`;
        } else if (type === 'Reminder') {
            subject = `Service Duration Reminder: ${asset.assetId} - ${asset.name}`;
            headerTitle = "Service Reminder";
            headerColor = "#f59e0b"; // Amber
            message = `The service duration for this asset is close to expiry.`;
        } else if (type === 'DurationComplete') {
            subject = `Service Duration Completed: ${asset.assetId} - ${asset.name}`;
            headerTitle = "Duration Completed";
            headerColor = "#ef4444"; // Red
            message = `The service duration for this asset is completed. Please update the asset status when service is done.`;
        } else if (type === 'Extended') {
            subject = `Service Duration Extended: ${asset.assetId} - ${asset.name}`;
            headerTitle = "Service Extended";
            headerColor = "#6366f1"; // Indigo
            message = `Service duration was extended by <strong>${details?.extensionDays || 'N/A'} day(s)</strong>.`;
        }

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: ${headerColor}; color: white; padding: 25px; text-align: center;">
                    <h1 style="margin: 0; font-size: 22px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px;">${headerTitle}</h1>
                </div>
                <div style="padding: 40px;">
                    <p style="font-size: 16px;">Hello <strong>${recipient.firstName}</strong>,</p>
                    
                    <p style="color: #475569; font-size: 15px;">${message}</p>
                    
                    <div style="background-color: #f8fafc; padding: 25px; border-radius: 12px; margin: 25px 0; border: 1px solid #e2e8f0;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: 800; width: 40%;">Asset ID</td>
                                <td style="padding: 8px 0; font-weight: 700; color: #0f172a;">${asset.assetId}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: 800;">Asset Name</td>
                                <td style="padding: 8px 0; font-weight: 700; color: #0f172a;">${asset.name}</td>
                            </tr>
                            ${details?.serviceDuration ? `
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: 800;">Expected Duration</td>
                                <td style="padding: 8px 0; font-weight: 700; color: #0f172a;">${details.serviceDuration}</td>
                            </tr>
                            ` : ''}
                            ${details?.description ? `
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: 800;">Description</td>
                                <td style="padding: 8px 0; font-weight: 700; color: #0f172a;">${details.description}</td>
                            </tr>
                            ` : ''}
                            ${details?.currentExpiryDate ? `
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: 800;">Current Expiry Date</td>
                                <td style="padding: 8px 0; font-weight: 700; color: #0f172a;">${new Date(details.currentExpiryDate).toLocaleDateString()}</td>
                            </tr>
                            ` : ''}
                            ${details?.extensionReason ? `
                            <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: 800;">Extension Reason</td>
                                <td style="padding: 8px 0; font-weight: 700; color: #0f172a;">${details.extensionReason}</td>
                            </tr>
                            ` : ''}
                        </table>
                    </div>

                    <div style="text-align: center; margin-top: 35px; margin-bottom: 20px;">
                        <a href="${buttonUrl}" 
                           style="background-color: ${headerColor}; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 10px; font-weight: 800; display: inline-block; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; box-shadow: 0 4px 12px ${headerColor}40;">
                           View Asset Details
                        </a>
                    </div>
                </div>
                <div style="background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated notification from the VeRP Asset Management System.</p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            fromName: sender ? `${sender.firstName} ${sender.lastName}` : "Asset Management",
            to: recipientEmail,
            subject,
            html
        });

        console.log(`[Email Success] Asset service ${type} email sent to ${recipientEmail}`);
        return true;
    } catch (error) {
        console.error(`[Email Error] Failed to send asset service ${type} email:`, error);
        return false;
    }
};
