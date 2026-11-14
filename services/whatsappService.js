import {
    assertWhatsAppSendConfig,
    getWhatsAppConfig,
    getWhatsAppMessagesUrl,
    getWhatsAppPublicStatus,
    isWhatsAppEnabled,
} from '../config/whatsapp.js';
import { isValidWhatsAppPhone, normalizeWhatsAppPhone, whatsAppPhoneKeys } from '../utils/normalizeWhatsAppPhone.js';

const REQUEST_TIMEOUT_MS = 20000;

function redactSecrets(value) {
    if (value == null) return value;
    if (typeof value === 'string') {
        const token = getWhatsAppConfig().accessToken;
        if (token && value.includes(token)) {
            return value.split(token).join('[redacted]');
        }
        return value;
    }
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (typeof value === 'object') {
        const out = {};
        for (const [key, nested] of Object.entries(value)) {
            if (/token|authorization|secret|password/i.test(key)) {
                out[key] = '[redacted]';
                continue;
            }
            out[key] = redactSecrets(nested);
        }
        return out;
    }
    return value;
}

function safeMetaError(payload) {
    const error = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
    return redactSecrets({
        message: error?.message || 'WhatsApp API request failed',
        type: error?.type || '',
        code: error?.code ?? null,
        errorSubcode: error?.error_subcode ?? null,
        fbtraceId: error?.fbtrace_id || '',
    });
}

function fail(error, metaError = null) {
    const message = String(error?.message || error || 'WhatsApp request failed');
    console.error('[WhatsApp]', redactSecrets(message));
    return {
        success: false,
        error: redactSecrets(message),
        metaError: metaError ? redactSecrets(metaError) : null,
    };
}

function ok(data) {
    const messageId = data?.messages?.[0]?.id || '';
    return {
        success: true,
        messageId,
        data: redactSecrets(data),
    };
}

const TEMPLATE_SPEC_TTL_MS = 5 * 60 * 1000;
const templateSpecCache = new Map();

