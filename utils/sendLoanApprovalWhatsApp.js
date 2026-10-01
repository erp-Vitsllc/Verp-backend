import { getEventChannels } from './notificationEmailPermission.js';
import { resolveEmployeeWhatsAppPhone } from './sendToolsAssetWhatsAppReport.js';

export const LOAN_APPROVED_EVENT = 'hrm.loan.approved';
export const ADVANCE_APPROVED_EVENT = 'hrm.loan.advance_approved';

export function loanApprovalWhatsAppEventKey(loan) {
    return loan?.type === 'Advance' ? ADVANCE_APPROVED_EVENT : LOAN_APPROVED_EVENT;
}

function employeeDisplayName(employee) {
    return [employee?.firstName, employee?.lastName].filter(Boolean).join(' ').trim();
}

function formatAmount(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value)) return '';
    return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function buildLoanApprovalWhatsAppCaption(loan) {
    const typeSlug = loan?.type === 'Advance' ? 'Advance' : 'Loan';
    const amount = formatAmount(loan?.amount);
    const amountLine = amount ? ` Amount: AED ${amount}.` : '';
    return `Your ${typeSlug} has been approved.${amountLine} Please find the acknowledgment document attached.`;
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
 * WhatsApp gets the acknowledgment PDF only when the employee has no company email.
 */
export async function sendLoanApprovalWhatsApp({
    loan,
    employee,
    pdfBuffer,
    filename = '',
} = {}) {
    const emp = employee?.employeeId ? employee : null;
    if (!emp?.employeeId) {
        return { sent: false, reason: 'no_employee' };
    }

    if (await employeeCompanyEmail(emp)) {
        return { sent: false, reason: 'has_company_email', channel: 'email' };
    }

    const eventKey = loanApprovalWhatsAppEventKey(loan);
    const channels = await getEventChannels(eventKey);
    if (!channels.whatsapp) {
        return { sent: false, reason: 'permission_off', channel: 'whatsapp' };
    }

    const phone = await resolveEmployeeWhatsAppPhone(emp.employeeId);
    if (!phone) {
        return { sent: false, reason: 'no_whatsapp' };
    }
    if (!pdfBuffer?.length) {
        return { sent: false, reason: 'no_pdf' };
    }

    const typeSlug = loan?.type === 'Advance' ? 'Advance' : 'Loan';
    const safeName = String(filename || '').trim()
        || `${typeSlug}_Acknowledgment_${loan?.loanId || loan?._id || 'approved'}.pdf`;
    const caption = buildLoanApprovalWhatsAppCaption(loan);

    const { sendDocumentMessage } = await import('../services/whatsappService.js');
    const result = await sendDocumentMessage(
        phone,
        { buffer: pdfBuffer, filename: safeName, caption },
        {
            source: 'auto',
            eventKey,
            skipPaidChannelCheck: true,
            employeeId: emp.employeeId,
            contactName: employeeDisplayName(emp),
        },
    );
    if (!result?.success) {
        console.warn('[LoanApprovalWhatsApp] send failed', emp.employeeId, result?.error || '');
        return { sent: false, reason: result?.error || 'send_failed' };
    }
    return { sent: true, reason: 'whatsapp', messageId: result.messageId || '' };
}
