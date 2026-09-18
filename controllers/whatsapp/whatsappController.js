import { checkWhatsAppConfiguration, checkWhatsAppAccount, sendTextMessage, sendTemplateMessage, sendWhatsAppValidationTemplate, waitForWhatsAppDelivery, getWhatsAppWabaSubscribeResult, resolveWhatsAppAccountProbe } from '../../services/whatsappService.js';
import { getWhatsAppConfig, isWhatsAppEnabled } from '../../config/whatsapp.js';
import { isValidWhatsAppPhone, normalizeWhatsAppPhone, whatsAppPhoneKeys } from '../../utils/normalizeWhatsAppPhone.js';
import { isAutoWhatsAppSource } from '../../utils/whatsappMessageLog.js';
import { getWhatsAppWebhookHealth, rememberWhatsAppWebhook } from '../../utils/whatsappWebhookHealth.js';
import WhatsAppMessage from '../../models/WhatsAppMessage.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeContact from '../../models/EmployeeContact.js';
import { canAccessWhatsAppInbox } from '../../utils/settingsInboxAccess.js';
import mongoose from 'mongoose';

function hubQuery(req, key) {
    const dotted = req.query?.[`hub.${key}`];
    if (dotted != null && String(dotted) !== '') return String(dotted);
    const nested = req.query?.hub?.[key];
    if (nested != null && String(nested) !== '') return String(nested);
    return '';
}

function summarizeWebhook(body) {
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    const changes = [];
    for (const entry of entries) {
        const list = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of list) {
            const value = change?.value && typeof change.value === 'object' ? change.value : {};
            const messages = Array.isArray(value.messages) ? value.messages : [];
            const statuses = Array.isArray(value.statuses) ? value.statuses : [];
            changes.push({
                field: change?.field || '',
                messageCount: messages.length,
                messageTypes: messages.map((item) => item?.type || 'unknown'),
                statusCount: statuses.length,
                statusValues: statuses.map((item) => item?.status || 'unknown'),
            });
        }
    }
    return {
        object: body?.object || '',
        entryCount: entries.length,
        changes,
    };
}

export async function getWhatsAppStatus(req, res) {
    try {
        const check = checkWhatsAppConfiguration();
        const webhook = getWhatsAppWebhookHealth();
        const subscription = getWhatsAppWabaSubscribeResult();
        const inboundStored = await WhatsAppMessage.countDocuments({ direction: 'in' });
        const lastInbound = await WhatsAppMessage.findOne({ direction: 'in' })
            .sort({ occurredAt: -1 })
            .select('occurredAt')
            .lean();
        return res.status(200).json({
            enabled: check.enabled,
            configured: check.configured,
            phoneNumberIdConfigured: check.phoneNumberIdConfigured,
            wabaConfigured: check.wabaConfigured,
            apiVersion: check.apiVersion || '',
            inboundStored,
            lastInboundAt: lastInbound?.occurredAt || null,
            lastWebhookAt: webhook.at,
            lastWebhookInbound: webhook.inbound,
            lastWebhookStatuses: webhook.statuses,
            wabaSubscribed: Boolean(subscription.subscribed),
            wabaSubscribeError: subscription.error || '',
            webhookPath: '/api/whatsapp/webhook',
            webhookUrlConfigured: Boolean(String(process.env.WHATSAPP_WEBHOOK_URL || '').trim()),
        });
    } catch (error) {
        console.error('[WhatsApp] status failed:', error?.message || error);
        return res.status(200).json({
            enabled: false,
            configured: false,
            phoneNumberIdConfigured: false,
            wabaConfigured: false,
            apiVersion: '',
            inboundStored: 0,
            lastInboundAt: null,
            lastWebhookAt: null,
            lastWebhookInbound: 0,
            lastWebhookStatuses: 0,
            wabaSubscribed: false,
            wabaSubscribeError: '',
            webhookPath: '/api/whatsapp/webhook',
            webhookUrlConfigured: false,
        });
    }
}

