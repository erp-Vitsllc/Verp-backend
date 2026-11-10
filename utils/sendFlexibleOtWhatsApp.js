import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { isWhatsAppEnabled } from '../config/whatsapp.js';
import { resolveEmployeeWhatsAppPhone } from './sendToolsAssetWhatsAppReport.js';

function safeName(value) {
    return String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}

function greeting(firstName) {
    const name = safeName(firstName);
    return name ? `Hello ${name},` : 'Hello,';
}

function approvedOtHrsLabel(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours <= 0) return '0 hrs';
    const rounded = Math.round(hours * 100) / 100;
    const shown = Number.isInteger(rounded) ? String(rounded) : String(rounded);
    return shown === '1' ? '1 hr' : `${shown} hrs`;
}

/**
 * Sent only when HR approves overtime that stays as OT.
 * Hours used to mark another day Present do not send a message.
 */
export function buildFlexibleOtWhatsAppText({
    firstName = '',
    approvedHours = 0,
    monthTotalHours = 0,
} = {}) {
    const hello = greeting(firstName);
    const approved = approvedOtHrsLabel(approvedHours);
    const total = approvedOtHrsLabel(monthTotalHours);
    return `${hello} you have approved ${approved} OT. Total OT is ${total}.`;
}

function monthBounds(dateKey) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(dateKey || '').trim());
    if (!match) return null;
    const last = new Date(Number(match[1]), Number(match[2]), 0).getDate();
    const prefix = `${match[1]}-${match[2]}`;
    return { from: `${prefix}-01`, to: `${prefix}-${String(last).padStart(2, '0')}` };
}

/** Approved OT still kept as overtime. Hours used for a Present day are not included. */
export async function approvedOtHoursForMonth(record) {
    const bounds = monthBounds(record?.date);
    if (!bounds || !record?.employeeMongoId) return 0;
    const rows = await Attendance.find({
        employeeMongoId: record.employeeMongoId,
        date: { $gte: bounds.from, $lte: bounds.to },
        flexibleOtStatus: 'approved',
    })
        .select('flexibleOtApprovedHours flexibleOtNextDayDate')
        .lean();
    let total = 0;
    for (const row of rows) {
        if (String(row?.flexibleOtNextDayDate || '').trim()) continue;
        const hours = Number(row?.flexibleOtApprovedHours) || 0;
        if (hours > 0) total += hours;
    }
    return Math.round(total * 100) / 100;
}

function safeLogError(error) {
    return String(error || 'send failed').replace(/\d{8,}/g, '[number]');
}

async function resolveNoticeEmployee(record) {
    const select = 'employeeId firstName lastName';
    const mongoId = record?.employeeMongoId;
    if (mongoId) {
        const byId = await EmployeeBasic.findById(mongoId).select(select).lean();
        if (byId?.employeeId) return byId;
    }
    const code = String(record?.employeeId || '').trim();
    if (!code) return null;
    return EmployeeBasic.findOne({ employeeId: code }).select(select).lean();
}

function noticeActor(actor) {
    if (!actor || typeof actor !== 'object') return null;
    return {
        _id: actor._id || actor.id || '',
        firstName: actor.firstName || '',
        lastName: actor.lastName || '',
    };
}

/**
 * Profile WhatsApp number only. Contact number is never used.
 * A failed send does not undo the HR decision.
 */
export async function notifyEmployeeFlexibleOtWhatsApp({
    record,
    nextDayPresent = false,
    approvedHours = 0,
    actor = null,
} = {}) {
    try {
        if (nextDayPresent === true) return { sent: false, reason: 'present_day' };
        if (!isWhatsAppEnabled()) return { sent: false, reason: 'disabled' };

        const employee = await resolveNoticeEmployee(record);
        const employeeId = String(employee?.employeeId || record?.employeeId || '').trim();
        if (!employeeId) return { sent: false, reason: 'no_employee' };

        const phone = await resolveEmployeeWhatsAppPhone(employeeId);
        if (!phone) return { sent: false, reason: 'no_whatsapp' };

        const monthTotalHours = await approvedOtHoursForMonth(record);
        const text = buildFlexibleOtWhatsAppText({
            firstName: employee?.firstName,
            approvedHours,
            monthTotalHours,
        });

        const { sendTextMessage } = await import('../services/whatsappService.js');
        const result = await sendTextMessage(phone, text, {
            source: 'auto',
            skipPaidChannelCheck: true,
            actor: noticeActor(actor),
            employeeId,
            contactName: [employee?.firstName, employee?.lastName].filter(Boolean).join(' ').trim(),
        });
        if (!result?.success) {
            console.warn('[FlexibleOtWhatsApp] send failed', employeeId, safeLogError(result?.error));
            return { sent: false, reason: 'send_failed' };
        }
        return { sent: true, reason: 'whatsapp' };
    } catch (error) {
        console.warn('[FlexibleOtWhatsApp] send failed', safeLogError(error?.message || error));
        return { sent: false, reason: 'send_failed' };
    }
}
