import EmployeeContact from '../models/EmployeeContact.js';
import { getEventChannels } from './notificationEmailPermission.js';
import { usableWhatsAppNumber } from './normalizeWhatsAppPhone.js';
import { isFleetVehicleAsset } from './assetApprovalHelpers.js';
import { buildEmailDedupeKey, sendErpEmail } from './emailDispatch.js';

export const TOOLS_HANDOVER_REPORT_EVENT = 'hrm.tools.handover_report';
export const TOOLS_MONTHLY_REPORT_EVENT = 'hrm.tools.monthly_report';

export function isToolsAssetItem(asset) {
    if (!asset) return false;
    if (isFleetVehicleAsset(asset)) return false;
    return /^VEGA-ASSET-/i.test(String(asset.assetId || ''));
}

/** Basic Details WhatsApp number only. Contact number is never used. */
export async function resolveEmployeeWhatsAppPhone(employeeId) {
    const code = String(employeeId || '').trim();
    if (!code) return '';
    const contact = await EmployeeContact.findOne({ employeeId: code }).select('whatsappNumber').lean();
    return usableWhatsAppNumber(contact?.whatsappNumber || '');
}

async function resolveEmployeeRecord(employee) {
    if (!employee) return null;
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
    if (employee.employeeId && employee.companyEmail !== undefined) return employee;
    if (employee.employeeId) {
        const byCode = await EmployeeBasic.findOne({ employeeId: employee.employeeId })
            .select('firstName lastName employeeId companyEmail')
            .lean();
        if (byCode) return byCode;
    }
    const id = employee._id || employee.id || employee;
    if (!id || (typeof id === 'string' && !/^[a-f0-9]{24}$/i.test(id))) {
        return employee.employeeId ? employee : null;
    }
    return EmployeeBasic.findById(id).select('firstName lastName employeeId companyEmail').lean();
}

async function sendPdfToCompanyEmail({ eventKey, employee, companyEmail, pdfBuffer, filename, subject, html }) {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass || !companyEmail || !pdfBuffer?.length) {
        return { sent: false, reason: 'email_not_configured' };
    }
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
    const result = await sendErpEmail({
        transporter,
        from: `"VeRP Asset Management" <${emailUser}>`,
        to: [companyEmail],
        subject,
        html,
        attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
        dedupeKey: buildEmailDedupeKey([eventKey, employee.employeeId, filename]),
        module: eventKey,
        emailType: eventKey,
        recordId: String(employee.employeeId || ''),
        metadata: { eventKey },
    });
    return { sent: result?.sent === true, reason: result?.sent ? 'email' : result?.reason || 'email_failed', channel: 'email' };
}

async function sendToolsWhatsAppPdf({ eventKey, employee, pdfBuffer, filename, caption }) {
    const emp = await resolveEmployeeRecord(employee);
    if (!emp?.employeeId) {
        return { sent: false, reason: 'no_employee', channel: 'whatsapp' };
    }
    if (String(emp.companyEmail || '').trim()) {
        return { sent: false, reason: 'has_company_email', channel: 'email' };
    }
    const channels = await getEventChannels(eventKey);
    if (!channels.whatsapp) {
        return { sent: false, reason: 'permission_off', channel: 'whatsapp' };
    }
    const phone = await resolveEmployeeWhatsAppPhone(emp.employeeId);
    if (!phone) {
        return { sent: false, reason: 'no_whatsapp', channel: 'whatsapp' };
    }
    if (!pdfBuffer?.length) {
        return { sent: false, reason: 'no_pdf', channel: 'whatsapp' };
    }

    const name = [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim();
    const { sendDocumentMessage } = await import('../services/whatsappService.js');
    const result = await sendDocumentMessage(
        phone,
        { buffer: pdfBuffer, filename, caption },
        {
            source: 'auto',
            eventKey,
            skipPaidChannelCheck: true,
            employeeId: emp.employeeId,
            contactName: name,
        },
    );
    if (!result?.success) {
        console.warn('[ToolsWhatsApp] send failed', emp.employeeId, result?.error || '');
        return { sent: false, reason: result?.error || 'send_failed', channel: 'whatsapp' };
    }
    return { sent: true, reason: 'whatsapp', channel: 'whatsapp', messageId: result.messageId || '' };
}

/**
 * Company email gets the PDF. WhatsApp is used only when there is no company email.
 */
async function deliverToolsPdf({ eventKey, employee, pdfBuffer, filename, caption, subject, html }) {
    const emp = await resolveEmployeeRecord(employee);
    if (!emp?.employeeId) return { sent: false, reason: 'no_employee', channel: 'none' };
    if (!pdfBuffer?.length) return { sent: false, reason: 'no_pdf', channel: 'none' };

    const companyEmail = String(emp.companyEmail || '').trim();
    if (companyEmail) {
        const mailed = await sendPdfToCompanyEmail({
            eventKey,
            employee: emp,
            companyEmail,
            pdfBuffer,
            filename,
            subject: subject || caption || 'Attachment',
            html: html || `<p>Please find the PDF attached.</p><p>${caption || ''}</p>`,
        });
        return {
            sent: mailed.sent === true,
            reason: mailed.reason || (mailed.sent ? 'email' : 'email_failed'),
            channel: 'email',
        };
    }

    return sendToolsWhatsAppPdf({ eventKey, employee: emp, pdfBuffer, filename, caption });
}

export async function sendToolsHandoverReportWhatsApp({
    employee,
    pdfBuffer,
    filename = 'tools-handover-report.pdf',
    caption = '',
} = {}) {
    const emp = await resolveEmployeeRecord(employee);
    if (!emp?.employeeId) return { sent: false, reason: 'no_employee' };
    if (!pdfBuffer?.length) return { sent: false, reason: 'no_pdf' };

    const assetLabel = String(caption || '').trim() || 'Tools handover report';
    return deliverToolsPdf({
        eventKey: TOOLS_HANDOVER_REPORT_EVENT,
        employee: emp,
        pdfBuffer,
        filename,
        caption: assetLabel,
        subject: assetLabel,
        html: `<p>Please find the asset assignment handover PDF attached.</p><p>${assetLabel}</p>`,
    });
}

export async function sendToolsMonthlyReportWhatsApp({
    employee,
    pdfBuffer,
    filename = 'tools-monthly-report.pdf',
    caption = '',
} = {}) {
    const label = String(caption || '').trim() || 'Tools monthly report — assigned assets';
    return deliverToolsPdf({
        eventKey: TOOLS_MONTHLY_REPORT_EVENT,
        employee,
        pdfBuffer,
        filename,
        caption: label,
        subject: label,
        html: `<p>Please find the monthly assigned-asset PDF attached.</p><p>${label}</p>`,
    });
}