export async function postWhatsAppTest(req, res) {
    try {
        const phone = req.body?.phone ?? req.body?.to ?? '';
        const message = req.body?.message ?? req.body?.text ?? '';

        if (!String(phone).trim()) {
            return res.status(400).json({
                success: false,
                error: 'phone is required',
                metaError: null,
            });
        }
        if (!String(message).trim()) {
            return res.status(400).json({
                success: false,
                error: 'message is required',
                metaError: null,
            });
        }

        const result = await sendTextMessage(phone, message, {
            source: 'manual',
            actor: req.user,
        });
        return res.status(result.success ? 200 : 400).json(result);
    } catch (error) {
        console.error('[WhatsApp] test send failed:', error?.message || error);
        return res.status(500).json({
            success: false,
            error: error?.message || 'WhatsApp test failed',
            metaError: null,
        });
    }
}

const EMPLOYEE_TEST_MESSAGE = 'helo from test verp';

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postWhatsAppTestEmployees(req, res) {
    try {
        const message = String(req.body?.message || EMPLOYEE_TEST_MESSAGE).trim() || EMPLOYEE_TEST_MESSAGE;

        const contacts = await EmployeeContact.find({
            whatsappNumber: { $exists: true, $nin: [null, ''] },
        })
            .select('employeeId whatsappNumber')
            .lean();

        const employeeIds = [...new Set(contacts.map((row) => String(row.employeeId || '').trim()).filter(Boolean))];
        const employees = await EmployeeBasic.find({
            employeeId: { $in: employeeIds },
            status: { $ne: 'Left User' },
        })
            .select('employeeId firstName lastName status')
            .lean();

        const byCode = new Map(employees.map((emp) => [String(emp.employeeId), emp]));
        const seenPhones = new Set();
        const queue = [];

        for (const contact of contacts) {
            const emp = byCode.get(String(contact.employeeId || '').trim());
            if (!emp) continue;
            const phone = normalizeWhatsAppPhone(contact.whatsappNumber);
            if (!isValidWhatsAppPhone(phone) || seenPhones.has(phone)) continue;
            seenPhones.add(phone);
            queue.push({
                employeeId: emp.employeeId,
                name: [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim(),
                phone,
            });
        }

        const sent = [];
        const failed = [];
        const skipped = contacts.length - queue.length;

        for (const item of queue) {
            const result = await sendTextMessage(item.phone, message, {
                source: 'broadcast',
                actor: req.user,
                employeeId: item.employeeId,
                contactName: item.name,
            });
            if (result.success) {
                sent.push({
                    employeeId: item.employeeId,
                    name: item.name,
                    phone: item.phone,
                    messageId: result.messageId || '',
                });
            } else {
                failed.push({
                    employeeId: item.employeeId,
                    name: item.name,
                    phone: item.phone,
                    error: result.error || 'Send failed',
                });
            }
            await wait(150);
        }

        return res.status(200).json({
            success: failed.length === 0 && sent.length > 0,
            message,
            totalContacts: contacts.length,
            attempted: queue.length,
            skipped,
            sentCount: sent.length,
            failedCount: failed.length,
            sent,
            failed,
        });
    } catch (error) {
        console.error('[WhatsApp] employee broadcast failed:', error?.message || error);
        return res.status(200).json({
            success: false,
            error: error?.message || 'Failed to send employee WhatsApp messages',
            sentCount: 0,
            failedCount: 0,
            sent: [],
            failed: [],
        });
    }
}

const NO_WP_ERROR = 'This user have no WP';
const NO_WP_ACCOUNT_ERROR = 'This WhatsApp number does not have a WhatsApp account';

function isNotOnWhatsAppSendError(result) {
    const code = Number(result?.metaError?.code);
    const text = String(result?.error || '').toLowerCase();
    return (
        code === 131026
        || text.includes('not a whatsapp user')
        || text.includes('undeliverable')
        || text.includes('recipient phone number not in allowed list')
    );
}

function publicSendError(result) {
    if (isNotOnWhatsAppSendError(result)) return NO_WP_ACCOUNT_ERROR;
    const code = Number(result?.metaError?.code);
    const text = String(result?.error || '');
    if (code === 131030 || /not in allowed list/i.test(text)) {
        return 'This Meta test number can only send to recipient numbers added in WhatsApp Manager (API Setup).';
    }
    if (code === 131047) {
        return 'This number is on WhatsApp, but free-text can only be sent inside the 24-hour window.';
    }
    if (code === 100 || /unsupported post request|graphmethodexception|does not exist/i.test(text)) {
        return 'WhatsApp send failed. The token cannot use this phone number ID. Check WhatsApp Manager IDs.';
    }
    return result?.error || 'WhatsApp send failed';
}

export async function postWhatsAppCheckNumber(req, res) {
    try {
        const phone = normalizeWhatsAppPhone(req.body?.phone || req.body?.whatsappNumber || '');
        if (!phone) {
            return res.status(400).json({
                success: false,
                onWhatsApp: false,
                error: 'Please enter a WhatsApp number',
                field: 'whatsappNumber',
            });
        }
        if (!isValidWhatsAppPhone(phone)) {
            return res.status(400).json({
                success: false,
                onWhatsApp: false,
                error: 'Please enter a valid WhatsApp number',
                field: 'whatsappNumber',
            });
        }

        if (!isWhatsAppEnabled()) {
            return res.status(400).json({
                success: false,
                onWhatsApp: false,
                error: 'WhatsApp validation is unavailable',
                field: 'whatsappNumber',
            });
        }

        const firstName = String(req.body?.firstName || req.body?.name || 'there')
            .replace(/[\r\n\t]+/g, ' ')
            .trim()
            .slice(0, 200) || 'there';

        const result = await sendWhatsAppValidationTemplate(phone, {
            firstName,
            actor: req.user,
            employeeId: String(req.body?.employeeId || '').trim(),
            contactName: firstName,
        });
        if (!result.success) {
            return res.status(400).json({
                success: false,
                onWhatsApp: false,
                error: isNotOnWhatsAppSendError(result)
                    ? 'Not a valid WhatsApp number'
                    : publicSendError(result),
                field: 'whatsappNumber',
            });
        }

        const delivery = await waitForWhatsAppDelivery(result.messageId, { timeoutMs: 18000 });
        const status = String(delivery?.status || '').toLowerCase();
        if (status === 'delivered' || status === 'read') {
            return res.status(200).json({
                success: true,
                onWhatsApp: true,
                delivered: true,
                messageId: result.messageId || '',
            });
        }

        return res.status(400).json({
            success: false,
            onWhatsApp: false,
            error: 'Not a valid WhatsApp number',
            field: 'whatsappNumber',
        });
    } catch (error) {
        console.error('[WhatsApp] number check failed:', error?.message || error);
        return res.status(400).json({
            success: false,
            onWhatsApp: false,
            error: 'Not a valid WhatsApp number',
            field: 'whatsappNumber',
        });
    }
}

export async function postWhatsAppToEmployee(req, res) {
    try {
        const id = String(req.params?.id || '').trim();
        if (!id) {
            return res.status(400).json({ success: false, error: 'Employee is required.' });
        }

        const query = mongoose.Types.ObjectId.isValid(id)
            ? { $or: [{ _id: id }, { employeeId: id }] }
            : { employeeId: id };

        const employee = await EmployeeBasic.findOne(query)
            .select('employeeId firstName lastName')
            .lean();
        if (!employee) {
            return res.status(404).json({ success: false, error: 'Employee not found.' });
        }

        const contact = await EmployeeContact.findOne({ employeeId: employee.employeeId })
            .select('whatsappNumber')
            .lean();
        const phone = normalizeWhatsAppPhone(contact?.whatsappNumber || '');
        if (!isValidWhatsAppPhone(phone)) {
            return res.status(400).json({
                success: false,
                error: NO_WP_ERROR,
            });
        }

        const account = await checkWhatsAppAccount(phone);
        if (account.onWhatsApp === false && !account.checkUnavailable) {
            return res.status(400).json({
                success: false,
                error: NO_WP_ACCOUNT_ERROR,
            });
        }

        const employeeName = [employee.firstName, employee.lastName]
            .filter(Boolean)
            .join(' ')
            .replace(/[\r\n\t]+/g, ' ')
            .trim()
            .slice(0, 200) || 'Employee';
        const firstName = String(employee.firstName || '')
            .replace(/[\r\n\t]+/g, ' ')
            .trim()
            .slice(0, 200) || employeeName;

        const templateComponents = [
            {
                type: 'body',
                parameters: [
                    { type: 'text', text: firstName },
                    { type: 'text', text: 'SR-1025' },
                ],
            },
        ];

        const result = await sendTemplateMessage(
            phone,
            'vega_digital_it_solution',
            'en',
            templateComponents,
            {
                source: 'auto',
                actor: req.user,
                employeeId: employee.employeeId,
                contactName: employeeName,
            },
        );
        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: publicSendError(result),
            });
        }

        console.log('[WhatsApp] employee template accepted', {
            employeeId: employee.employeeId,
            template: 'vega_digital_it_solution',
            messageId: result.messageId || '',
        });

        return res.status(200).json({
            success: true,
            messageId: result.messageId || '',
            employeeId: employee.employeeId,
            name: employeeName,
            template: 'vega_digital_it_solution',
        });
    } catch (error) {
        console.error('[WhatsApp] employee send failed:', error?.message || error);
        return res.status(200).json({
            success: false,
            error: error?.message || 'Failed to send WhatsApp message',
            metaError: null,
        });
    }
}