function templateBodyParamCount(text) {
    const numbers = [...String(text || '').matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
    return numbers.length ? Math.max(...numbers) : 0;
}

function parseTemplateSpec(row) {
    const components = Array.isArray(row?.components) ? row.components : [];
    const header = components.find((item) => String(item?.type || '').toUpperCase() === 'HEADER');
    const body = components.find((item) => String(item?.type || '').toUpperCase() === 'BODY');
    const bodyText = String(body?.text || '').trim();
    return {
        name: String(row?.name || '').trim(),
        status: String(row?.status || '').trim(),
        approved: String(row?.status || '').toUpperCase() === 'APPROVED',
        language: String(row?.language || 'en').trim() || 'en',
        headerFormat: String(header?.format || '').toUpperCase(),
        body: bodyText,
        bodyParamCount: templateBodyParamCount(bodyText),
    };
}

function pickTemplateRow(rows, name) {
    const sameName = rows.filter((row) => String(row?.name || '').trim() === name);
    return sameName.find((row) => row.language === 'en' && String(row.status || '').toUpperCase() === 'APPROVED')
        || sameName.find((row) => String(row.status || '').toUpperCase() === 'APPROVED')
        || sameName[0]
        || null;
}

/** Approved template shape. Cached so automated sends do not look the template up on every call. */
export async function loadWhatsAppTemplate(templateName) {
    const name = String(templateName || '').trim();
    if (!name) return null;
    const cached = templateSpecCache.get(name);
    if (cached && Date.now() - cached.at < TEMPLATE_SPEC_TTL_MS) return cached.spec;

    const config = getWhatsAppConfig();
    if (!config.wabaId || !config.accessToken || !config.apiVersion) {
        return null;
    }

    try {
        const url = `${config.apiUrl}/${config.apiVersion}/${config.wabaId}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,language,components`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${config.accessToken}` },
            signal: AbortSignal.timeout(12000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) return null;
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        const spec = parseTemplateSpec(pickTemplateRow(rows, name));
        const stored = spec.name ? spec : { ...spec, name, approved: false };
        templateSpecCache.set(name, { at: Date.now(), spec: stored });
        return stored;
    } catch {
        return null;
    }
}

async function fetchTemplateBodyText(templateName) {
    const spec = await loadWhatsAppTemplate(templateName);
    return String(spec?.body || '').trim();
}

export function bufferLooksLikePdf(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (bytes.length < 5) return false;
    return bytes.subarray(0, Math.min(bytes.length, 1024)).toString('latin1').includes('%PDF-');
}

function resolveDocumentMime(mimeType, filename) {
    const mime = String(mimeType || '').trim().toLowerCase();
    const name = String(filename || '').trim().toLowerCase();
    if ((!mime || mime === 'application/octet-stream') && name.endsWith('.pdf')) {
        return 'application/pdf';
    }
    return mime || 'application/pdf';
}

let lastWabaSubscribe = {
    at: null,
    subscribed: false,
    appCount: 0,
    appNames: [],
    overrideCallback: false,
    error: null,
};

export function getWhatsAppWabaSubscribeResult() {
    return { ...lastWabaSubscribe };
}

/** Attach this WABA to the Meta app so inbound messages are POSTed to the webhook. */
export async function subscribeWhatsAppWaba() {
    const config = getWhatsAppConfig();
    if (!config.enabled || !config.wabaId || !config.accessToken || !config.apiVersion) {
        lastWabaSubscribe = {
            at: new Date().toISOString(),
            subscribed: false,
            appCount: 0,
            appNames: [],
            overrideCallback: false,
            error: 'WhatsApp WABA is not configured',
        };
        return lastWabaSubscribe;
    }

    const url = `${config.apiUrl}/${config.apiVersion}/${config.wabaId}/subscribed_apps`;
    const headers = { Authorization: `Bearer ${config.accessToken}` };
    const webhookUrl = String(process.env.WHATSAPP_WEBHOOK_URL || '').trim();

    try {
        const listed = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const listedJson = await listed.json().catch(() => ({}));
        const apps = Array.isArray(listedJson?.data) ? listedJson.data : [];
        const appNames = apps
            .map((row) =>
                String(row?.whatsapp_business_api_data?.name || row?.whatsapp_business_api_data?.id || '').trim(),
            )
            .filter(Boolean);

        const init = {
            method: 'POST',
            headers: { ...headers },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        };
        if (webhookUrl && config.verifyToken) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify({
                override_callback_uri: webhookUrl,
                verify_token: config.verifyToken,
            });
        }

        const posted = await fetch(url, init);
        const postedJson = await posted.json().catch(() => ({}));
        const postedOk = posted.ok && postedJson?.success !== false && !postedJson?.error;

        let nextApps = apps;
        let nextNames = appNames;
        if (postedOk) {
            const refresh = await fetch(url, {
                headers,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            const refreshJson = await refresh.json().catch(() => ({}));
            nextApps = Array.isArray(refreshJson?.data) ? refreshJson.data : apps;
            nextNames = nextApps
                .map((row) =>
                    String(row?.whatsapp_business_api_data?.name || row?.whatsapp_business_api_data?.id || '').trim(),
                )
                .filter(Boolean);
        }

        const already = nextApps.length > 0;
        const errorMessage = postedOk
            ? listedJson?.error?.message || null
            : postedJson?.error?.message || listedJson?.error?.message || 'WABA subscribe failed';

        lastWabaSubscribe = {
            at: new Date().toISOString(),
            subscribed: postedOk || already,
            appCount: nextApps.length,
            appNames: nextNames,
            overrideCallback: Boolean(webhookUrl && config.verifyToken),
            error: postedOk || already ? null : String(errorMessage || 'WABA subscribe failed'),
        };
        return lastWabaSubscribe;
    } catch (error) {
        lastWabaSubscribe = {
            at: new Date().toISOString(),
            subscribed: false,
            appCount: 0,
            appNames: [],
            overrideCallback: Boolean(webhookUrl),
            error: error?.message || 'WABA subscribe failed',
        };
        return lastWabaSubscribe;
    }
}

export function checkWhatsAppConfiguration() {
    const status = getWhatsAppPublicStatus();
    if (!status.enabled) {
        return {
            ...status,
            ok: false,
            error: 'WhatsApp is disabled. Set WHATSAPP_ENABLED=true after credentials are filled.',
        };
    }
    if (!status.configured) {
        return {
            ...status,
            ok: false,
            error: `WhatsApp is enabled but missing required configuration: ${status.missing.join(', ')}`,
        };
    }
    return {
        ...status,
        ok: true,
        error: null,
    };
}

async function postWhatsAppMessage(body) {
    try {
        const config = assertWhatsAppSendConfig();
        const url = getWhatsAppMessagesUrl(config);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch {
            payload = { error: { message: `WhatsApp API returned HTTP ${response.status}` } };
        }

        if (!response.ok) {
            const metaError = safeMetaError(payload);
            console.error('[WhatsApp] Graph API error', {
                status: response.status,
                code: metaError.code,
                type: metaError.type,
                message: metaError.message,
            });
            return fail(metaError.message, metaError);
        }

        return ok(payload);
    } catch (error) {
        if (error?.code === 'WHATSAPP_DISABLED' || error?.code === 'WHATSAPP_NOT_CONFIGURED') {
            return fail(error);
        }
        return fail(error);
    }
}

export const WHATSAPP_NOT_REGISTERED_ERROR = 'This number is not registered on WhatsApp';

const ACCOUNT_CHECK_TTL_MS = 10 * 60 * 1000;
const accountCheckCache = new Map();
const pendingAccountProbes = new Map();

function accountCheckResult({
    success = true,
    onWhatsApp = null,
    checkUnavailable = false,
    error = null,
    metaError = null,
} = {}) {
    return { success, onWhatsApp, checkUnavailable, error, metaError };
}

function getCachedAccountCheck(phone) {
    const row = accountCheckCache.get(phone);
    if (!row) return null;
    if (Date.now() - row.at > ACCOUNT_CHECK_TTL_MS) {
        accountCheckCache.delete(phone);
        return null;
    }
    return row.value;
}

function setCachedAccountCheck(phone, value) {
    if (value?.onWhatsApp === true || value?.onWhatsApp === false) {
        accountCheckCache.set(phone, { at: Date.now(), value });
    }
}

async function hasDeliveredWhatsAppConversation(phone) {
    try {
        const WhatsAppMessage = (await import('../models/WhatsAppMessage.js')).default;
        const keys = whatsAppPhoneKeys(phone);
        const conversationQuery = keys.length <= 1
            ? { conversationPhone: keys[0] || phone }
            : { conversationPhone: { $in: keys } };
        const found = await WhatsAppMessage.findOne({
            ...conversationQuery,
            status: { $in: ['delivered', 'read', 'received'] },
        })
            .select('_id')
            .lean();
        return Boolean(found);
    } catch {
        return false;
    }
}

/** Silent lookup only. Never send a WhatsApp message. */
async function lookupContactsStatus(phone) {
    const config = getWhatsAppConfig();
    if (!config.accessToken || !config.phoneNumberId || !config.apiVersion) return null;
    try {
        const url = `${config.apiUrl}/${config.apiVersion}/${config.phoneNumberId}/contacts`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                blocking: 'wait',
                contacts: [`+${phone}`],
                force_check: true,
            }),
            signal: AbortSignal.timeout(12000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) return null;
        const row = Array.isArray(payload?.contacts) ? payload.contacts[0] : null;
        const status = String(row?.status || '').toLowerCase();
        if (status === 'invalid') return false;
        return null;
    } catch {
        return null;
    }
}

export function resolveWhatsAppAccountProbe(waMessageId, delivery = {}) {
    const id = String(waMessageId || '').trim();
    if (!id) return;
    const pending = pendingAccountProbes.get(id);
    if (!pending) return;
    const status = String(delivery?.status || '').toLowerCase();
    if (status === 'sent') return;
    pending.resolve(delivery || {});
}

const DELIVERED_STATUSES = new Set(['delivered', 'read', 'failed']);

export async function waitForWhatsAppDelivery(messageId, { timeoutMs = 18000 } = {}) {
    const id = String(messageId || '').trim();
    if (!id) return { status: 'timeout' };

    const WhatsAppMessage = (await import('../models/WhatsAppMessage.js')).default;

    async function readStatus() {
        const row = await WhatsAppMessage.findOne({ waMessageId: id }).select('status error').lean();
        const status = String(row?.status || '').toLowerCase();
        if (DELIVERED_STATUSES.has(status)) {
            return { status, errorMessage: row?.error || '' };
        }
        return null;
    }

    const already = await readStatus();
    if (already) return already;

    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(poll);
            pendingAccountProbes.delete(id);
            resolve(value);
        };

        const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
        const poll = setInterval(async () => {
            try {
                const row = await readStatus();
                if (row) finish(row);
            } catch {
                // keep waiting until timeout
            }
        }, 500);

        pendingAccountProbes.set(id, {
            resolve: (delivery) => {
                const status = String(delivery?.status || '').toLowerCase();
                if (status === 'sent' || !status) return;
                finish({
                    status,
                    errorCode: delivery?.errorCode,
                    errorMessage: delivery?.errorMessage || '',
                });
            },
        });
    });
}

const VALIDATION_TEMPLATE_NAME = 'welcome_to_vega';
const LOGIN_OTP_TEMPLATE_NAME = 'verp_login_otp';

/** Approved authentication template. Free text cannot open a new WhatsApp chat. */
export async function sendLoginOtpMessage(to, otp, extras = {}) {
    const code = String(otp || '').replace(/\s/g, '');
    if (!/^\d{4,8}$/.test(code)) {
        return fail('OTP code is invalid.');
    }

    return sendTemplateMessage(
        to,
        LOGIN_OTP_TEMPLATE_NAME,
        'en',
        [
            {
                type: 'body',
                parameters: [{ type: 'text', text: code }],
            },
            {
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [{ type: 'text', text: code }],
            },
        ],
        {
            source: 'template',
            actor: extras.actor || null,
            employeeId: extras.employeeId || '',
            contactName: extras.contactName || '',
        },
    );
}

export async function sendWhatsAppValidationTemplate(to, extras = {}) {
    const firstName = String(extras.firstName || extras.contactName || 'there')
        .replace(/[\r\n\t]+/g, ' ')
        .trim()
        .slice(0, 200) || 'there';
    const templateText = await fetchTemplateBodyText(VALIDATION_TEMPLATE_NAME);
    const placeholders = [...new Set(
        [...String(templateText || '').matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1])),
    )];
    const maxParam = placeholders.length ? Math.max(...placeholders) : 0;
    const values = [firstName, 'Vega'];
    const parameters = [];
    for (let i = 1; i <= maxParam; i += 1) {
        parameters.push({ type: 'text', text: values[i - 1] || firstName });
    }
    const components = parameters.length
        ? [{ type: 'body', parameters }]
        : (templateText
            ? []
            : [{
                type: 'body',
                parameters: [{ type: 'text', text: firstName }],
            }]);

    return sendTemplateMessage(to, VALIDATION_TEMPLATE_NAME, 'en', components, {
        source: extras.source || 'template',
        actor: extras.actor || null,
        employeeId: extras.employeeId || '',
        contactName: extras.contactName || firstName,
    });
}

/**
 * Check whether a number is on WhatsApp without sending a message.
 * Cloud API has no reliable contacts lookup; explicit invalid is the only
 * negative we trust. Prior delivered/received chat is a positive.
 */
export async function checkWhatsAppAccount(to) {
    try {
        const phone = normalizeWhatsAppPhone(to);
        if (!isValidWhatsAppPhone(phone)) {
            return accountCheckResult({
                success: false,
                onWhatsApp: false,
                error: WHATSAPP_NOT_REGISTERED_ERROR,
            });
        }

        const cached = getCachedAccountCheck(phone);
        if (cached) return cached;

        if (await hasDeliveredWhatsAppConversation(phone)) {
            const known = accountCheckResult({ onWhatsApp: true });
            setCachedAccountCheck(phone, known);
            return known;
        }

        if (!isWhatsAppEnabled()) {
            return accountCheckResult({ checkUnavailable: true });
        }

        const contactsStatus = await lookupContactsStatus(phone);
        if (contactsStatus === false) {
            const missing = accountCheckResult({
                success: false,
                onWhatsApp: false,
                error: WHATSAPP_NOT_REGISTERED_ERROR,
            });
            setCachedAccountCheck(phone, missing);
            return missing;
        }

        return accountCheckResult({ checkUnavailable: true });
    } catch (error) {
        return accountCheckResult({
            checkUnavailable: true,
            error: error?.message || 'WhatsApp check unavailable',
        });
    }
}

/** Empty number is allowed. Only block when Meta/history says it is not on WhatsApp. */
export async function assertRegisteredWhatsAppNumber(phone) {
    const raw = String(phone || '').trim();
    if (!raw) return { ok: true };

    const account = await checkWhatsAppAccount(raw);
    if (account.onWhatsApp === false && !account.checkUnavailable) {
        return {
            ok: false,
            message: account.error || WHATSAPP_NOT_REGISTERED_ERROR,
            field: 'whatsappNumber',
        };
    }
    return { ok: true };
}

export async function sendTextMessage(to, message, extras = {}) {
    try {
        if (!isWhatsAppEnabled()) {
            return fail('WhatsApp is disabled. Set WHATSAPP_ENABLED=true after credentials are filled.');
        }

        const phone = normalizeWhatsAppPhone(to);
        const text = String(message || '').trim();
        if (!isValidWhatsAppPhone(phone)) {
            return fail('A valid destination phone number is required.');
        }
        if (!text) {
            return fail('Message text is required.');
        }

        if (extras.eventKey && extras.skipPaidChannelCheck !== true) {
            const { getEventChannels, resolveEmployeePaidChannel } = await import(
                '../utils/notificationEmailPermission.js'
            );
            const channels = await getEventChannels(extras.eventKey);
            if (!channels.whatsapp) {
                return fail('WhatsApp is turned off for this event.');
            }
            if (extras.employee) {
                const picked = await resolveEmployeePaidChannel(extras.employee, extras.eventKey);
                if (picked.channel !== 'whatsapp') {
                    return fail('WhatsApp skipped: employee has a company email or channel is off.');
                }
            }
        }

        const result = await postWhatsAppMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone,
            type: 'text',
            text: { body: text },
        });
        const { logOutboundWhatsAppMessage } = await import('../utils/whatsappMessageLog.js');
        await logOutboundWhatsAppMessage({
            phone,
            // Callers that include a secret (portal password) pass a redacted log line.
            body: extras.logBody != null ? String(extras.logBody) : text,
            messageType: 'text',
            source: extras.source || 'manual',
            result,
            actor: extras.actor || null,
            employeeId: extras.employeeId || '',
            contactName: extras.contactName || '',
        });
        return result;
    } catch (error) {
        return fail(error);
    }
}

export async function uploadWhatsAppMedia(buffer, { mimeType = 'application/pdf', filename = 'document.pdf' } = {}) {
    try {
        const config = assertWhatsAppSendConfig();
        const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
        if (!bytes.length) return fail('Media file is empty.');

        const url = `${config.apiUrl}/${config.apiVersion}/${config.phoneNumberId}/media`;
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', mimeType);
        form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);

        const response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.accessToken}` },
            body: form,
            signal: AbortSignal.timeout(45000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.id) {
            const metaError = safeMetaError(payload);
            return fail(metaError.message || 'WhatsApp media upload failed', metaError);
        }
        return { success: true, mediaId: String(payload.id) };
    } catch (error) {
        if (error?.code === 'WHATSAPP_DISABLED' || error?.code === 'WHATSAPP_NOT_CONFIGURED') {
            return fail(error);
        }
        return fail(error);
    }
}

