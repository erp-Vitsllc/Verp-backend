/**
 * Structured service fields for AssetHistory.details (tools / equipment service flow).
 */

export function serializeServiceRecord(service) {
    if (!service || typeof service !== 'object') return null;
    return {
        date: service.date || null,
        expiryDate: service.expiryDate || null,
        serviceDuration: service.serviceDuration || null,
        description: service.description || null,
        invoice: service.invoice || null,
        attachment: service.attachment || null,
        value: service.value ?? null,
        serviceType: service.serviceType || null,
    };
}

export function buildServiceSendHistoryDetails({
    serviceRecord,
    prevStatus,
    description,
    serviceDuration,
}) {
    const svc = serializeServiceRecord(serviceRecord);
    return {
        serviceEventType: 'sent',
        prevAssetStatus: prevStatus || null,
        serviceStartDate: svc?.date || null,
        serviceExpiryDate: svc?.expiryDate || null,
        serviceDuration: serviceDuration || svc?.serviceDuration || null,
        serviceDescription: description || svc?.description || null,
        invoice: svc?.invoice || null,
        attachment: svc?.attachment || null,
        serviceRecord: svc,
    };
}

export function buildServiceReceiveHistoryDetails({
    action = 'live',
    currentService,
    completionRecord,
    prevStatus,
    nextStatus,
    serviceReport,
    amount,
    isBulk = false,
}) {
    const active = serializeServiceRecord(currentService);
    const completion = serializeServiceRecord(completionRecord);
    return {
        serviceEventType: action === 'return' ? 'return' : 'live',
        isBulk: !!isBulk,
        prevAssetStatus: prevStatus || null,
        nextAssetStatus: nextStatus || null,
        completedAt: new Date(),
        serviceStartDate: active?.date || null,
        serviceExpiryDate: active?.expiryDate || null,
        serviceDuration: active?.serviceDuration || null,
        serviceDescription: active?.description || null,
        serviceReport: serviceReport || completion?.description || null,
        amount: amount ?? completion?.value ?? 0,
        attachment: completion?.attachment || null,
        serviceRecord: active,
        completionRecord: completion,
    };
}

export function buildServiceExtendHistoryDetails({
    currentService,
    extensionDays,
    extensionReason,
    previousExpiryDate,
    newExpiryDate,
    previousDurationDays,
    updatedTotalDays,
    prevAssetStatus,
    isBulk = false,
}) {
    const svc = serializeServiceRecord(currentService);
    return {
        serviceEventType: 'extend',
        isBulk: !!isBulk,
        extensionDays,
        extensionReason: extensionReason || null,
        previousExpiryDate: previousExpiryDate || null,
        newExpiryDate: newExpiryDate || null,
        previousDurationDays: previousDurationDays ?? null,
        updatedTotalDays: updatedTotalDays ?? null,
        serviceDuration: svc?.serviceDuration || (updatedTotalDays != null ? `${updatedTotalDays} days` : null),
        serviceStartDate: svc?.date || null,
        serviceExpiryDate: newExpiryDate || svc?.expiryDate || null,
        serviceDescription: svc?.description || null,
        prevAssetStatus: prevAssetStatus || null,
        serviceRecord: svc,
    };
}
