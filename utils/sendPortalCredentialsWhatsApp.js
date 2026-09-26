import { isWhatsAppEnabled } from '../config/whatsapp.js';
import { normalizeLoginThrough } from './loginThrough.js';
import { resolveEmployeeWhatsAppPhone } from './sendToolsAssetWhatsAppReport.js';

const WEB_URL = String(process.env.PORTAL_WEB_URL || 'https://live.verp.cloud').replace(/\/+$/, '');
const IOS_APP_URL = String(process.env.PORTAL_IOS_APP_URL || 'https://apps.apple.com/app/id6813865476').trim();
const ANDROID_APP_URL = String(
    process.env.PORTAL_ANDROID_APP_URL || 'https://play.google.com/store/apps/details?id=com.vegadigital.verp',
).trim();

// Free text is not delivered unless that person messaged the company number in the last 24 hours.
// This utility template is what WhatsApp will actually hand to the phone.
const PORTAL_ACCOUNT_TEMPLATE = 'vega_digital_it_solution';

function whatsAppTemplateParam(value, fallback) {
    const text = String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/ {5,}/g, '    ')
        .trim();
    return (text || fallback).slice(0, 900);
}

export function credentialLinkLines(loginThrough) {
    const through = normalizeLoginThrough({ loginThrough });
    const lines = [];
    if (through.web && WEB_URL) lines.push(`ERP URL: ${WEB_URL}`);
    if (through.portalApp) {
        if (IOS_APP_URL) lines.push(`App (iOS): ${IOS_APP_URL}`);
        if (ANDROID_APP_URL) lines.push(`App (Android): ${ANDROID_APP_URL}`);
    }
    return lines;
}

export function buildPortalCredentialsWhatsAppText({ username, password, linkLines = [] } = {}) {
    const lines = [
        'Hi,',
        'Please find your ERP login details below:',
        ...linkLines,
        `Username: ${String(username || '').trim()}`,
        `Password: ${String(password || '')}`,
        'Important Security Note:',
        'This account cannot be used on more than one device at the same time.',
        'Please keep this message private and do not share it with anyone.',
        'If you need help, please contact Raseel directly.',
    ];
    return lines.join('\n');
}

function credentialsSendError(result, keptNote) {
    const note = keptNote || 'The user was still created.';
    const code = Number(result?.metaError?.code);
    const detail = String(result?.error || '').trim();
    if (code === 132001 || /template name .* does not exist|translations/i.test(detail)) {
        return `WhatsApp is still approving the login message, so it was not delivered. ${note} Try again in a few minutes.`;
    }
    if (code === 132015 || code === 132016) {
        return `WhatsApp paused the login message, so it was not delivered. ${note}`;
    }
    if (code === 131047) {
        return `This WhatsApp number can only receive a free-text message if the person messaged the company WhatsApp in the last 24 hours. ${note}`;
    }
    if (code === 131026) {
        return `This WhatsApp number does not have a WhatsApp account. ${note}`;
    }
    if (code === 131030) {
        return `WhatsApp could not deliver to this number. ${note}`;
    }
    return detail
        ? `WhatsApp could not send the login details. ${note} ${detail}`
        : `WhatsApp could not send the login details. ${note}`;
}

/**
 * Sends the new portal username and password to the employee's profile WhatsApp number.
 * Explicit admin action on Add User — not gated by notification channel settings.
 */
export async function sendPortalCredentialsWhatsApp({
    employeeId,
    name,
    username,
    password,
    actor = null,
    kind = 'created',
} = {}) {
    if (!isWhatsAppEnabled()) {
        return { sent: false, reason: 'disabled', error: 'WhatsApp is turned off.' };
    }

    const phone = await resolveEmployeeWhatsAppPhone(employeeId);
    if (!phone) {
        return {
            sent: false,
            reason: 'no_whatsapp',
            error: 'This employee has no WhatsApp number on their profile.',
        };
    }

    const keptNote = kind === 'reset'
        ? 'The password was still updated.'
        : 'The user was still created.';
    const safeUsername = whatsAppTemplateParam(username, 'user');
    const safePassword = whatsAppTemplateParam(password, '-');
    const accountLine = `${safeUsername}. Password: ${safePassword}`;
    const { sendTemplateMessage } = await import('../services/whatsappService.js');
    const result = await sendTemplateMessage(
        phone,
        PORTAL_ACCOUNT_TEMPLATE,
        'en',
        [
            {
                type: 'body',
                parameters: [
                    { type: 'text', text: whatsAppTemplateParam(name, 'there') },
                    { type: 'text', text: accountLine },
                ],
            },
        ],
        {
            source: 'auto',
            actor,
            employeeId,
            contactName: String(name || '').trim(),
        },
    );

    if (!result?.success) {
        console.warn('[PortalCredentialsWhatsApp] send failed', employeeId, result?.error || '');
        return { sent: false, reason: 'send_failed', error: credentialsSendError(result, keptNote) };
    }

    return { sent: true, reason: 'whatsapp', messageId: result.messageId || '' };
}
