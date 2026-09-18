import WhatsAppMessage from '../models/WhatsAppMessage.js';
import EmployeeContact from '../models/EmployeeContact.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { normalizeWhatsAppPhone } from './normalizeWhatsAppPhone.js';
import { getWhatsAppBusinessIdentity } from '../config/whatsapp.js';

function actorName(actor) {
    if (!actor || typeof actor !== 'object') return '';
    return (
        String(actor.name || '').trim() ||
        [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim() ||
        String(actor.username || '').trim() ||
        (actor.isSystemSuperUser ? 'Super User' : '')
    );
}

function actorId(actor) {
    if (!actor || typeof actor !== 'object') return '';
    return String(actor.id || actor._id || '').trim();
}

export function isAutoWhatsAppSource(source) {
    const value = String(source || '').trim().toLowerCase();
    return value === 'auto' || value === 'broadcast' || value === 'template';
}

export async function resolveWhatsAppContact(phone) {
    const conversationPhone = normalizeWhatsAppPhone(phone);
    if (!conversationPhone) return { conversationPhone: '', employeeId: '', contactName: '' };

    const contacts = await EmployeeContact.find({
        whatsappNumber: { $exists: true, $nin: [null, ''] },
    })
        .select('employeeId whatsappNumber')
        .lean();
    const match = contacts.find(
        (row) => normalizeWhatsAppPhone(row.whatsappNumber) === conversationPhone,
    );
    if (!match?.employeeId) {
        return { conversationPhone, employeeId: '', contactName: '' };
    }

    const employee = await EmployeeBasic.findOne({ employeeId: match.employeeId })
        .select('employeeId firstName lastName')
        .lean();
    const contactName = employee
        ? [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim()
        : '';
    return {
        conversationPhone,
        employeeId: String(match.employeeId),
        contactName,
    };
}

export async function logOutboundWhatsAppMessage({
    phone,
    body = '',
    messageType = 'text',
    source = 'manual',
    templateName = '',
    result = null,
    actor = null,
    employeeId = '',
    contactName = '',
} = {}) {
    try {
        const conversationPhone = normalizeWhatsAppPhone(phone);
        if (!conversationPhone) return null;

        const contact = await resolveWhatsAppContact(conversationPhone);
        const success = result?.success === true;
        const account = await getWhatsAppBusinessIdentity();
        const sender = actorName(actor) || (isAutoWhatsAppSource(source) ? 'Auto send' : 'ERP');
        const doc = await WhatsAppMessage.create({
            waMessageId: String(result?.messageId || '').trim(),
            conversationPhone,
            direction: 'out',
            source: source || 'manual',
            status: success ? 'sent' : 'failed',
            messageType,
            body: String(body || '').trim(),
            templateName: String(templateName || '').trim(),
            fromPhone: account.displayPhone || '',
            toPhone: conversationPhone,
            contactName: String(contactName || contact.contactName || '').trim(),
            employeeId: String(employeeId || contact.employeeId || '').trim(),
            sentByUserId: actorId(actor),
            sentByName: sender,
            error: success ? '' : String(result?.error || 'Send failed'),
            occurredAt: new Date(),
        });
        return doc;
    } catch (error) {
        console.warn('[WhatsApp] outbound log failed:', error?.message || error);
        return null;
    }
}

export async function logInboundWhatsAppMessage({
    phone,
    waMessageId = '',
    body = '',
    messageType = 'text',
    contactName = '',
    occurredAt = null,
    toPhone = '',
} = {}) {
    try {
        const conversationPhone = normalizeWhatsAppPhone(phone);
        if (!conversationPhone) return null;

        const id = String(waMessageId || '').trim();
        if (id) {
            const existing = await WhatsAppMessage.findOne({
                waMessageId: id,
                direction: 'in',
            }).lean();
            if (existing) return existing;
        }

        const contact = await resolveWhatsAppContact(conversationPhone);
        const account = await getWhatsAppBusinessIdentity();
        const inboundBody = String(body || '').trim();
        if (!inboundBody && !id) return null;
        return WhatsAppMessage.create({
            waMessageId: id,
            conversationPhone,
            direction: 'in',
            source: 'webhook',
            status: 'received',
            messageType: String(messageType || 'text').trim() || 'text',
            body: inboundBody || `[${String(messageType || 'message')}]`,
            fromPhone: conversationPhone,
            toPhone: normalizeWhatsAppPhone(toPhone) || account.displayPhone || '',
            contactName: String(contactName || contact.contactName || '').trim(),
            employeeId: contact.employeeId || '',
            occurredAt: occurredAt instanceof Date && !Number.isNaN(occurredAt.getTime())
                ? occurredAt
                : new Date(),
        });
    } catch (error) {
        console.warn('[WhatsApp] inbound log failed:', error?.message || error);
        return null;
    }
}

export async function applyWhatsAppDeliveryStatus({
    waMessageId = '',
    status = '',
    recipientPhone = '',
    occurredAt = null,
} = {}) {
    try {
        const id = String(waMessageId || '').trim();
        const mapped = String(status || '').trim().toLowerCase();
        if (!id || !['sent', 'delivered', 'read', 'failed'].includes(mapped)) return null;

        const when =
            occurredAt instanceof Date && !Number.isNaN(occurredAt.getTime())
                ? occurredAt
                : new Date();
        const update = { status: mapped };
        if (mapped === 'failed') update.error = update.error || 'Delivery failed';

        const doc = await WhatsAppMessage.findOneAndUpdate(
            { waMessageId: id },
            { $set: update },
            { new: true },
        );
        if (doc) return doc;

        // Do not create empty outbound rows for delivery receipts — they hide real content.
        void recipientPhone;
        void when;
        return null;
    } catch (error) {
        console.warn('[WhatsApp] status log failed:', error?.message || error);
        return null;
    }
}

export function inboundMessageBody(message) {
    if (!message || typeof message !== 'object') return '';
    const type = String(message.type || 'text').trim() || 'text';
    if (typeof message.body === 'string' && message.body.trim()) return message.body.trim();
    if (typeof message.text === 'string' && message.text.trim()) return message.text.trim();
    if (type === 'text') return String(message.text?.body || '').trim();
    if (type === 'button') return String(message.button?.text || message.button?.payload || '').trim();
    if (type === 'interactive') {
        return String(
            message.interactive?.button_reply?.title ||
                message.interactive?.list_reply?.title ||
                '',
        ).trim();
    }
    if (type === 'image' || type === 'video' || type === 'document' || type === 'audio') {
        const caption = String(message[type]?.caption || '').trim();
        const filename = String(message.document?.filename || '').trim();
        if (caption && filename) return `${caption}\n${filename}`;
        if (caption) return caption;
        if (filename) return filename;
        return `[${type}]`;
    }
    if (type === 'sticker') return '[sticker]';
    if (type === 'location') {
        const name = String(message.location?.name || '').trim();
        const address = String(message.location?.address || '').trim();
        return [name, address].filter(Boolean).join(' · ') || '[location]';
    }
    if (type === 'contacts') {
        const names = (Array.isArray(message.contacts) ? message.contacts : [])
            .map((row) => String(row?.name?.formatted_name || '').trim())
            .filter(Boolean);
        return names.length ? names.join(', ') : '[contact]';
    }
    if (type === 'reaction') {
        return String(message.reaction?.emoji || '[reaction]').trim();
    }
    if (type === 'system') return String(message.system?.body || '[system]').trim();
    if (message[type]?.caption) return String(message[type].caption).trim();
    return type ? `[${type}]` : '';
}

export function templateParameterTexts(components = []) {
    const params = [];
    for (const component of Array.isArray(components) ? components : []) {
        for (const param of Array.isArray(component?.parameters) ? component.parameters : []) {
            if (param?.text) params.push(String(param.text).trim());
        }
    }
    return params;
}

export function fillTemplateText(templateText, components = []) {
    let text = String(templateText || '');
    const params = templateParameterTexts(components);
    params.forEach((value, index) => {
        text = text.split(`{{${index + 1}}}`).join(value);
    });
    return text.trim();
}

export function templateMessagePreview(templateName, components = [], templateText = '') {
    const name = String(templateName || '').trim() || 'template';
    const filled = fillTemplateText(templateText, components);
    if (filled) return filled;
    const params = templateParameterTexts(components);
    if (!params.length) return `Template: ${name}`;
    return [`Template: ${name}`, ...params].join('\n');
}
