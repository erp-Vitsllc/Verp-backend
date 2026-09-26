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
        return { sent: false, reason: 'no_employee' };
    }
    const channels = await getEventChannels(eventKey);
    if (!channels.whatsapp) {
        return { sent: false, reason: 'permission_off' };
    }
    const phone = await resolveEmployeeWhatsAppPhone(emp.employeeId);
    if (!phone) {
        return { sent: false, reason: 'no_whatsapp' };
    }
    if (!pdfBuffer?.length) {
        return { sent: false, reason: 'no_pdf' };
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
        return { sent: false, reason: result?.error || 'send_failed' };
    }
    return { sent: true, reason: 'whatsapp', messageId: result.messageId || '' };
}

export async function sendToolsHandoverReportWhatsApp({
    employee,
    pdfBuffer,
    filename = 'tools-handover-report.pdf',
    caption = '',
} = {}) {
    const emp = await resolveEmployeeRecord(employee);
    if (!emp?.employeeId) return { sent: false, reason: 'no_employee' };
    const channels = await getEventChannels(TOOLS_HANDOVER_REPORT_EVENT);
    if (!channels.whatsapp) return { sent: false, reason: 'permission_off' };
    if (!pdfBuffer?.length) return { sent: false, reason: 'no_pdf' };

    const assetLabel = String(caption || '').trim() || 'Tools handover report';
    const companyEmail = String(emp.companyEmail || '').trim();
    if (companyEmail) {
        const mailed = await sendPdfToCompanyEmail({
            eventKey: TOOLS_HANDOVER_REPORT_EVENT,
            employee: emp,
            companyEmail,
            pdfBuffer,
            filename,
            subject: assetLabel,
            html: `<p>Please find the asset assignment handover PDF attached.</p><p>${assetLabel}</p>`,
        });
        return { ...mailed, channel: 'email' };
    }

    const sent = await sendToolsWhatsAppPdf({
        eventKey: TOOLS_HANDOVER_REPORT_EVENT,
        employee: emp,
        pdfBuffer,
        filename,
        caption: assetLabel,
    });
    return { ...sent, channel: sent.sent ? 'whatsapp' : 'none' };
}

export async function sendToolsMonthlyReportWhatsApp({
    employee,
    pdfBuffer,
    filename = 'tools-monthly-report.pdf',
    caption = '',
} = {}) {
    return sendToolsWhatsAppPdf({
        eventKey: TOOLS_MONTHLY_REPORT_EVENT,
        employee,
        pdfBuffer,
        filename,
        caption: caption || 'Tools monthly report — assigned assets',
    });
}