export function getWhatsAppWebhook(req, res) {
    try {
        const mode = hubQuery(req, 'mode');
        const token = hubQuery(req, 'verify_token');
        const challenge = hubQuery(req, 'challenge');
        const expected = getWhatsAppConfig().verifyToken;

        if (mode === 'subscribe' && expected && token && token === expected) {
            return res.status(200).type('text/plain').send(challenge);
        }

        return res.status(403).json({ message: 'WhatsApp webhook verification failed' });
    } catch (error) {
        console.error('[WhatsApp] webhook verify failed:', error?.message || error);
        return res.status(403).json({ message: 'WhatsApp webhook verification failed' });
    }
}

export async function postWhatsAppWebhook(req, res) {
    try {
        let body = req.body;
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch {
                body = {};
            }
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            body = {};
        }
        const summary = summarizeWebhook(body);
        const inbound = summary.changes.reduce((total, row) => total + (Number(row.messageCount) || 0), 0);
        const statuses = summary.changes.reduce((total, row) => total + (Number(row.statusCount) || 0), 0);
        rememberWhatsAppWebhook({ inbound, statuses, object: summary.object });
        console.log('[WhatsApp] webhook event', summary);

        const {
            logInboundWhatsAppMessage,
            applyWhatsAppDeliveryStatus,
            inboundMessageBody,
        } = await import('../../utils/whatsappMessageLog.js');

        const entries = Array.isArray(body?.entry) ? body.entry : [];
        for (const entry of entries) {
            const changes = Array.isArray(entry?.changes) ? entry.changes : [];
            for (const change of changes) {
                const value = change?.value && typeof change.value === 'object' ? change.value : {};
                const businessPhone = String(value?.metadata?.display_phone_number || '').trim();
                const contacts = Array.isArray(value.contacts) ? value.contacts : [];
                const nameByWaId = new Map(
                    contacts.map((row) => [
                        normalizeWhatsAppPhone(row?.wa_id || ''),
                        String(row?.profile?.name || '').trim(),
                    ]),
                );

                const inboundRows = [
                    ...(Array.isArray(value.messages) ? value.messages : []),
                    ...(Array.isArray(value.message) ? [value.message] : []),
                ];
                for (const message of inboundRows) {
                    const from = String(message?.from || message?.wa_id || contacts[0]?.wa_id || '').trim();
                    const ts = Number(message?.timestamp);
                    const text = inboundMessageBody(message);
                    if (!from && !text) continue;
                    await logInboundWhatsAppMessage({
                        phone: from,
                        waMessageId: String(message?.id || '').trim(),
                        body: text,
                        messageType: String(message?.type || 'text'),
                        contactName: nameByWaId.get(normalizeWhatsAppPhone(from)) || contacts[0]?.profile?.name || '',
                        occurredAt: Number.isFinite(ts) ? new Date(ts * 1000) : new Date(),
                        toPhone: businessPhone,
                    });
                }

                for (const statusRow of Array.isArray(value.statuses) ? value.statuses : []) {
                    const ts = Number(statusRow?.timestamp);
                    const statusErrors = Array.isArray(statusRow?.errors) ? statusRow.errors : [];
                    const firstError = statusErrors[0] && typeof statusErrors[0] === 'object' ? statusErrors[0] : {};
                    resolveWhatsAppAccountProbe(String(statusRow?.id || '').trim(), {
                        status: String(statusRow?.status || '').trim(),
                        errorCode: firstError.code,
                        errorMessage: firstError.title || firstError.message || firstError.error_data?.details || '',
                    });
                    await applyWhatsAppDeliveryStatus({
                        waMessageId: String(statusRow?.id || '').trim(),
                        status: String(statusRow?.status || '').trim(),
                        recipientPhone: String(statusRow?.recipient_id || '').trim(),
                        occurredAt: Number.isFinite(ts) ? new Date(ts * 1000) : new Date(),
                    });
                }
            }
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('[WhatsApp] webhook receive failed:', error?.message || error);
        return res.status(200).json({ success: true });
    }
}

