/**
 * Resolve workflow state for a specific service row.
 * Prefers live activeServiceWorkflow when it matches; otherwise uses that row's workflowSnapshot
 * so a previous ending service can still be completed while a newer request is in approval.
 */

function cloneHistory(history) {
    if (!Array.isArray(history)) return [];
    return history.map((h) => ({
        stage: h.stage,
        action: h.action,
        note: h.note || '',
        byName: h.byName || '',
        bySignatureUrl: h.bySignatureUrl || '',
        at: h.at,
    }));
}

export function snapshotActiveServiceWorkflow(asset) {
    const wf = asset?.activeServiceWorkflow;
    if (!wf?.serviceRecordId) return;
    const sub = asset.services?.id?.(wf.serviceRecordId);
    if (!sub) return;
    sub.workflowSnapshot = {
        stage: wf.stage,
        serviceTypeLabel: wf.serviceTypeLabel || '',
        serviceRecordId: wf.serviceRecordId,
        history: cloneHistory(wf.history),
        scheduledServiceDate: wf.scheduledServiceDate || null,
        serviceWindowEndDate: wf.serviceWindowEndDate || null,
        serviceDurationDays: wf.serviceDurationDays ?? null,
        previousStatus: wf.previousStatus ?? null,
        accountsHold: wf.accountsHold || null,
        oilServiceLiveAt: wf.oilServiceLiveAt || null,
        shopServiceLiveAt: wf.shopServiceLiveAt || null,
    };
    asset.markModified('services');
}

/**
 * @returns {{ wf: object|null, bindActive: boolean }}
 */
export function getWorkflowContextForService(asset, serviceId) {
    if (!asset || !serviceId) return { wf: null, bindActive: false };

    const active = asset.activeServiceWorkflow || null;
    if (active?.serviceRecordId && String(active.serviceRecordId) === String(serviceId)) {
        return { wf: active, bindActive: true };
    }

    const service = asset.services?.id?.(serviceId);
    const snap = service?.workflowSnapshot;
    if (snap && (snap.stage || (Array.isArray(snap.history) && snap.history.length))) {
        if (!snap.serviceRecordId) snap.serviceRecordId = serviceId;
        return { wf: snap, bindActive: false };
    }

    return { wf: null, bindActive: false };
}

/**
 * Persist workflow mutations for a service context.
 * When bindActive is false, only the service row snapshot is updated (does not displace another live workflow).
 */
export function commitWorkflowContext(asset, serviceId, { wf, bindActive }) {
    if (!asset || !serviceId || !wf) return;

    if (bindActive) {
        asset.activeServiceWorkflow = wf;
        asset.markModified('activeServiceWorkflow');
        snapshotActiveServiceWorkflow(asset);
        return;
    }

    const sub = asset.services?.id?.(serviceId);
    if (!sub) return;
    sub.workflowSnapshot = {
        stage: wf.stage,
        serviceTypeLabel: wf.serviceTypeLabel || '',
        serviceRecordId: wf.serviceRecordId || serviceId,
        history: cloneHistory(wf.history),
        scheduledServiceDate: wf.scheduledServiceDate || null,
        serviceWindowEndDate: wf.serviceWindowEndDate || null,
        serviceDurationDays: wf.serviceDurationDays ?? null,
        previousStatus: wf.previousStatus ?? null,
        accountsHold: wf.accountsHold || null,
        oilServiceLiveAt: wf.oilServiceLiveAt || null,
        shopServiceLiveAt: wf.shopServiceLiveAt || null,
        completedAt: wf.completedAt || null,
    };
    asset.markModified('services');
}
