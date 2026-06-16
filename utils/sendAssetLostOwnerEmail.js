import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import {
    resolveEmployeeEmailWithReporteeLoaded,
    getFallbackEmailNote,
    employeeDisplayName,
} from './resolveEmployeeEmail.js';

/**
 * Notifies the Asset Owner (the assigned employee) when Loss & Damage is approved
 * by the Asset Controller, detailing that the asset/accessory is lost and the loss value.
 */
export const sendAssetLostOwnerEmail = async ({
    asset,
    employee,
    lossValue,
    accessoryName = '',
    fineId = '',
}) => {
    try {
        if (!asset || !employee) return;

        const { email, isFallbackToReportee, employee: resolvedEmployee } =
            await resolveEmployeeEmailWithReporteeLoaded(employee);
        if (!email) {
            console.warn('[sendAssetLostOwnerEmail] Owner has no email, skipping.');
            return;
        }

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
        if (!emailUser || !emailPass) return;

        let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
        if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';

        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(process.env.SMTP_PORT, 10) || 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass }
        });

        const frontendUrl = resolveFrontendBaseUrl();
        const link = `${frontendUrl}/HRM/Asset/details/${asset._id || asset.id}`;

        const subjectEmployee = resolvedEmployee || employee;
        const helloName = isFallbackToReportee
            ? employeeDisplayName(subjectEmployee.primaryReportee)
            : employeeDisplayName(subjectEmployee);
        const fallbackNote =
            isFallbackToReportee && subjectEmployee.primaryReportee
                ? getFallbackEmailNote(
                      employeeDisplayName(subjectEmployee),
                      employeeDisplayName(subjectEmployee.primaryReportee)
                  )
                : '';

        const assetDisplay = `${asset.assetId || ''} — ${asset.name || ''}`;
        const subject = accessoryName
            ? `Accessory Lost: ${accessoryName} (Asset: ${asset.assetId || ''})`
            : `Asset Lost: ${asset.assetId || ''}`;

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #dc2626; padding: 20px; border-bottom: 1px solid #eaeaea; color: #fff;">
                    <h2 style="margin: 0; color: #fff;">${accessoryName ? 'Accessory Marked as Lost' : 'Asset Marked as Lost'}</h2>
                    <p style="margin: 5px 0 0; color: #fecaca;">Asset: <strong>${assetDisplay}</strong></p>
                    ${accessoryName ? `<p style="margin: 5px 0 0; color: #fecaca;">Accessory: <strong>${accessoryName}</strong></p>` : ''}
                </div>
                <div style="padding: 20px;">
                    ${fallbackNote}
                    <p>Dear ${helloName},</p>
                    <p>The Loss and Damage request for ${accessoryName ? `accessory "<strong>${accessoryName}</strong>" on your assigned asset` : `your assigned asset "<strong>${assetDisplay}</strong>"`} has been approved by the Asset Controller.</p>
                    <p>Consequently, the status has been updated to <strong>Lost</strong>.</p>
                    <div style="background-color: #fef2f2; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0; border-radius: 4px;">
                        <h4 style="margin: 0 0 5px 0; color: #991b1b;">Loss Value Details</h4>
                        <p style="margin: 0; font-size: 16px; font-weight: bold; color: #dc2626;">AED ${Number(lossValue || 0).toFixed(2)}</p>
                        ${fineId ? `<p style="margin: 5px 0 0 0; font-size: 12px; color: #7f1d1d;">Fine ID Reference: <strong>${fineId}</strong></p>` : ''}
                    </div>
                    <p>A fine has been initiated and submitted for review/approval.</p>
                    <div style="text-align: center; margin-top: 24px;">
                        <a href="${link}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">View Asset Details</a>
                    </div>
                </div>
            </div>`;

        await transporter.sendMail({
            from: emailUser,
            fromName: "Asset Management",
            to: email,
            subject,
            html: htmlContent,
        });

        console.log(`[sendAssetLostOwnerEmail] Sent to ${email} (value: AED ${lossValue})`);
    } catch (error) {
        console.error('[sendAssetLostOwnerEmail] Error:', error?.message || error);
    }
};
