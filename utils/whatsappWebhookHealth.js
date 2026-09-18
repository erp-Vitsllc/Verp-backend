let lastEvent = {
    at: null,
    inbound: 0,
    statuses: 0,
    object: '',
};

export function rememberWhatsAppWebhook({ inbound = 0, statuses = 0, object = '' } = {}) {
    lastEvent = {
        at: new Date().toISOString(),
        inbound: Number(inbound) || 0,
        statuses: Number(statuses) || 0,
        object: String(object || ''),
    };
    return lastEvent;
}

export function getWhatsAppWebhookHealth() {
    return { ...lastEvent };
}
