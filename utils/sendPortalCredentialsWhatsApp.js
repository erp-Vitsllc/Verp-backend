import EmployeeBasic from '../models/EmployeeBasic.js';
import { isWhatsAppEnabled } from '../config/whatsapp.js';
import { normalizeLoginThrough } from './loginThrough.js';
import { resolveEmployeeWhatsAppPhone } from './sendToolsAssetWhatsAppReport.js';

const WEB_URL = String(process.env.PORTAL_WEB_URL || 'https://live.verp.cloud').replace(/\/+$/, '');
const IOS_APP_URL = String(process.env.PORTAL_IOS_APP_URL || 'https://apps.apple.com/app/id6813865476').trim();
const ANDROID_APP_URL = String(
    process.env.PORTAL_ANDROID_APP_URL || 'https://play.google.com/store/apps/details?id=com.vegadigital.verp',
).trim();

export function credentialLinkLines(loginThrough) {
    const through = normalizeLoginThrough({ loginThrough });
    const lines = [];
    if (through.web && WEB_URL) {
        lines.push(`🔗 ERP URL: ${WEB_URL}`);
    }
    if (through.portalApp) {
        if (IOS_APP_URL) lines.push(`📱 App (iOS): ${IOS_APP_URL}`);
        if (ANDROID_APP_URL) lines.push(`📱 App (Android): ${ANDROID_APP_URL}`);
    }
    return lines;
}

export function buildPortalCredentialsWhatsAppText({ username, password, linkLines = [] } = {}) {
    const lines = [
        'Hi,',
        'Please find your ERP login details below:',
        ...linkLines,
        `👤 Username: ${String(username || '').trim()}`,
        `🔑 Password: ${String(password || '')}`,
        '⚠️ Important Security Note:',
        '• This account/password cannot be used to log in on multiple devices at the same time.',
        '• Please keep your login credentials confidential and do not share them with anyone.',
        '• If you face any login issues, please contact Raseel directly for assistance.',
    ];
    return lines.join('\n');
}

function credentialsSendError(result, keptNote) {
    const note = keptNote || 'The user was still created.';
    const code = Number(result?.metaError?.code);
    if (code === 131047) {
        return `This WhatsApp number can only receive a free-text message if the person messaged the company WhatsApp in the last 24 hours. ${note}`;
    }
    if (code === 131026) {
        return `This WhatsApp number does not have a WhatsApp account. ${note}`;
    }
    if (code === 131030) {
        return `WhatsApp could not deliver to this number. ${note}`;
    }
    const detail = String(result?.error || '').trim();
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
    const employee = await EmployeeBasic.findOne({ employeeId: String(employeeId || '').trim() })
        .select('loginThrough')
        .lean();
    const text = buildPortalCredentialsWhatsAppText({
        username,
        password,
        linkLines: credentialLinkLines(employee?.loginThrough),
    });
    const safeUsername = String(username || '').trim();
    const { sendTextMessage } = await import('../services/whatsappService.js');
    const result = await sendTextMessage(phone, text, {
        source: 'auto',
        actor,
        employeeId,
        contactName: String(name || '').trim(),
        logBody: `Portal login details sent for username ${safeUsername}.`,
    });

    if (!result?.success) {
        console.warn('[PortalCredentialsWhatsApp] send failed', employeeId, result?.error || '');
        return { sent: false, reason: 'send_failed', error: credentialsSendError(result, keptNote) };
    }

    return { sent: true, reason: 'whatsapp', messageId: result.messageId || '' };
}