function publicMessage(doc) {
    const row = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc || {};
    const source = String(row.source || 'manual');
    const body = String(row.body || '').trim() || (row.templateName ? `Template: ${row.templateName}` : '');
    return {
        id: String(row._id || ''),
        waMessageId: row.waMessageId || '',
        conversationPhone: row.conversationPhone || '',
        direction: row.direction || '',
        source,
        autoSend: isAutoWhatsAppSource(source),
        status: row.status || '',
        messageType: row.messageType || 'text',
        body,
        templateName: row.templateName || '',
        fromPhone: row.fromPhone || '',
        toPhone: row.toPhone || '',
        accountPhone: row.direction === 'out' ? (row.fromPhone || '') : (row.toPhone || ''),
        contactName: row.contactName || '',
        employeeId: row.employeeId || '',
        sentByName: row.sentByName || '',
        sentByUserId: row.sentByUserId || '',
        error: row.error || '',
        occurredAt: row.occurredAt || row.createdAt || null,
    };
}

function conversationPhoneQuery(phone) {
    const keys = whatsAppPhoneKeys(phone);
    if (keys.length <= 1) return { conversationPhone: keys[0] || phone };
    return { conversationPhone: { $in: keys } };
}

function isEmptyStatusStub(row) {
    return (
        String(row?.direction) === 'out' &&
        String(row?.source) === 'webhook' &&
        !String(row?.body || '').trim()
    );
}

