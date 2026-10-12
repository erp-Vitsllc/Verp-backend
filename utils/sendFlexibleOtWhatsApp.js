import EmployeeBasic from '../models/EmployeeBasic.js';
import { isWhatsAppEnabled } from '../config/whatsapp.js';
import { resolveEmployeeWhatsAppPhone } from './sendToolsAssetWhatsAppReport.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function safeName(value) {
    return String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}

/** Dates stay as calendar days. A Date object would shift them across time zones. */
export function formatAttendanceNoticeDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
    if (!match) return '';
    const year = Number(match[1]);
    const month = MONTHS[Number(match[2]) - 1];
    const day = Number(match[3]);
    if (!month || year < 2000 || day < 1 || day > 31) return '';
    return `${day} ${month} ${year}`;
}

function hoursLabel(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours <= 0) return '';
    const rounded = Math.round(hours * 100) / 100;
    const shown = Number.isInteger(rounded) ? String(rounded) : String(rounded);
    return shown === '1' ? '1 hour' : `${shown} hours`;
}

function greeting(firstName) {
    const name = safeName(firstName);
    return name ? `Hello ${name},` : 'Hello,';
}

/**
 * Short notice only. No phone, employee code, salary, or request reason.
 */
export function buildFlexibleOtWhatsAppText({
    firstName = '',
    sourceDate = '',
    nextDayPresent = false,
    nextDayDate = '',
    approvedHours = 0,
    remainderHours = 0,
} = {}) {
    const hello = greeting(firstName);
    const workedOn = formatAttendanceNoticeDate(sourceDate);
    if (nextDayPresent) {
        const presentOn = formatAttendanceNoticeDate(nextDayDate);
        const fromOvertime = workedOn ? ` from your overtime on ${workedOn}` : '';
        const presentLine = presentOn
            ? `${hello} HR set ${presentOn} as Present${fromOvertime}.`
            : `${hello} HR set an authorized leave day as Present${fromOvertime}.`;
        const left = hoursLabel(remainderHours);
        return left ? `${presentLine} Remaining overtime on that day: ${left}.` : presentLine;
    }
    const when = workedOn ? ` for ${workedOn}` : '';
    const hours = hoursLabel(approvedHours);
    const hoursLine = hours ? `: ${hours}` : '';
    return `${hello} HR set your overtime${when}${hoursLine}.`;
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
    remainderHours = 0,
    actor = null,
} = {}) {
    try {
        if (!isWhatsAppEnabled()) return { sent: false, reason: 'disabled' };

        const employee = await resolveNoticeEmployee(record);
        const employeeId = String(employee?.employeeId || record?.employeeId || '').trim();
        if (!employeeId) return { sent: false, reason: 'no_employee' };

        const phone = await resolveEmployeeWhatsAppPhone(employeeId);
        if (!phone) return { sent: false, reason: 'no_whatsapp' };

        const text = buildFlexibleOtWhatsAppText({
            firstName: employee?.firstName,
            sourceDate: record?.date,
            nextDayPresent: nextDayPresent === true,
            nextDayDate: record?.flexibleOtNextDayDate,
            approvedHours,
            remainderHours,
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
