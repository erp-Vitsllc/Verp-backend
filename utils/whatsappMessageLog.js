import WhatsAppMessage from '../models/WhatsAppMessage.js';
import EmployeeContact from '../models/EmployeeContact.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { normalizeWhatsAppPhone } from './normalizeWhatsAppPhone.js';

function actorName(actor) {
    if (!actor || typeof actor !== 'object') return '';
    return (
        String(actor.name || '').trim() ||
        [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim() ||
        String(actor.username || '').trim()
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
        const doc = await WhatsAppMessage.create({
            waMessageId: String(result?.messageId || '').trim(),
            conversationPhone,
            direction: 'out',
            source: source || 'manual',
            status: success ? 'sent' : 'failed',
            messageType,
            body: String(body || '').trim(),
            templateName: String(templateName || '').trim(),
            fromPhone: '',
            toPhone: conversationPhone,
            contactName: String(contactName || contact.contactName || '').trim(),
            employeeId: String(employeeId || contact.employeeId || '').trim(),
            sentByUserId: actorId(actor),
            sentByName: actorName(actor) || (isAutoWhatsAppSource(source) ? 'Auto send' : ''),
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
        return WhatsAppMessage.create({
            waMessageId: id,
            conversationPhone,
            direction: 'in',
            source: 'webhook',
            status: 'received',
            messageType: String(messageType || 'text').trim() || 'text',
            body: String(body || '').trim(),
            fromPhone: conversationPhone,
            toPhone: '',
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

        const phone = normalizeWhatsAppPhone(recipientPhone);
        if (!phone) return null;
        return WhatsAppMessage.create({
            waMessageId: id,
            conversationPhone: phone,
            direction: 'out',
            source: 'webhook',
            status: mapped,
            body: '',
            toPhone: phone,
            occurredAt: when,
        });
    } catch (error) {
        console.warn('[WhatsApp] status log failed:', error?.message || error);
        return null;
    }
}

export function inboundMessageBody(message) {
    if (!message || typeof message !== 'object') return '';
    const type = String(message.type || 'text');
    if (type === 'text') return String(message.text?.body || '').trim();
    if (type === 'button') return String(message.button?.text || message.button?.payload || '').trim();
    if (type === 'interactive') {
        return String(
            message.interactive?.button_reply?.title ||
                message.interactive?.list_reply?.title ||
                '',
        ).trim();
    }
    if (message[type]?.caption) return String(message[type].caption).trim();
    return type ? `[${type}]` : '';
}

export function templateMessagePreview(templateName, components = []) {
    const name = String(templateName || '').trim() || 'template';
    const params = [];
    for (const component of Array.isArray(components) ? components : []) {
        for (const param of Array.isArray(component?.parameters) ? component.parameters : []) {
            if (param?.text) params.push(String(param.text).trim());
        }
    }
    return params.length ? `Template ${name}: ${params.join(' · ')}` : `Template: ${name}`;
}