function sourceFilter(source) {
    const value = String(source || '').trim().toLowerCase();
    if (value === 'in' || value === 'received') return { direction: 'in' };
    if (value === 'out' || value === 'sent') return { direction: 'out' };
    if (value === 'auto') return { source: { $in: ['auto', 'broadcast', 'template'] } };
    if (['manual', 'broadcast', 'template', 'webhook'].includes(value)) return { source: value };
    return {};
}

export async function getWhatsAppInboxAccess(req, res) {
    try {
        const allowed = await canAccessWhatsAppInbox(req);
        return res.status(200).json({ allowed });
    } catch (error) {
        console.error('[WhatsApp] access check failed:', error?.message || error);
        return res.status(200).json({ allowed: false });
    }
}

export async function listWhatsAppConversations(req, res) {
    try {
        const search = String(req.query?.search || '').trim();
        const filter = sourceFilter(req.query?.filter);
        const match = { ...filter };
        if (search) {
            const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            match.$or = [
                { conversationPhone: { $regex: safe, $options: 'i' } },
                { contactName: { $regex: safe, $options: 'i' } },
                { employeeId: { $regex: safe, $options: 'i' } },
                { body: { $regex: safe, $options: 'i' } },
                { sentByName: { $regex: safe, $options: 'i' } },
            ];
        }

        const rows = await WhatsAppMessage.aggregate([
            { $match: match },
            { $sort: { occurredAt: -1, createdAt: -1 } },
            {
                $group: {
                    _id: '$conversationPhone',
                    lastMessage: { $first: '$$ROOT' },
                    inboundCount: {
                        $sum: { $cond: [{ $eq: ['$direction', 'in'] }, 1, 0] },
                    },
                    outboundCount: {
                        $sum: { $cond: [{ $eq: ['$direction', 'out'] }, 1, 0] },
                    },
                    autoCount: {
                        $sum: {
                            $cond: [
                                { $in: ['$source', ['auto', 'broadcast', 'template']] },
                                1,
                                0,
                            ],
                        },
                    },
                },
            },
            { $sort: { 'lastMessage.occurredAt': -1 } },
            { $limit: 200 },
        ]);

        const conversations = rows.map((row) => {
            const last = publicMessage(row.lastMessage || {});
            return {
                phone: normalizeWhatsAppPhone(row._id) || String(row._id || ''),
                contactName: last.contactName || '',
                employeeId: last.employeeId || '',
                lastMessage: last,
                inboundCount: row.inboundCount || 0,
                outboundCount: row.outboundCount || 0,
                autoCount: row.autoCount || 0,
            };
        });

        const merged = [];
        const byTail = new Map();
        for (const row of conversations) {
            if (isEmptyStatusStub(row.lastMessage)) {
                row.lastMessage = { ...row.lastMessage, body: row.lastMessage?.templateName || '' };
            }
            const tail = String(row.phone || '').slice(-9) || row.phone;
            const existing = byTail.get(tail);
            if (!existing) {
                byTail.set(tail, row);
                merged.push(row);
                continue;
            }
            existing.inboundCount += row.inboundCount;
            existing.outboundCount += row.outboundCount;
            existing.autoCount += row.autoCount;
            if (!existing.contactName && row.contactName) existing.contactName = row.contactName;
            if (!existing.employeeId && row.employeeId) existing.employeeId = row.employeeId;
            const existingAt = new Date(existing.lastMessage?.occurredAt || 0).getTime();
            const nextAt = new Date(row.lastMessage?.occurredAt || 0).getTime();
            if (nextAt > existingAt) existing.lastMessage = row.lastMessage;
        }

        return res.status(200).json({ conversations: merged });
    } catch (error) {
        console.error('[WhatsApp] conversations failed:', error?.message || error);
        return res.status(500).json({ message: error?.message || 'Failed to load WhatsApp conversations' });
    }
}

