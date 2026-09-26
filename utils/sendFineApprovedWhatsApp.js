import { getEventChannels } from './notificationEmailPermission.js';
import { resolveEmployeeWhatsAppPhone } from './sendToolsAssetWhatsAppReport.js';

export const FINE_APPROVED_EVENT = 'hrm.fine.approved';

function employeeDisplayName(employee) {
    return [employee?.firstName, employee?.lastName].filter(Boolean).join(' ').trim();
}

/**
 * WhatsApp only when Fine approved is checked, the employee has no company email,
 * and they have a WhatsApp number. Company-email delivery stays on the email path.
 */
export async function sendFineApprovedWhatsApp({
    fine,
    employee,
    pdfBuffer,
    filename = '',
} = {}) {
    if (!employee?.employeeId) return { sent: false, reason: 'no_employee' };
    const channels = await getEventChannels(FINE_APPROVED_EVENT);
    if (!channels.whatsapp) return { sent: false, reason: 'permission_off' };
    if (String(employee.companyEmail || '').trim()) {
        return { sent: false, reason: 'has_company_email' };
    }
    const phone = await resolveEmployeeWhatsAppPhone(employee.employeeId);
    if (!phone) return { sent: false, reason: 'no_whatsapp' };
    if (!pdfBuffer?.length) return { sent: false, reason: 'no_pdf' };

    const safeName = String(filename || '').trim()
        || `Fine_Approved_${fine?.fineId || fine?._id || 'approved'}.pdf`;
    const caption = `Your fine ${fine?.fineId || ''} has been approved. Please find the PDF attached.`.trim();
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
        },
    );
    if (!result?.success) {
        console.warn('[FineApprovedWhatsApp] send failed', employee.employeeId, result?.error || '');
        return { sent: false, reason: result?.error || 'send_failed' };
    }
    return { sent: true, reason: 'whatsapp', messageId: result.messageId || '' };
}