export async function sendDocumentMessage(to, { buffer, filename, caption = '', mimeType = 'application/pdf' } = {}, extras = {}) {
    try {
        if (!isWhatsAppEnabled()) {
            return fail('WhatsApp is disabled. Set WHATSAPP_ENABLED=true after credentials are filled.');
        }

        const phone = normalizeWhatsAppPhone(to);
        if (!isValidWhatsAppPhone(phone)) {
            return fail('A valid destination phone number is required.');
        }
        if (!buffer?.length) {
            return fail('Document file is required.');
        }
        const safeMime = resolveDocumentMime(mimeType, filename);
        if (safeMime === 'application/pdf' && !bufferLooksLikePdf(buffer)) {
            return fail('Attachment is not a valid PDF, so it was not sent.');
        }

        if (extras.eventKey && extras.skipPaidChannelCheck !== true) {
            const { getEventChannels } = await import('../utils/notificationEmailPermission.js');
            const channels = await getEventChannels(extras.eventKey);
            if (!channels.whatsapp) {
                return fail('WhatsApp is turned off for this event.');
            }
        }

        const safeName = String(filename || 'document.pdf').replace(/[^\w.\-]+/g, '_') || 'document.pdf';
        const note = String(caption || '').trim();
        const uploaded = await uploadWhatsAppMedia(buffer, { mimeType: safeMime, filename: safeName });
        if (!uploaded.success || !uploaded.mediaId) {
            const { logOutboundWhatsAppMessage } = await import('../utils/whatsappMessageLog.js');
            await logOutboundWhatsAppMessage({
                phone,
                body: note || `Document: ${safeName}`,
                messageType: 'document',
                mediaFileName: safeName,
                source: extras.source || 'auto',
                result: uploaded,
                actor: extras.actor || null,
                employeeId: extras.employeeId || '',
                contactName: extras.contactName || '',
            });
            return uploaded;
        }

        const document = { id: uploaded.mediaId, filename: safeName };
        if (note) document.caption = note.slice(0, 1024);

        const result = await postWhatsAppMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone,
            type: 'document',
            document,
        });
        const { logOutboundWhatsAppMessage } = await import('../utils/whatsappMessageLog.js');
        await logOutboundWhatsAppMessage({
            phone,
            body: note || `Document: ${safeName}`,
            messageType: 'document',
            mediaFileName: safeName,
            mediaUrl: String(extras.mediaUrl || '').trim(),
            source: extras.source || 'auto',
            result,
            actor: extras.actor || null,
            employeeId: extras.employeeId || '',
            contactName: extras.contactName || '',
        });
        return result;
    } catch (error) {
        return fail(error);
    }
}

