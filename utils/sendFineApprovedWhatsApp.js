import { getEventChannels } from './notificationEmailPermission.js';
import { resolveEmployeeWhatsAppPhone } from './sendToolsAssetWhatsAppReport.js';

export const FINE_APPROVED_EVENT = 'hrm.fine.approved';

function employeeDisplayName(employee) {
    return [employee?.firstName, employee?.lastName].filter(Boolean).join(' ').trim();
}

function approvalPdfUrl(fine) {
    const rows = Array.isArray(fine?.approvalAttachments) ? fine.approvalAttachments : [];
    const match = [...rows].reverse().find((row) => {
        const url = String(row?.url || '').trim();
        if (!url) return false;
        const source = String(row?.source || '');
        const mime = String(row?.mimeType || '');
        return source === 'approved-form' || source === 'asset-loss-report' || mime.includes('pdf');
    });
    return String(match?.url || '').trim();
}

async function finePdfAlreadySent(employeeId, caption) {
    const WhatsAppMessage = (await import('../models/WhatsAppMessage.js')).default;
    const existing = await WhatsAppMessage.findOne({
        employeeId: String(employeeId || '').trim(),
        direction: 'out',
        messageType: 'document',
        body: caption,
        status: { $in: ['queued', 'sent', 'delivered', 'read'] },
    })
        .select('_id')
        .lean();
    return Boolean(existing);
}

async function employeeCompanyEmail(employee) {
    const direct = String(employee?.companyEmail || '').trim();
    if (direct) return direct;
    if (!employee?.employeeId || employee?.companyEmail === '') return '';
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
    const row = await EmployeeBasic.findOne({ employeeId: employee.employeeId }).select('companyEmail').lean();
    return String(row?.companyEmail || '').trim();
}

/**
 * WhatsApp when Fine approved is checked and the employee has no company email.
 */
export async function sendFineApprovedWhatsApp({
    fine,
    employee,
    pdfBuffer,
    filename = '',
    allowResend = false,
} = {}) {
    if (!employee?.employeeId) return { sent: false, reason: 'no_employee' };
    if (await employeeCompanyEmail(employee)) {
        return { sent: false, reason: 'has_company_email', channel: 'email' };
    }
    const channels = await getEventChannels(FINE_APPROVED_EVENT);
    if (!channels.whatsapp) return { sent: false, reason: 'permission_off' };
    const phone = await resolveEmployeeWhatsAppPhone(employee.employeeId);
    if (!phone) return { sent: false, reason: 'no_whatsapp' };
    if (!pdfBuffer?.length) return { sent: false, reason: 'no_pdf' };

    const safeName = String(filename || '').trim()
        || `Fine_Approved_${fine?.fineId || fine?._id || 'approved'}.pdf`;
    const caption = `Your fine ${fine?.fineId || ''} has been approved. Please find the PDF attached.`.trim();
    if (!allowResend && await finePdfAlreadySent(employee.employeeId, caption)) {
        return { sent: false, reason: 'already_sent' };
    }
    const { sendDocumentMessage } = await import('../services/whatsappService.js');
    const result = await sendDocumentMessage(
        phone,
        { buffer: pdfBuffer, filename: safeName, caption },
        {
            source: 'auto',
            eventKey: FINE_APPROVED_EVENT,
            skipPaidChannelCheck: true,
            employeeId: employee.employeeId,
            contactName: employeeDisplayName(employee),
            mediaUrl: approvalPdfUrl(fine),
        },
    );
    if (!result?.success) {
        console.warn('[FineApprovedWhatsApp] send failed', employee.employeeId, result?.error || '');
        return { sent: false, reason: result?.error || 'send_failed' };
    }
    return { sent: true, reason: 'whatsapp', messageId: result.messageId || '' };
}
