import EmployeeContact from '../models/EmployeeContact.js';
import { getEventChannels } from './notificationEmailPermission.js';
import { usableWhatsAppNumber } from './normalizeWhatsAppPhone.js';
import { isFleetVehicleAsset } from './assetApprovalHelpers.js';

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
    if (employee.employeeId) return employee;
    const id = employee._id || employee.id || employee;
    if (!id) return null;
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
    return EmployeeBasic.findById(id).select('firstName lastName employeeId').lean();
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
    const assetLabel = String(caption || '').trim() || 'Tools handover report';
    return sendToolsWhatsAppPdf({
        eventKey: TOOLS_HANDOVER_REPORT_EVENT,
        employee,
        pdfBuffer,
        filename,
        caption: assetLabel,
    });
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
