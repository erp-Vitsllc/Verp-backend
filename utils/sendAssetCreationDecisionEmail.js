import nodemailer from 'nodemailer';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';

const getTransporter = () => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;

    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: {
            user: emailUser,
            pass: emailPass
        }
    });

    return { transporter, emailUser };
};

export const sendAssetCreationDecisionEmail = async ({ asset, recipient, approverRole = 'assetcontroller', creatorName = 'User' }) => {
    try {
        const { email: recipientEmail } = resolveEmployeeEmail(recipient);
        if (!recipientEmail) return false;

        const setup = getTransporter();
        if (!setup) return false;

        const { transporter, emailUser } = setup;
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, '');
        const assetId = asset?._id?.toString() || asset?.id?.toString();
        const plate = String(asset?.plateNumber || '').trim();
        const isFleetVehicle = !!plate;
        const buttonUrl = isFleetVehicle
            ? `${frontendUrl}/HRM/Asset/Vehicle/details/${assetId}`
            : `${frontendUrl}/HRM/Asset/details/${assetId}`;
        const approvedByText =
            approverRole === 'admin' ? 'Administrator' : approverRole === 'hr' ? 'HR' : 'Asset Controller';
        const subject = `Asset Creation Approved: ${asset?.assetId || asset?.name || 'Asset'}`;

        const html = `
            <div style="font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff;">
                <div style="background:#10b981;color:#fff;padding:24px;text-align:center;">
                    <h1 style="margin:0;font-size:22px;">Asset Creation Approved</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello ${recipient?.firstName || 'User'},</p>
                    <p>The asset creation request submitted by <strong>${creatorName}</strong> has been approved by <strong>${approvedByText}</strong>.</p>
                    <p><strong>Asset:</strong> ${asset?.assetId || '-'} - ${asset?.name || '-'}</p>
                    <p><strong>Current Status:</strong> ${asset?.status || 'Unassigned'}</p>
                    <div style="text-align:center;margin-top:20px;">
                        <a href="${buttonUrl}" style="background:#10b981;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;">View Asset</a>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Assets" <${emailUser}>`,
            to: recipientEmail,
            subject,
            html
        });

        return true;
    } catch (error) {
        console.error('[Email Error] Failed to send asset creation decision email:', error);
        return false;
    }
};

export const sendAssetCreationRejectedEmail = async ({
    asset,
    recipient,
    approverRole = 'assetcontroller',
    rejectReason = ''
}) => {
    try {
        const { email: recipientEmail } = resolveEmployeeEmail(recipient);
        if (!recipientEmail) return false;

        const setup = getTransporter();
        if (!setup) return false;

        const { transporter } = setup;
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, '');
        const assetId = asset?._id?.toString() || asset?.id?.toString();
        const plate = String(asset?.plateNumber || '').trim();
        const isFleetVehicle = !!plate;
        const buttonUrl = isFleetVehicle
            ? `${frontendUrl}/HRM/Asset/Vehicle/details/${assetId}`
            : `${frontendUrl}/HRM/Asset/details/${assetId}`;
        const rejectedByText =
            approverRole === 'admin' ? 'Administrator' : approverRole === 'hr' ? 'HR' : 'Asset Controller';
        const subject = `Asset Creation Not Approved: ${asset?.assetId || asset?.name || 'Asset'}`;
        const reasonBlock = rejectReason
            ? `<p><strong>Comments:</strong> ${String(rejectReason).replace(/</g, '&lt;')}</p>`
            : '';

        const html = `
            <div style="font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff;">
                <div style="background:#e11d48;color:#fff;padding:24px;text-align:center;">
                    <h1 style="margin:0;font-size:22px;">Asset Creation Not Approved</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello ${recipient?.firstName || 'User'},</p>
                    <p>Your asset creation request was reviewed by <strong>${rejectedByText}</strong> and was not approved. The asset has been returned to <strong>Draft</strong> so you can update it and resubmit for approval.</p>
                    <p><strong>Asset:</strong> ${asset?.assetId || '-'} - ${asset?.name || '-'}</p>
                    ${reasonBlock}
                    <div style="text-align:center;margin-top:20px;">
                        <a href="${buttonUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;">Edit &amp; Resubmit</a>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Assets" <${emailUser}>`,
            to: recipientEmail,
            subject,
            html
        });

        return true;
    } catch (error) {
        console.error('[Email Error] Failed to send asset creation rejected email:', error);
        return false;
    }
};

export const sendAssetCreatedByAdminInfoEmail = async ({ asset, recipient, creatorName = 'Administrator' }) => {
    try {
        const { email: recipientEmail } = resolveEmployeeEmail(recipient);
        if (!recipientEmail) return false;

        const setup = getTransporter();
        if (!setup) return false;

        const { transporter, emailUser } = setup;
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, '');
        const assetId = asset?._id?.toString() || asset?.id?.toString();
        const buttonUrl = `${frontendUrl}/HRM/Asset/details/${assetId}`;
        const subject = `Asset Created by Admin: ${asset?.assetId || asset?.name || 'Asset'}`;

        const html = `
            <div style="font-family:Segoe UI,Tahoma,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff;">
                <div style="background:#3b82f6;color:#fff;padding:24px;text-align:center;">
                    <h1 style="margin:0;font-size:22px;">Admin Created Asset</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello ${recipient?.firstName || 'Asset Controller'},</p>
                    <p><strong>${creatorName}</strong> created a new asset directly in <strong>Unassigned</strong> status.</p>
                    <p><strong>Asset:</strong> ${asset?.assetId || '-'} - ${asset?.name || '-'}</p>
                    <div style="text-align:center;margin-top:20px;">
                        <a href="${buttonUrl}" style="background:#3b82f6;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;">View Asset</a>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            fromName: creatorName,
            to: recipientEmail,
            subject,
            html
        });

        return true;
    } catch (error) {
        console.error('[Email Error] Failed to send admin-created asset notification:', error);
        return false;
    }
};
