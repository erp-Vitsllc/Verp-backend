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
    const ref = String(loan?.loanId || '').trim();
    const amount = formatAmount(loan?.amount);
    const amountLine = amount ? ` Amount: AED ${amount}.` : '';
    const refBit = ref ? ` ${ref}` : '';
    return `Your ${typeSlug}${refBit} has been approved.${amountLine} Please find the acknowledgment document attached.`;
}

export function loanEmployeeWhatsAppNote(result) {
    if (!result || result.reason === 'has_company_email') return '';
    if (result.sent && result.reason === 'already_sent') {
        return 'Acknowledgment PDF was already sent to the employee on WhatsApp.';
    }
    if (result.sent) {
        return 'Acknowledgment PDF sent to the employee on WhatsApp.';
    }
    const reason = String(result.reason || '').trim();
    if (reason === 'no_whatsapp') {
        return 'This employee has no company email and no WhatsApp number, so the PDF was not sent to them.';
    }
    if (reason === 'permission_off') {
        return 'WhatsApp for loan approval is turned off, so the PDF was not sent to the employee.';
    }
    if (reason === 'no_pdf') {
        return 'The acknowledgment PDF could not be created, so it was not sent to the employee.';
    }
    if (reason === 'no_employee') {
        return 'Employee record was not found, so the PDF was not sent.';
    }
    if (/131047|re-engagement|24 hours|24-hour/i.test(reason)) {
        return 'WhatsApp did not deliver the PDF. This number has not messaged the company WhatsApp in the last 24 hours, so WhatsApp blocks the document.';
    }
    if (reason) {
        return `The PDF was not sent to the employee on WhatsApp: ${reason}`;
    }
    return 'The PDF was not sent to the employee on WhatsApp.';
}

const recentDelivery = new Map();

export function recentLoanPdfDelivery(loan) {
    const key = String(loan?.loanId || loan?._id || '').trim();
    if (!key) return null;
    const row = recentDelivery.get(key);
    if (!row || Date.now() - row.at > 20000) return null;
    return row.result;
}

function rememberLoanPdfDelivery(loan, result) {
    const key = String(loan?.loanId || loan?._id || '').trim();
    if (!key) return;
    recentDelivery.set(key, { at: Date.now(), result });
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loanPdfAlreadySent(employeeId, loan) {
    const ref = String(loan?.loanId || loan?._id || '').trim();
    if (!employeeId || !ref) return false;
    const WhatsAppMessage = (await import('../models/WhatsAppMessage.js')).default;
    const pattern = new RegExp(escapeRegex(ref), 'i');
    const existing = await WhatsAppMessage.findOne({
        employeeId: String(employeeId).trim(),
        direction: 'out',
        messageType: { $in: ['document', 'template'] },
        status: { $in: ['queued', 'sent', 'delivered', 'read'] },
        $or: [{ body: pattern }, { mediaFileName: pattern }],
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
    if (await loanPdfAlreadySent(emp.employeeId, loan)) {
        return { sent: true, reason: 'already_sent', channel: 'whatsapp' };
    }
    if (!pdfBuffer?.length) {
        return { sent: false, reason: 'no_pdf' };
    }

    const typeSlug = loan?.type === 'Advance' ? 'Advance' : 'Loan';
    const safeName = String(filename || '').trim()
        || `${typeSlug}_Acknowledgment_${loan?.loanId || loan?._id || 'approved'}.pdf`;
    const caption = buildLoanApprovalWhatsAppCaption(loan);

    const loanRef = String(loan?.loanId || '').trim();
    const typeLabel = loanRef ? `${typeSlug} ${loanRef}` : typeSlug;
    const amountText = formatAmount(loan?.amount).replace(/\s/g, '') || '0';
    const { sendDocumentTemplateMessage } = await import('../services/whatsappService.js');
    const result = await sendDocumentTemplateMessage(
        phone,
        {
            buffer: pdfBuffer,
            filename: safeName,
            templateName: 'verp_payment_approved',
            languageCode: 'en',
            bodyParams: [typeLabel, amountText],
        },
        {
            source: 'auto',
            eventKey,
            employeeId: emp.employeeId,
            contactName: employeeDisplayName(emp),
            logBody: caption,
        },
    );
    if (!result?.success) {
        console.warn('[LoanApprovalWhatsApp] send failed', emp.employeeId, result?.error || '');
        return { sent: false, reason: result?.error || 'send_failed' };
    }
    return { sent: true, reason: 'whatsapp', messageId: result.messageId || '' };
}

/**
 * Send the acknowledgment PDF on WhatsApp when the employee has no company email.
 * Builds the PDF when the caller does not already have one.
 */
export async function deliverLoanEmployeeWhatsApp({
    loan,
    employee,
    pdfBuffer,
    filename = '',
} = {}) {
    let result = await sendLoanApprovalWhatsApp({
        loan,
        employee,
        pdfBuffer,
        filename,
    });
    if (result?.reason === 'no_pdf' && loan) {
        try {
            const { getLoanAcknowledgmentPdfBuffer } = await import('./persistLoanApprovalAttachments.js');
            const buffer = await getLoanAcknowledgmentPdfBuffer(loan);
            result = await sendLoanApprovalWhatsApp({
                loan,
                employee,
                pdfBuffer: buffer,
                filename,
            });
        } catch (err) {
            result = { sent: false, reason: err?.message || 'no_pdf' };
        }
    }
    const note = loanEmployeeWhatsAppNote(result);
    rememberLoanPdfDelivery(loan, { ...result, note });
    return { ...result, note };
}

export async function withLoanEmployeeWhatsAppMessage(message, options = {}) {
    try {
        const delivery = await deliverLoanEmployeeWhatsApp(options);
        const note = String(delivery?.note || '').trim();
        return {
            ...delivery,
            message: [message, note].filter(Boolean).join(' '),
        };
    } catch (err) {
        const note = `The PDF was not sent to the employee on WhatsApp: ${err?.message || 'send failed'}`;
        return {
            sent: false,
            reason: err?.message || 'send_failed',
            note,
            message: [message, note].filter(Boolean).join(' '),
        };
    }
}