function templateParameterText(value, fallback = '-') {
    const text = String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/ {5,}/g, '    ')
        .trim();
    return (text || fallback).slice(0, 900);
}

/**
 * Approved template with a document header. A normal document message is
 * blocked unless the employee messaged the company number in the last 24 hours.
 */
export async function sendDocumentTemplateMessage(
    to,
    {
        buffer,
        filename = 'document.pdf',
        templateName,
        bodyParams = [],
        languageCode = 'en',
        mimeType = 'application/pdf',
    } = {},
    extras = {},
) {
    try {
        if (!isWhatsAppEnabled()) {
            return fail('WhatsApp is disabled. Set WHATSAPP_ENABLED=true after credentials are filled.');
        }
        const phone = normalizeWhatsAppPhone(to);
        if (!isValidWhatsAppPhone(phone)) {
            return fail('A valid destination phone number is required.');
        }
        const name = String(templateName || '').trim();
        if (!name) return fail('Template name is required.');
        if (!buffer?.length) return fail('Document file is required.');
        const safeMime = resolveDocumentMime(mimeType, filename);
        if (safeMime === 'application/pdf' && !bufferLooksLikePdf(buffer)) {
            return fail('Attachment is not a valid PDF, so it was not sent.');
        }

        const safeName = String(filename || 'document.pdf').replace(/[^\w.\-]+/g, '_') || 'document.pdf';
        const uploaded = await uploadWhatsAppMedia(buffer, { mimeType: safeMime, filename: safeName });
        if (!uploaded.success || !uploaded.mediaId) {
            const { logOutboundWhatsAppMessage } = await import('../utils/whatsappMessageLog.js');
            await logOutboundWhatsAppMessage({
                phone,
                body: extras.logBody || `Document: ${safeName}`,
                messageType: 'template',
                mediaFileName: safeName,
                templateName: name,
                source: extras.source || 'auto',
                result: uploaded,
                actor: extras.actor || null,
                employeeId: extras.employeeId || '',
                contactName: extras.contactName || '',
            });
            return uploaded;
        }

        const components = [
            {
                type: 'header',
                parameters: [
                    {
                        type: 'document',
                        document: { id: uploaded.mediaId, filename: safeName },
                    },
                ],
            },
        ];
        if (bodyParams.length) {
            components.push({
                type: 'body',
                parameters: bodyParams.map((value, index) => ({
                    type: 'text',
                    text: templateParameterText(value, index === 0 ? 'record' : '0'),
                })),
            });
        }
        return sendTemplateMessage(to, name, languageCode, components, {
            ...extras,
            mediaFileName: safeName,
        });
    } catch (error) {
        return fail(error);
    }
}

