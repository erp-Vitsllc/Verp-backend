import nodemailer from 'nodemailer';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Company from '../models/Company.js';
import { sendAssignedEmployeeActionEmail } from './sendAssignedEmployeeActionEmail.js';
import { isUserAdministrator } from '../services/permissionService.js';
import { buildAdminDeletionEmailAttachments } from './buildAdminDeletionEmailAttachments.js';
import {
    buildAdminDeletionFieldsHtmlTable,
    shouldShowDeletionFieldsInManagementEmail,
} from './formatAdminDeletionPayloadForEmail.js';
import { createAdminDeletionArchiveFromDeletion } from '../services/adminDeletionArchiveService.js';
import { awaitAdminDeletionArchive } from './adminDeletionArchiveRun.js';

function getFrontendRestoreBaseUrl() {
    const base =
        process.env.FRONTEND_URL ||
        process.env.CLIENT_URL ||
        process.env.NEXT_PUBLIC_APP_URL ||
        'http://localhost:3000';
    return String(base).replace(/\/$/, '');
}

export async function isReqUserAdmin(reqUser) {
    if (!reqUser) return false;
    if (reqUser.isAdmin === true || reqUser.isAdministrator === true) return true;
    const role = String(reqUser.role || "").trim();
    const userType = String(reqUser.userType || "").trim();
    const groupName = String(reqUser.groupName || "").trim();
    if (/^(admin|administrator|root)$/i.test(role)) return true;
    if (/^(admin|administrator)$/i.test(userType)) return true;
    if (/^(admin|administrator)$/i.test(groupName)) return true;
    if (role === "Admin" || role === "ROOT") return true;
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

async function sendHtmlEmail(to, subject, html, fromName = "VeRP System", attachments = []) {
    if (!to) return;
    const transporter = getTransport();
    if (!transporter) return;
    const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
    await transporter.sendMail({
        from: `"${fromName}" <${emailUser}>`,
        to,
        subject,
        html,
        ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
    });
}

export async function emailAssetControllerHtml(subject, htmlBody, fromName = "VeRP System") {
    try {
        const ac = await getDepartmentHOD('assetcontroller');
        if (!ac) return;
        const { email } = resolveEmployeeEmail(ac);
        if (!email) return;
        await sendHtmlEmail(email, subject, htmlBody, fromName);
    } catch (e) {
        console.error('[emailAssetControllerHtml]', e?.message || e);
    }
}

export async function getAssetControllerNotificationEmail() {
    try {
        const ac = await getDepartmentHOD('assetcontroller');
        if (!ac) return null;
        const { email } = resolveEmployeeEmail(ac);
        return email || null;
    } catch (e) {
        console.error('[getAssetControllerNotificationEmail]', e?.message || e);
        return null;
    }
}

export async function getManagementNotificationEmail() {
    try {
        const mgmt = await getDepartmentHOD('management');
        if (!mgmt) return null;
        const { email } = resolveEmployeeEmail(mgmt);
        return email || null;
    } catch (e) {
        console.error('[getManagementNotificationEmail]', e?.message || e);
        return null;
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
    await emailAssetControllerHtml(subject, html, performedBy);
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
    await emailAssetControllerHtml(subject, html, performedBy);
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
    await awaitAdminDeletionArchive(req, {
        moduleName: 'Asset',
        recordId: assetId,
        details: `Asset ${assetName} permanently deleted`,
        deletedPayload: asset,
    });

    await emailAssetControllerHtml(subject, html, performedBy);

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

    if (req && removedAccessories?.length) {
        await awaitAdminDeletionArchive(req, {
            moduleName: 'Asset Accessories',
            recordId: assetId,
            details: `Removed from ${assetName}: ${names}`,
            deletedPayload: {
                assetId: asset.assetId,
                mongoAssetId: asset._id,
                assetName,
                removedAccessories,
            },
        });
    }

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
    await emailAssetControllerHtml(subject, html, performedBy);

    const hasAssignee = asset.assignedTo || (asset.assignedToType === 'Company' && asset.assignedCompany);
    if (!hasAssignee) return;

    await notifyAssignedPartyForAdminDeletion(req, asset, {
        actionLabel: 'Accessories removed',
        details: `Removed accessories: ${names}.`
    });
}

export async function notifyAdminDeletedBusinessRecordToManagement(
    req,
    { moduleName, recordId, details, deletedPayload, archiveId, preservedAttachments } = {}
) {
    try {
        const to = await getManagementNotificationEmail();
        if (!to) return false;
        const performedBy = performedByLine(req);
        const subject = `${moduleName} deleted (admin): ${recordId || 'record'}`;
        const restoreLink = archiveId
            ? `${getFrontendRestoreBaseUrl()}/Settings/DeletedRecords?item=${archiveId}`
            : `${getFrontendRestoreBaseUrl()}/Settings/DeletedRecords`;
        const restoreBlock = `
            <div style="margin-top:20px;padding:16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">
                <p style="margin:0 0 12px;font-size:14px;color:#334155">
                    This deletion is held in recovery. You may restore the record or permanently remove it from recovery.
                </p>
                <a href="${restoreLink}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px">
                    Open Deleted Records
                </a>
            </div>`;
        const html = `
            <div style="font-family:Arial,sans-serif;color:#334155;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
                <div style="background:#b91c1c;color:#fff;padding:16px 20px">
                    <h3 style="margin:0">${moduleName} deleted</h3>
                </div>
                <div style="padding:20px">
                    <p>An administrator deleted a ${moduleName} record from the ERP (not moved to Old Documents). It remains in recovery until restored or permanently removed.</p>
                    <p><strong>Record ID:</strong> ${recordId || '—'}</p>
                    <p><strong>Details:</strong> ${details || '—'}</p>
                    <p><strong>Performed by:</strong> ${performedBy}</p>
                    <div id="mgmt-del-fields"></div>
                    <p id="mgmt-del-attach-note" style="font-size:12px;color:#64748b;"></p>
                    ${restoreBlock}
                </div>
            </div>`;
        const attachments =
            deletedPayload != null || preservedAttachments?.length
                ? await buildAdminDeletionEmailAttachments(deletedPayload, preservedAttachments)
                : [];
        const showFieldDetails = shouldShowDeletionFieldsInManagementEmail({
            moduleName,
            deletedPayload,
        });
        const fieldsBlock =
            showFieldDetails && deletedPayload != null
                ? buildAdminDeletionFieldsHtmlTable(deletedPayload)
                : '';
        const listDeleteNote = !showFieldDetails
            ? `<p style="font-size:13px;color:#64748b;margin-top:12px;">Full record data and attachments are available under <strong>Deleted Records</strong> in Settings.</p>`
            : '';
        const attachLine =
            attachments.length > 0
                ? `<p style="font-size:12px;color:#64748b;">Uploaded file(s) are attached to this email (${attachments.length}).</p>`
                : '';
        let htmlFinal = html.replace('<div id="mgmt-del-fields"></div>', fieldsBlock + listDeleteNote);
        htmlFinal = htmlFinal.replace(
            '<p id="mgmt-del-attach-note" style="font-size:12px;color:#64748b;"></p>',
            attachLine
        );
        await sendHtmlEmail(to, subject, htmlFinal, performedBy, attachments);
        return true;
    } catch (e) {
        console.error('[notifyAdminDeletedBusinessRecordToManagement]', e?.message || e);
        return false;
    }
}

/** Create recovery archive, preserve files, and email management (awaitable). */
export async function runManagementAdminDeletionArchive(req, opts) {
    let archiveId = null;
    try {
        const archive = await createAdminDeletionArchiveFromDeletion(req, opts);
        archiveId = archive?._id?.toString?.() || String(archive?._id || '');
        await notifyAdminDeletedBusinessRecordToManagement(req, {
            ...opts,
            archiveId,
            preservedAttachments: archive?.preservedAttachments,
        });
        return archive;
    } catch (e) {
        console.error('[runManagementAdminDeletionArchive] archive:', e?.message || e);
        await notifyAdminDeletedBusinessRecordToManagement(req, { ...opts, archiveId });
        return null;
    }
}

export function scheduleManagementAdminDeletionEmail(req, opts) {
    void runManagementAdminDeletionArchive(req, opts).catch((e) =>
        console.error('[scheduleManagementAdminDeletionEmail]', e?.message || e)
    );
}
