import nodemailer from 'nodemailer';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';

const getTransporter = () => {
    const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
    const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
    if (!emailUser || !emailPass) return null;

    let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
    if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';

    return nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass }
    });
};

const formatDate = (d) => {
    try {
        const x = new Date(d);
        return x.toLocaleDateString();
    } catch {
        return '';
    }
};

const getAssetLink = (asset) => {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const assetId = asset?._id?.toString?.() || asset?.id?.toString?.() || '';
    return `${frontendUrl}/HRM/Asset/details/${assetId}`;
};

export const sendTemporaryAssignmentReminderEmail = async ({
    asset,
    assigneeEmployee,
    assigneeCompany, // company doc or null
    assetController,
    hrHOD,
    endDate,
    daysLeft
}) => {
    try {
        const transporter = getTransporter();
        if (!transporter) return;

        const to = [];
        if (asset.assignedToType === 'Employee') {
            const resolved = resolveEmployeeEmail(assigneeEmployee || {});
            if (resolved.email) to.push(resolved.email);
        } else if (asset.assignedToType === 'Company') {
            const hrResolved = resolveEmployeeEmail(hrHOD || {});
            if (hrResolved.email && !to.includes(hrResolved.email)) to.push(hrResolved.email);
        }

        if (assetController?.employeeId) {
            const acResolved = resolveEmployeeEmail(assetController || {});
            if (acResolved.email) {
                if (!to.includes(acResolved.email)) to.push(acResolved.email);
            }
        }

        if (!to.length) return;

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const assetId = asset.assetId || '';
        const link = getAssetLink(asset);
        const assigneeText = asset.assignedToType === 'Company'
            ? (assigneeCompany?.name || 'Company allocation')
            : `${assigneeEmployee?.firstName || ''} ${assigneeEmployee?.lastName || ''}`.trim() || 'Employee';

        const controllerName = assetController
            ? `${assetController.firstName || ''} ${assetController.lastName || ''}`.trim() || 'Asset Controller'
            : 'Asset Controller';

        await transporter.sendMail({
            from: `"VeRP Asset Management" <${emailUser}>`,
            to: to.join(','),
            subject: `Reminder: Temporary assignment ends on ${formatDate(endDate)} (${assetId})`,
            html: `
                <div style="font-family:Segoe UI,Arial,sans-serif;max-width:620px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                    <div style="background:#0ea5e9;color:#fff;padding:20px 24px">
                        <h2 style="margin:0;font-size:20px">Temporary Assignment Reminder</h2>
                        <p style="margin:6px 0 0;opacity:.95;font-size:12px">Ends in ${daysLeft} day(s)</p>
                    </div>
                    <div style="padding:24px;color:#334155">
                        <p>Hello <strong>${asset.assignedToType === 'Company' ? (hrHOD?.firstName || 'HR') : (assigneeEmployee?.firstName || 'Employee')}</strong>,</p>
                        <p>Your <strong>${asset.assignedToType === 'Company' ? 'company allocation' : 'asset assignment'}</strong> for the following asset ends on <strong>${formatDate(endDate)}</strong>:</p>
                        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:18px 0">
                            <p style="margin:0"><strong>Asset:</strong> ${assetId} - ${asset.name || ''}</p>
                            <p style="margin:6px 0 0"><strong>Assignee:</strong> ${assigneeText}</p>
                            <p style="margin:6px 0 0"><strong>Approved by:</strong> ${controllerName}</p>
                        </div>
                        <p style="margin:0;color:#475569;font-size:13px">Please take action before expiry (extension/reassignment/return as per your workflow).</p>
                        <div style="margin-top:22px;text-align:center">
                            <a href="${link}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:700">View Asset</a>
                        </div>
                    </div>
                    <div style="background:#f8fafc;padding:14px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0">
                        Automated system notification from VeRP Asset Management
                    </div>
                </div>
            `
        });
    } catch (error) {
        console.error('[sendTemporaryAssignmentReminderEmail] Non-fatal:', error?.message || error);
    }
};

export const sendTemporaryAssignmentExpiredEmail = async ({
    asset,
    assigneeEmployee,
    assigneeCompany,
    assetController,
    hrHOD,
    endDate
}) => {
    try {
        const transporter = getTransporter();
        if (!transporter) return;

        const to = [];
        if (asset.assignedToType === 'Employee') {
            const resolved = resolveEmployeeEmail(assigneeEmployee || {});
            if (resolved.email) to.push(resolved.email);
        } else if (asset.assignedToType === 'Company') {
            const hrResolved = resolveEmployeeEmail(hrHOD || {});
            if (hrResolved.email && !to.includes(hrResolved.email)) to.push(hrResolved.email);
        }

        if (assetController?.employeeId) {
            const acResolved = resolveEmployeeEmail(assetController || {});
            if (acResolved.email && !to.includes(acResolved.email)) to.push(acResolved.email);
        }

        if (!to.length) return;

        const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
        const assetId = asset.assetId || '';
        const link = getAssetLink(asset);
        const endTxt = formatDate(endDate);
        await transporter.sendMail({
            from: `"VeRP Asset Management" <${emailUser}>`,
            to: to.join(','),
            subject: `Temporary assignment ended (${assetId})`,
            html: `
                <div style="font-family:Segoe UI,Arial,sans-serif;max-width:620px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                    <div style="background:#ef4444;color:#fff;padding:20px 24px">
                        <h2 style="margin:0;font-size:20px">Temporary Assignment Expired</h2>
                        <p style="margin:6px 0 0;opacity:.95;font-size:12px">Ended on ${endTxt}</p>
                    </div>
                    <div style="padding:24px;color:#334155">
                        <p>Hello <strong>${asset.assignedToType === 'Company' ? (hrHOD?.firstName || 'HR') : (assigneeEmployee?.firstName || 'Employee')}</strong>,</p>
                        <p>The following asset temporary assignment has ended. The asset is now moved to <strong>Unassigned</strong>:</p>
                        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:18px 0">
                            <p style="margin:0"><strong>Asset:</strong> ${assetId} - ${asset.name || ''}</p>
                            <p style="margin:6px 0 0"><strong>Assignee:</strong> ${asset.assignedToType === 'Company' ? (assigneeCompany?.name || 'Company') : `${assigneeEmployee?.firstName || ''} ${assigneeEmployee?.lastName || ''}`.trim()}</p>
                        </div>
                        <div style="margin-top:22px;text-align:center">
                            <a href="${link}" style="display:inline-block;background:#ef4444;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:700">View Asset</a>
                        </div>
                    </div>
                    <div style="background:#f8fafc;padding:14px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0">
                        Automated system notification from VeRP Asset Management
                    </div>
                </div>
            `
        });
    } catch (error) {
        console.error('[sendTemporaryAssignmentExpiredEmail] Non-fatal:', error?.message || error);
    }
};

