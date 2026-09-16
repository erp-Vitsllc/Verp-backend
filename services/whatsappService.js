import {
    assertWhatsAppSendConfig,
    getWhatsAppConfig,
    getWhatsAppMessagesUrl,
    getWhatsAppPublicStatus,
    isWhatsAppEnabled,
} from '../config/whatsapp.js';
import { isValidWhatsAppPhone, normalizeWhatsAppPhone } from '../utils/normalizeWhatsAppPhone.js';

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

/**
 * Cloud API has no supported /contacts edge on the phone-number ID
 * (Meta returns GraphMethodException 100 / subcode 33).
 * Empty-number is checked by the caller; account existence is confirmed
 * on send via Meta error 131026.
 */
export async function checkWhatsAppAccount(to) {
    try {
        if (!isWhatsAppEnabled()) {
            return fail('WhatsApp is disabled. Set WHATSAPP_ENABLED=true after credentials are filled.');
        }

        const phone = normalizeWhatsAppPhone(to);
        if (!isValidWhatsAppPhone(phone)) {
            return {
                success: false,
                onWhatsApp: false,
                error: 'This user have no WP',
                metaError: null,
            };
        }

        return {
            success: true,
            onWhatsApp: null,
            checkUnavailable: true,
            error: null,
            metaError: null,
        };
    } catch (error) {
        if (error?.code === 'WHATSAPP_DISABLED' || error?.code === 'WHATSAPP_NOT_CONFIGURED') {
            return fail(error);
        }
        return fail(error);
    }
}

export async function sendTextMessage(to, message) {
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

        return postWhatsAppMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone,
            type: 'text',
            text: { body: text },
        });
    } catch (error) {
        return fail(error);
    }
}

export async function sendTemplateMessage(to, templateName, languageCode, components = []) {
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

        return postWhatsAppMessage({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'template',
            template: {
                name,
                language: { code: language },
                components: Array.isArray(components) ? components : [],
            },
        });
    } catch (error) {
        return fail(error);
    }
}
