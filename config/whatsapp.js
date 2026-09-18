/** Read a trimmed env string. Reloaded when the backend process starts. */
function envString(name, fallback = '') {
    return String(process.env[name] ?? fallback).trim();
}

function parseEnabled(value) {
    const flag = String(value || '').trim().toLowerCase();
    return flag === 'true' || flag === '1' || flag === 'yes';
}

const SEND_REQUIRED = [
    'WHATSAPP_API_VERSION',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_ACCESS_TOKEN',
];

export function getWhatsAppConfig() {
    const apiUrl = envString('WHATSAPP_API_URL', 'https://graph.facebook.com').replace(/\/$/, '');
    const apiVersion = envString('WHATSAPP_API_VERSION');
    const phoneNumberId = envString('WHATSAPP_PHONE_NUMBER_ID');
    const wabaId = envString('WHATSAPP_WABA_ID');
    const accessToken = envString('WHATSAPP_ACCESS_TOKEN');
    const verifyToken = envString('WHATSAPP_VERIFY_TOKEN');
    const enabled = parseEnabled(process.env.WHATSAPP_ENABLED);

    return {
        apiUrl,
        apiVersion,
        phoneNumberId,
        wabaId,
        accessToken,
        verifyToken,
        enabled,
    };
}

export function isWhatsAppEnabled() {
    return getWhatsAppConfig().enabled;
}

export function getWhatsAppConfigGaps() {
    const config = getWhatsAppConfig();
    const missing = [];
    if (!config.apiVersion) missing.push('WHATSAPP_API_VERSION');
    if (!config.phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
    if (!config.accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
    return missing;
}

/** Safe status for APIs. Never includes tokens. */
export function getWhatsAppPublicStatus() {
    const config = getWhatsAppConfig();
    const missing = getWhatsAppConfigGaps();
    return {
        enabled: config.enabled,
        configured: missing.length === 0,
        phoneNumberIdConfigured: Boolean(config.phoneNumberId),
        wabaConfigured: Boolean(config.wabaId),
        apiVersion: config.apiVersion || '',
        apiUrl: config.apiUrl,
        verifyTokenConfigured: Boolean(config.verifyToken),
        missing: config.enabled ? missing : [],
    };
}

/**
 * Validate send credentials only when WhatsApp is enabled.
 * Does not throw on import. Does not crash ERP when disabled.
 */
export function assertWhatsAppSendConfig() {
    const config = getWhatsAppConfig();
    if (!config.enabled) {
        const error = new Error('WhatsApp is disabled. Set WHATSAPP_ENABLED=true after credentials are filled.');
        error.code = 'WHATSAPP_DISABLED';
        throw error;
    }
    const missing = getWhatsAppConfigGaps();
    if (missing.length) {
        const error = new Error(
            `WhatsApp is enabled but missing required configuration: ${missing.join(', ')}`,
        );
        error.code = 'WHATSAPP_NOT_CONFIGURED';
        error.missing = missing;
        throw error;
    }
    return config;
}

export function getWhatsAppMessagesUrl(config = getWhatsAppConfig()) {
    return `${config.apiUrl}/${config.apiVersion}/${config.phoneNumberId}/messages`;
}

let identityCache = { at: 0, value: null };

/** Display number + verified name of the sending WhatsApp Business account. */
export async function getWhatsAppBusinessIdentity() {
    const now = Date.now();
    if (identityCache.value && now - identityCache.at < 6 * 60 * 60 * 1000) {
        return identityCache.value;
    }

    const config = getWhatsAppConfig();
    const fallback = {
        displayPhone: envString('WHATSAPP_DISPLAY_PHONE'),
        verifiedName: envString('WHATSAPP_ACCOUNT_NAME') || 'WhatsApp Business',
    };
    if (!config.phoneNumberId || !config.accessToken || !config.apiVersion) {
        identityCache = { at: now, value: fallback };
        return fallback;
    }

    try {
        const url = `${config.apiUrl}/${config.apiVersion}/${config.phoneNumberId}?fields=display_phone_number,verified_name`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${config.accessToken}` },
            signal: AbortSignal.timeout(12000),
        });
        const payload = await response.json().catch(() => ({}));
        const displayPhone = normalizeDigits(payload?.display_phone_number) || fallback.displayPhone;
        const verifiedName = String(payload?.verified_name || fallback.verifiedName).trim();
        const value = { displayPhone, verifiedName: verifiedName || 'WhatsApp Business' };
        identityCache = { at: now, value };
        return value;
    } catch {
        identityCache = { at: now, value: fallback };
        return fallback;
    }
}

function normalizeDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

export { SEND_REQUIRED };
