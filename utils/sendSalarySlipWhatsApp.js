import EmployeeBasic from '../models/EmployeeBasic.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import SalaryMonthDmf from '../models/SalaryMonthDmf.js';
import { getEventChannels } from './notificationEmailPermission.js';
import { resolveEmployeeWhatsAppPhone } from './sendToolsAssetWhatsAppReport.js';
import { AUTOMATED_WHATSAPP, sendAutomatedWhatsApp } from './whatsappAutomation.js';

export const SALARY_SLIP_WHATSAPP_EVENT = 'hrm.salary.slip';

function personName(row) {
    return `${row?.firstName || ''} ${row?.lastName || ''}`.trim() || row?.employeeId || '';
}

export function salarySlipWhatsAppCaption(monthLabel) {
    const month = String(monthLabel || '').trim() || 'this month';
    return `Your salary slip for ${month} is attached.`;
}

async function alreadySent(employeeId, caption) {
    const WhatsAppMessage = (await import('../models/WhatsAppMessage.js')).default;
    const existing = await WhatsAppMessage.findOne({
        employeeId: String(employeeId || '').trim(),
        direction: 'out',
        messageType: { $in: ['document', 'template'] },
        body: caption,
        status: { $in: ['queued', 'sent', 'delivered', 'read'] },
    })
        .select('_id')
        .lean();
    return Boolean(existing);
}

/**
 * WhatsApp the filled salary-slip PDF once, only when the month payroll is
 * approved, the employee is set to receive a slip, and they have no company email.
 */
export async function sendSalarySlipWhatsApp({
    employeeId,
    monthKey,
    monthLabel = '',
    pdfBuffer,
    filename = '',
} = {}) {
    const code = String(employeeId || '').trim();
    const ym = String(monthKey || '').trim();
    if (!code || !ym) return { sent: false, reason: 'missing' };
    if (!pdfBuffer?.length) return { sent: false, reason: 'no_pdf' };

    const [emp, profile, monthDoc] = await Promise.all([
        EmployeeBasic.findOne({ employeeId: code })
            .select('employeeId firstName lastName companyEmail')
            .lean(),
        SalaryHistoricalProfile.findOne({ employeeId: code }).select('salarySlip').lean(),
        SalaryMonthDmf.findOne({ monthKey: ym }).select('dmfApproval.status').lean(),
    ]);
    if (!emp) return { sent: false, reason: 'no_employee' };
    if (String(emp.companyEmail || '').trim()) {
        return { sent: false, reason: 'has_company_email', channel: 'email' };
    }
    if (!profile?.salarySlip) return { sent: false, reason: 'slip_unchecked' };
    if (String(monthDoc?.dmfApproval?.status || '') !== 'approved') {
        return { sent: false, reason: 'month_not_approved' };
    }

    const channels = await getEventChannels(SALARY_SLIP_WHATSAPP_EVENT);
    if (!channels.whatsapp) return { sent: false, reason: 'permission_off' };

    const phone = await resolveEmployeeWhatsAppPhone(code);
    if (!phone) return { sent: false, reason: 'no_whatsapp' };

    const caption = salarySlipWhatsAppCaption(monthLabel);
    if (await alreadySent(code, caption)) return { sent: false, reason: 'already_sent' };

    const safeName = String(filename || '').trim() || `Salary-Slip-${ym}-${code}.pdf`;
    const result = await sendAutomatedWhatsApp({
        phone,
        templateName: AUTOMATED_WHATSAPP.salarySlip,
        bodyParams: [personName(emp) || code, String(monthLabel || ym).trim() || ym],
        document: { buffer: pdfBuffer, filename: safeName, mimeType: 'application/pdf' },
        extras: {
            source: 'auto',
            eventKey: SALARY_SLIP_WHATSAPP_EVENT,
            skipPaidChannelCheck: true,
            employeeId: code,
            contactName: personName(emp),
            logBody: caption,
        },
        session: { caption, filename: safeName },
    });
    if (!result?.success) {
        console.warn('[SalarySlipWhatsApp] send failed', code, result?.error || '');
        return { sent: false, reason: result?.error || 'send_failed' };
    }
    return { sent: true, reason: 'whatsapp', messageId: result.messageId || '' };
}
