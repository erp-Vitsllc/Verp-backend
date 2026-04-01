import nodemailer from "nodemailer";
import { resolveEmployeeEmail } from "./resolveEmployeeEmail.js";

export const sendParkingReassignAcceptedEmail = async ({
    asset,
    oldAssignee,
    newAssignee,
    assetController
}) => {
    try {
        const resolved = resolveEmployeeEmail(oldAssignee || {});
        const recipientEmail = resolved.email;
        if (!recipientEmail) return;

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) return;

        const transporter = nodemailer.createTransport({
            host: "smtp.office365.com",
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass }
        });

        const oldName = `${oldAssignee?.firstName || ''} ${oldAssignee?.lastName || ''}`.trim() || 'Employee';
        const newName = `${newAssignee?.firstName || ''} ${newAssignee?.lastName || ''}`.trim() || 'Employee';
        const controllerName = `${assetController?.firstName || ''} ${assetController?.lastName || ''}`.trim() || 'Asset Controller';
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, "");
        const assetId = asset?._id?.toString?.() || asset?.id?.toString?.();
        const link = `${frontendUrl}/HRM/Asset/details/${assetId}`;

        await transporter.sendMail({
            from: `"VeRP Asset Management" <${emailUser}>`,
            to: recipientEmail,
            subject: `Asset Parking Reassigned: ${asset?.assetId || ''}`,
            html: `
                <div style="font-family:Segoe UI,Arial,sans-serif;max-width:620px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                    <div style="background:#0ea5e9;color:#fff;padding:20px 24px"><h2 style="margin:0">Asset Reassignment Confirmed</h2></div>
                    <div style="padding:24px;color:#334155">
                        <p>Hello <strong>${oldName}</strong>,</p>
                        <p>Your parked asset has been reassigned by <strong>${controllerName}</strong>.</p>
                        <p><strong>New assignee:</strong> ${newName} (accepted)</p>
                        <p><strong>Asset:</strong> ${asset?.assetId || '-'} - ${asset?.name || '-'}</p>
                        <p style="margin-top:18px"><a href="${link}" style="background:#0ea5e9;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none">View Asset</a></p>
                    </div>
                </div>
            `
        });
    } catch (error) {
        console.error("[sendParkingReassignAcceptedEmail] Non-fatal:", error?.message || error);
    }
};
