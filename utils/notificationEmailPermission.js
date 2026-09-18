import nodemailer from 'nodemailer';
import NotificationEmailPermission from '../models/NotificationEmailPermission.js';
import EmployeeContact from '../models/EmployeeContact.js';
import {
    flattenNotificationEmailCatalog,
    eventKeyForDashboardType,
    eventKeyForEmailType,
} from '../constants/notificationEmailCatalog.js';
import { sendErpEmail, buildEmailDedupeKey } from './emailDispatch.js';
import { isValidWhatsAppPhone, normalizeWhatsAppPhone } from './normalizeWhatsAppPhone.js';

const DEFAULT_CHANNELS = { notification: true, email: true, whatsapp: true };

let cache = { at: 0, map: null };
const CACHE_MS = 15 * 1000;

function createMailTransporter() {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
}

export async function loadNotificationEmailPermissionMap() {
    const now = Date.now();
    if (cache.map && now - cache.at < CACHE_MS) return cache.map;

    const rows = await NotificationEmailPermission.find({}).lean();
    const map = {};
    for (const item of flattenNotificationEmailCatalog()) {
        map[item.key] = { ...DEFAULT_CHANNELS };
    }
    for (const row of rows) {
        const key = String(row.eventKey || '').trim();
        if (!key) continue;
        map[key] = {
            notification: true,
            email: true,
            whatsapp: row.whatsapp !== false,
        };
    }
    cache = { at: now, map };
    return map;
}

export function clearNotificationEmailPermissionCache() {
    cache = { at: 0, map: null };
}

export async function getEventChannels(eventKey) {
    const key = String(eventKey || '').trim();
    if (!key) return { ...DEFAULT_CHANNELS };
    const map = await loadNotificationEmailPermissionMap();
    return map[key] ? { ...map[key] } : { ...DEFAULT_CHANNELS };
}

export async function isNotificationEnabledForType() {
    return true;
}

export async function isEmailEnabledForEvent() {
    return true;
}

export function employeeCompanyEmail(employee) {
    return String(employee?.companyEmail || '').trim();
}

/**
 * One paid channel per employee:
 * company email → email only (never WhatsApp)
 * no company email → WhatsApp only (if WhatsApp is on)
 */
export async function resolveEmployeePaidChannel(employee, eventKey) {
    const channels = await getEventChannels(eventKey);
    const companyEmail = employeeCompanyEmail(employee);
    if (companyEmail) {
        if (!channels.email) return { channel: 'none', companyEmail, phone: '' };
        return { channel: 'email', companyEmail, phone: '' };
    }
    if (!channels.whatsapp) return { channel: 'none', companyEmail: '', phone: '' };
    const contact = await EmployeeContact.findOne({
        employeeId: String(employee?.employeeId || '').trim(),
    })
        .select('whatsappNumber')
        .lean();
    const phone = normalizeWhatsAppPhone(contact?.whatsappNumber || '');
    if (!isValidWhatsAppPhone(phone)) {
        return { channel: 'none', companyEmail: '', phone: '' };
    }
    return { channel: 'whatsapp', companyEmail: '', phone };
}

export async function deliverEmployeePaidMessage({
    eventKey,
    employee,
    subject = '',
    html = '',
    text = '',
    recordId = '',
    emailType = '',
    actor = null,
} = {}) {
    const key = String(eventKey || '').trim();
    if (!key || !employee) return { sent: false, reason: 'missing' };

    const picked = await resolveEmployeePaidChannel(employee, key);
    if (picked.channel === 'none') return { sent: false, reason: 'channel_off' };

    const dedupeKey = buildEmailDedupeKey([
        key,
        String(employee.employeeId || employee._id || ''),
        String(recordId || ''),
        String(subject || text || '').slice(0, 80),
    ]);

    if (picked.channel === 'email') {
        const transporter = createMailTransporter();
        const emailUser = process.env.EMAIL_USER?.trim();
        const result = await sendErpEmail({
            transporter,
            from: emailUser ? `"VeRP Notifications" <${emailUser}>` : undefined,
            to: [picked.companyEmail],
            subject,
            html: html || `<p>${String(text || subject || '').replace(/</g, '')}</p>`,
            dedupeKey,
            module: key,
            emailType: emailType || key,
            recordId,
            metadata: { eventKey: key, subjectCategory: 'reminder' },
        });
        return result;
    }

    const { sendTextMessage } = await import('../services/whatsappService.js');
    const body = String(text || subject || '').trim();
    if (!body) return { sent: false, reason: 'no_text' };
    const result = await sendTextMessage(picked.phone, body, {
        source: 'auto',
        eventKey: key,
        actor,
        employeeId: employee.employeeId,
        contactName: [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim(),
        skipPaidChannelCheck: true,
    });
    return {
        sent: result?.success === true,
        reason: result?.success ? 'whatsapp' : result?.error || 'whatsapp_failed',
    };
}

export async function buildPermissionCatalogView() {
    const map = await loadNotificationEmailPermissionMap();
    return flattenNotificationEmailCatalog().reduce((groups, item) => {
        let group = groups.find((g) => g.group === item.group);
        if (!group) {
            group = { group: item.group, modules: [] };
            groups.push(group);
        }
        let mod = group.modules.find((m) => m.module === item.module);
        if (!mod) {
            mod = { module: item.module, items: [] };
            group.modules.push(mod);
        }
        const channels = map[item.key] || DEFAULT_CHANNELS;
        mod.items.push({
            key: item.key,
            label: item.label,
            hint: item.hint,
            detail: item.detail,
            notification: true,
            email: true,
            whatsapp: channels.whatsapp !== false,
        });
        return groups;
    }, []);
}

export { eventKeyForDashboardType, eventKeyForEmailType, DEFAULT_CHANNELS };
