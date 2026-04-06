import nodemailer from 'nodemailer';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Company from '../models/Company.js';
import { sendAssignedEmployeeActionEmail } from './sendAssignedEmployeeActionEmail.js';
import { isUserAdministrator } from '../services/permissionService.js';

export async function isReqUserAdmin(reqUser) {
    if (!reqUser) return false;
    if (reqUser.isAdmin === true || reqUser.role === 'Admin' || reqUser.role === 'ROOT') return true;
    const uid = reqUser.id || reqUser._id?.toString?.();
    return uid ? !!(await isUserAdministrator(uid)) : false;
}

function getTransport() {
    const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
    const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
    if (!emailUser || !emailPass) return null;
    let smtpHost = process.env.SMTP_HOST || 'smtp.office365.com';
    if (emailUser.includes('@gmail.com')) smtpHost = 'smtp.gmail.com';
    return nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass }
    });
}

async function sendHtmlEmail(to, subject, html) {
    if (!to) return;
    const transporter = getTransport();
    if (!transporter) return;
    const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
    await transporter.sendMail({
        from: `"VeRP Asset Management" <${emailUser}>`,
        to,
        subject,
        html
    });
}

export async function emailAssetControllerHtml(subject, htmlBody) {
    try {
        const ac = await getDepartmentHOD('assetcontroller');
        if (!ac) return;
        const { email } = resolveEmployeeEmail(ac);
        if (!email) return;
        await sendHtmlEmail(email, subject, htmlBody);
    } catch (e) {
        console.error('[emailAssetControllerHtml]', e?.message || e);
    }
}

function performedByLine(req) {
    return req.user?.name || req.user?.employeeId || 'Administrator';
}

/**
 * When an asset is assigned to a company, HR receives the same style of notice as other asset emails.
 * When assigned to an employee, the assignee is emailed; resolveEmployeeEmail inside sendAssignedEmployeeActionEmail
 * routes to primary reportee if there is no company email.
 */
async function notifyAssignedPartyForAdminDeletion(req, asset, { actionLabel, details }) {
    try {
        if (!asset) return;

        const hasEmployeeAssignee = !!asset.assignedTo;
        const hasCompanyAssignee = asset.assignedToType === 'Company' && asset.assignedCompany;

        if (!hasEmployeeAssignee && !hasCompanyAssignee) return;

        if (hasCompanyAssignee) {
            const hrHOD = await getDepartmentHOD('hr');
            if (!hrHOD) return;
            let companyDoc = asset.assignedCompany;
            if (typeof companyDoc !== 'object' || !companyDoc?.name) {
                companyDoc = await Company.findById(asset.assignedCompany).select('name companyId').lean();
            }
            const companyName = companyDoc?.name || '';
            await sendAssignedEmployeeActionEmail({
                asset,
                employee: hrHOD,
                action: actionLabel,
                performedBy: performedByLine(req),
                details: `${details}${companyName ? ` (Company: ${companyName})` : ''}`,
                customIntro: '<strong>Administrator action on a company-assigned asset:</strong>'
            });
            return;
        }

        const employee = await EmployeeBasic.findById(asset.assignedTo)
            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
            .lean();
        if (!employee) return;

        await sendAssignedEmployeeActionEmail({
            asset,
            employee,
            action: actionLabel,
            performedBy: performedByLine(req),
            details,
            customIntro: '<strong>Administrator action on your assigned asset:</strong>'
        });
    } catch (e) {
        console.error('[notifyAssignedPartyForAdminDeletion]', e?.message || e);
    }
}

export async function notifyAdminDeletedAssetTypeOrCategory({ kind, name, performedBy }) {
    const subject = `Asset ${kind} removed (admin)`;
    const html = `
        <div style="font-family:Arial,sans-serif;color:#334155;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
            <div style="background:#0ea5e9;color:#fff;padding:16px 20px">
                <h3 style="margin:0">Catalog update</h3>
            </div>
            <div style="padding:20px">
                <p>An administrator removed an asset ${String(kind).toLowerCase()} from the catalog.</p>
                <p><strong>${kind}:</strong> ${name || '—'}</p>
                <p><strong>Performed by:</strong> ${performedBy}</p>
            </div>
        </div>`;
    await emailAssetControllerHtml(subject, html);
}

export async function notifyAdminDeletedAccessoryCatalogEntry({ accessoryCatalogId, name, performedBy }) {
    const subject = 'Accessory catalog entry removed (admin)';
    const html = `
        <div style="font-family:Arial,sans-serif;color:#334155;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
            <div style="background:#0ea5e9;color:#fff;padding:16px 20px">
                <h3 style="margin:0">Accessory catalog</h3>
            </div>
            <div style="padding:20px">
                <p>An administrator removed an accessory from the master catalog.</p>
                <p><strong>ID:</strong> ${accessoryCatalogId || '—'}</p>
                <p><strong>Name:</strong> ${name || '—'}</p>
                <p><strong>Performed by:</strong> ${performedBy}</p>
            </div>
        </div>`;
    await emailAssetControllerHtml(subject, html);
}

export async function notifyAdminDeletedWholeAsset(req, asset) {
    const performedBy = performedByLine(req);
    const assetId = asset.assetId || '—';
    const assetName = asset.name || '—';

    const subject = `Asset deleted (admin): ${assetId}`;
    const html = `
        <div style="font-family:Arial,sans-serif;color:#334155;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
            <div style="background:#b91c1c;color:#fff;padding:16px 20px">
                <h3 style="margin:0">Asset deleted</h3>
            </div>
            <div style="padding:20px">
                <p>An administrator permanently deleted an asset record.</p>
                <p><strong>Asset ID:</strong> ${assetId}</p>
                <p><strong>Name:</strong> ${assetName}</p>
                <p><strong>Performed by:</strong> ${performedBy}</p>
            </div>
        </div>`;
    await emailAssetControllerHtml(subject, html);

    await notifyAssignedPartyForAdminDeletion(req, asset, {
        actionLabel: 'Asset deleted',
        details: `The asset ${assetId} (${assetName}) was permanently deleted by an administrator.`
    });
}

export async function notifyAdminRemovedAccessoriesFromAssignedAsset(req, asset, removedAccessories) {
    const performedBy = performedByLine(req);
    const names =
        removedAccessories.map((r) => r.name || r.accessoryId).filter(Boolean).join(', ') || '—';
    const assetId = asset.assetId || '—';
    const assetName = asset.name || '—';

    const subject = `Accessories removed (admin): ${assetId}`;
    const html = `
        <div style="font-family:Arial,sans-serif;color:#334155;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
            <div style="background:#c2410c;color:#fff;padding:16px 20px">
                <h3 style="margin:0">Accessories removed</h3>
            </div>
            <div style="padding:20px">
                <p>An administrator removed one or more accessories from asset <strong>${assetId}</strong>.</p>
                <p><strong>Asset:</strong> ${assetName}</p>
                <p><strong>Removed:</strong> ${names}</p>
                <p><strong>Performed by:</strong> ${performedBy}</p>
            </div>
        </div>`;
    await emailAssetControllerHtml(subject, html);

    const hasAssignee = asset.assignedTo || (asset.assignedToType === 'Company' && asset.assignedCompany);
    if (!hasAssignee) return;

    await notifyAssignedPartyForAdminDeletion(req, asset, {
        actionLabel: 'Accessories removed',
        details: `Removed accessories: ${names}.`
    });
}
