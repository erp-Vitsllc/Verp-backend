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

export { SEND_REQUIRED };