export async function listWhatsAppThread(req, res) {
    try {
        const phone = normalizeWhatsAppPhone(req.query?.phone || req.params?.phone || '');
        if (!isValidWhatsAppPhone(phone)) {
            return res.status(400).json({ message: 'A valid WhatsApp number is required.' });
        }
        const filter = {
            ...conversationPhoneQuery(phone),
            ...sourceFilter(req.query?.filter),
        };
        const messages = (await WhatsAppMessage.find(filter)
            .sort({ occurredAt: 1, createdAt: 1 })
            .limit(500)
            .lean())
            .filter((row) => !isEmptyStatusStub(row));
        const last = messages[messages.length - 1] || null;
        return res.status(200).json({
            phone,
            contactName: last?.contactName || '',
            employeeId: last?.employeeId || '',
            messages: messages.map(publicMessage),
        });
    } catch (error) {
        console.error('[WhatsApp] thread failed:', error?.message || error);
        return res.status(500).json({ message: error?.message || 'Failed to load WhatsApp messages' });
    }
}

export async function postWhatsAppThreadReply(req, res) {
    try {
        const phone = normalizeWhatsAppPhone(req.body?.phone || req.query?.phone || req.params?.phone || '');
        const message = String(req.body?.message || req.body?.text || '').trim();
        if (!isValidWhatsAppPhone(phone)) {
            return res.status(400).json({ success: false, error: 'A valid WhatsApp number is required.' });
        }
        if (!message) {
            return res.status(400).json({ success: false, error: 'message is required' });
        }

        const last = await WhatsAppMessage.findOne(conversationPhoneQuery(phone))
            .sort({ occurredAt: -1 })
            .select('contactName employeeId')
            .lean();
        const result = await sendTextMessage(phone, message, {
            source: 'manual',
            actor: req.user,
            employeeId: last?.employeeId || '',
            contactName: last?.contactName || '',
        });
        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error || 'WhatsApp send failed',
            });
        }
        return res.status(200).json({ success: true, messageId: result.messageId || '' });
    } catch (error) {
        console.error('[WhatsApp] thread reply failed:', error?.message || error);
        return res.status(500).json({
            success: false,
            error: error?.message || 'Failed to send WhatsApp message',
        });
    }
}
