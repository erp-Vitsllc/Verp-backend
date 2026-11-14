import {
    loadWhatsAppTemplate,
    sendDocumentTemplateMessage,
    sendTemplateMessage,
} from '../services/whatsappService.js';

/** Approved Utility templates. Automated sends always use one of these. */
export const AUTOMATED_WHATSAPP = Object.freeze({
    otEarned: 'verp_ot_earned',
    fineApproved: 'verp_fine_approved',
    paymentApproved: 'verp_payment_approved',
    toolsHandover: 'verp_tools_handover',
    toolsMonthly: 'verp_tools_monthly',
    vehicleAssigned: 'verp_vehicle_assigned',
    vehicleReview: 'verp_vehicle_review',
    vehicleRemoved: 'verp_vehicle_removed',
    vehicleHr: 'verp_vehicle_hr',
    vehicleHrResult: 'verp_vehicle_hr_result',
    taskClosed: 'verp_task_closed',
    assetForce: 'verp_asset_force',
    assetUnassigned: 'verp_asset_unassigned',
    salarySlip: 'verp_salary_slip',
});

export function whatsAppTemplateParam(value, fallback = '-') {
    const text = String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/ {5,}/g, '    ')
        .trim();
    return (text || fallback).slice(0, 900);
}

export function fitTemplateParams(values, count) {
    const source = Array.isArray(values) ? values : [];
    const size = Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : source.length;
    const fitted = [];
    for (let index = 0; index < size; index += 1) {
        fitted.push(whatsAppTemplateParam(source[index], '-'));
    }
    return fitted;
}

function templateIsReady(spec, hasDocument) {
    if (!spec?.approved) return false;
    if (hasDocument) return spec.headerFormat === 'DOCUMENT';
    return spec.headerFormat !== 'DOCUMENT';
}

/**
 * Use the named template when it is active.
 * A PDF whose own template is still in review goes on another active document template
 * so the file is still delivered.
 */
async function resolveLiveTemplate(templateName, hasDocument, bodyParams) {
    const name = String(templateName || '').trim();
    const params = Array.isArray(bodyParams) ? bodyParams : [];
    if (!name) return { name: '', spec: null, bodyParams: params };

    const spec = await loadWhatsAppTemplate(name);
    if (!spec || templateIsReady(spec, hasDocument)) {
        return { name, spec, bodyParams: params };
    }

    if (hasDocument && name === AUTOMATED_WHATSAPP.salarySlip) {
        const standby = await loadWhatsAppTemplate(AUTOMATED_WHATSAPP.paymentApproved);
        if (!standby || templateIsReady(standby, true)) {
            const month = whatsAppTemplateParam(params[1] || params[0], 'this month');
            return {
                name: AUTOMATED_WHATSAPP.paymentApproved,
                spec: standby,
                bodyParams: [`salary slip for ${month}`, 'as shown on the slip'],
            };
        }
    }

    return {
        name,
        spec,
        bodyParams: params,
        blocked: true,
    };
}

/** Always send the active template. Callers may still pass session text; it is not used. */
export async function sendAutomatedWhatsApp({
    phone,
    templateName = '',
    bodyParams = [],
    document = null,
    extras = {},
} = {}) {
    const file = document?.buffer?.length ? document : null;
    const resolved = await resolveLiveTemplate(templateName, Boolean(file), bodyParams);
    if (!resolved.name) {
        return { success: false, error: 'WhatsApp template was not sent.' };
    }
    if (resolved.blocked) {
        return {
            success: false,
            error: `WhatsApp template ${resolved.name} is not active, so the message was not sent.`,
        };
    }

    const language = resolved.spec?.language || 'en';
    const paramCount = resolved.spec
        ? resolved.spec.bodyParamCount
        : resolved.bodyParams.length;
    const fitted = fitTemplateParams(resolved.bodyParams, paramCount);

    if (file) {
        return sendDocumentTemplateMessage(
            phone,
            {
                buffer: file.buffer,
                filename: file.filename || 'document.pdf',
                mimeType: file.mimeType || 'application/pdf',
                templateName: resolved.name,
                languageCode: language,
                bodyParams: fitted,
            },
            extras,
        );
    }

    const components = fitted.length
        ? [{ type: 'body', parameters: fitted.map((text) => ({ type: 'text', text })) }]
        : [];
    return sendTemplateMessage(phone, resolved.name, language, components, extras);
}