export async function sendTemplateMessage(to, templateName, languageCode, components = [], extras = {}) {
    try {
        if (!isWhatsAppEnabled()) {
            return fail('WhatsApp is disabled. Set WHATSAPP_ENABLED=true after credentials are filled.');
        }

        const phone = normalizeWhatsAppPhone(to);
        const name = String(templateName || '').trim();
        const language = String(languageCode || 'en_US').trim() || 'en_US';
        if (!isValidWhatsAppPhone(phone)) {
            return fail('A valid destination phone number is required.');
        }
        if (!name) {
            return fail('Template name is required.');
        }

        const result = await postWhatsAppMessage({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'template',
            template: {
                name,
                language: { code: language },
                components: Array.isArray(components) ? components : [],
            },
        });
        const { logOutboundWhatsAppMessage, templateMessagePreview } = await import(
            '../utils/whatsappMessageLog.js'
        );
        const templateText = await fetchTemplateBodyText(name);
        await logOutboundWhatsAppMessage({
            phone,
            body: extras.logBody != null
                ? String(extras.logBody)
                : templateMessagePreview(name, components, templateText),
            messageType: 'template',
            mediaFileName: extras.mediaFileName || '',
            source: extras.source || 'template',
            templateName: name,
            result,
            actor: extras.actor || null,
            employeeId: extras.employeeId || '',
            contactName: extras.contactName || '',
        });
        return result;
    } catch (error) {
        return fail(error);
    }
}
