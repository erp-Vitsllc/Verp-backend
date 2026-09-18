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

const templateTextCache = new Map();

async function fetchTemplateBodyText(templateName) {
    const name = String(templateName || '').trim();
    if (!name) return '';
    if (templateTextCache.has(name)) return templateTextCache.get(name);

    const config = getWhatsAppConfig();
    if (!config.wabaId || !config.accessToken || !config.apiVersion) {
        templateTextCache.set(name, '');
        return '';
    }

    try {
        const url = `${config.apiUrl}/${config.apiVersion}/${config.wabaId}/message_templates?name=${encodeURIComponent(name)}&fields=name,components,language`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${config.accessToken}` },
            signal: AbortSignal.timeout(12000),
        });
        const payload = await response.json().catch(() => ({}));
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        const match = rows.find((row) => String(row?.name || '').trim() === name) || rows[0];
        const bodyComponent = (Array.isArray(match?.components) ? match.components : []).find(
            (row) => String(row?.type || '').toUpperCase() === 'BODY',
        );
        const text = String(bodyComponent?.text || '').trim();
        templateTextCache.set(name, text);
        return text;
    } catch {
        templateTextCache.set(name, '');
        return '';
    }
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
const PROBE_WAIT_MS = 12000;
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

function isNotOnWhatsAppError(code, text) {
    const message = String(text || '').toLowerCase();
    return (
        Number(code) === 131026
        || message.includes('not a whatsapp user')
        || (message.includes('undeliverable') && Number(code) !== 131030)
    );
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

function interpretRecipientProbe(result) {
    const code = Number(result?.metaError?.code);
    const text = String(result?.error || '');

    if (isNotOnWhatsAppError(code, text)) {
        return accountCheckResult({
            success: false,
            onWhatsApp: false,
            error: WHATSAPP_NOT_REGISTERED_ERROR,
            metaError: result?.metaError || null,
        });
    }

    // 24-hour session window: recipient exists, nothing is delivered.
    if (code === 131047) {
        return accountCheckResult({ onWhatsApp: true, metaError: result?.metaError || null });
    }

    if (code === 131030 || text.toLowerCase().includes('not in allowed list')) {
        return accountCheckResult({
            success: false,
            onWhatsApp: false,
            error: WHATSAPP_NOT_REGISTERED_ERROR,
            metaError: result?.metaError || null,
        });
    }

    // HTTP 200 only means Meta accepted the send. Unregistered numbers often
    // fail later with webhook 131026 — do not treat this as registered.
    return null;
}

function interpretProbeDelivery(delivery) {
    const status = String(delivery?.status || '').toLowerCase();
    const code = Number(delivery?.errorCode);
    const text = String(delivery?.errorMessage || '');

    if (['delivered', 'read'].includes(status) && !isNotOnWhatsAppError(code, text)) {
        return accountCheckResult({ onWhatsApp: true });
    }
    if (status === 'failed' && code === 131047) {
        return accountCheckResult({ onWhatsApp: true });
    }
    if (isNotOnWhatsAppError(code, text) || status === 'failed') {
        return accountCheckResult({
            success: false,
            onWhatsApp: false,
            error: WHATSAPP_NOT_REGISTERED_ERROR,
        });
    }
    return null;
}

export function resolveWhatsAppAccountProbe(waMessageId, delivery = {}) {
    const id = String(waMessageId || '').trim();
    if (!id) return;
    const pending = pendingAccountProbes.get(id);
    if (!pending) return;
    const status = String(delivery?.status || '').toLowerCase();
    if (status === 'sent') return;
    pending.resolve({
        status,
        errorCode: Number(delivery?.errorCode) || 0,
        errorMessage: String(delivery?.errorMessage || ''),
    });
}

function waitForAccountProbe(messageId, timeoutMs = PROBE_WAIT_MS) {
    const id = String(messageId || '').trim();
    if (!id) return Promise.resolve(null);

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingAccountProbes.delete(id);
            resolve(null);
        }, timeoutMs);
        pendingAccountProbes.set(id, {
            resolve: (value) => {
                clearTimeout(timer);
                pendingAccountProbes.delete(id);
                resolve(value);
            },
        });
    });
}

/**
 * Meta Cloud API has no contacts lookup.
 * 131026 = not a WhatsApp user. 131047 = registered, outside the 24h window.
 * HTTP 200 is not proof — wait for the delivery webhook before allowing save.
 */
export async function checkWhatsAppAccount(to) {
    try {
        if (!isWhatsAppEnabled()) {
            return accountCheckResult({ checkUnavailable: true });
        }

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

        const probe = await postWhatsAppMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone,
            type: 'text',
            text: { preview_url: false, body: '\u2060' },
        });
        const immediate = interpretRecipientProbe(probe);
        if (immediate) {
            console.log('[WhatsApp] account check', {
                phoneSuffix: phone.slice(-4),
                onWhatsApp: immediate.onWhatsApp,
                code: immediate.metaError?.code ?? null,
            });
            setCachedAccountCheck(phone, immediate);
            return immediate;
        }

        const messageId = probe.messageId || probe.data?.messages?.[0]?.id || '';
        if (probe.success && messageId) {
            const delivery = await waitForAccountProbe(messageId);
            const fromWebhook = delivery ? interpretProbeDelivery(delivery) : null;
            if (fromWebhook) {
                console.log('[WhatsApp] account check', {
                    phoneSuffix: phone.slice(-4),
                    onWhatsApp: fromWebhook.onWhatsApp,
                    status: delivery?.status || '',
                    code: delivery?.errorCode || null,
                });
                setCachedAccountCheck(phone, fromWebhook);
                return fromWebhook;
            }
        }

        console.log('[WhatsApp] account check', {
            phoneSuffix: phone.slice(-4),
            onWhatsApp: false,
            reason: probe.success ? 'no_delivery_confirmation' : (probe.error || 'probe_failed'),
        });
        return accountCheckResult({
            success: false,
            onWhatsApp: false,
            error: WHATSAPP_NOT_REGISTERED_ERROR,
            metaError: probe.metaError || null,
        });
    } catch (error) {
        if (error?.code === 'WHATSAPP_DISABLED' || error?.code === 'WHATSAPP_NOT_CONFIGURED') {
            return accountCheckResult({ checkUnavailable: true, error: error.message });
        }
        return accountCheckResult({
            success: false,
            onWhatsApp: false,
            error: WHATSAPP_NOT_REGISTERED_ERROR,
        });
    }
}

/** Empty number is allowed. A filled number must be confirmed on WhatsApp before save. */
export async function assertRegisteredWhatsAppNumber(phone) {
    const raw = String(phone || '').trim();
    if (!raw) return { ok: true };
    if (!isWhatsAppEnabled()) return { ok: true };

    const account = await checkWhatsAppAccount(raw);
    if (account.onWhatsApp === true) return { ok: true };
    return {
        ok: false,
        message: account.error || WHATSAPP_NOT_REGISTERED_ERROR,
        field: 'whatsappNumber',
    };
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
            body: text,
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
            body: templateMessagePreview(name, components, templateText),
            messageType: 'template',
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
