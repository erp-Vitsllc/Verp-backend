import { checkWhatsAppConfiguration, checkWhatsAppAccount, sendTextMessage, sendTemplateMessage } from '../../services/whatsappService.js';
import { getWhatsAppConfig } from '../../config/whatsapp.js';
import { isValidWhatsAppPhone, normalizeWhatsAppPhone } from '../../utils/normalizeWhatsAppPhone.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeContact from '../../models/EmployeeContact.js';
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

export function getWhatsAppStatus(req, res) {
    try {
        const check = checkWhatsAppConfiguration();
        return res.status(200).json({
            enabled: check.enabled,
            configured: check.configured,
            phoneNumberIdConfigured: check.phoneNumberIdConfigured,
            wabaConfigured: check.wabaConfigured,
            apiVersion: check.apiVersion || '',
        });
    } catch (error) {
        console.error('[WhatsApp] status failed:', error?.message || error);
        return res.status(200).json({
            enabled: false,
            configured: false,
            phoneNumberIdConfigured: false,
            wabaConfigured: false,
            apiVersion: '',
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

        const result = await sendTextMessage(phone, message);
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
            const result = await sendTextMessage(item.phone, message);
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

export function postWhatsAppWebhook(req, res) {
    try {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
            ? req.body
            : {};
        const summary = summarizeWebhook(body);
        console.log('[WhatsApp] webhook event', summary);
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('[WhatsApp] webhook receive failed:', error?.message || error);
        return res.status(200).json({ success: true });
    }
}
