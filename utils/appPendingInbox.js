import { assigneeAcceptChannel } from './loginThrough.js';
import { isAcceptedAssignmentOutcomeNotification } from './isAcceptedAssignmentOutcomeNotification.js';

function parseExtra3(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/** App inbox is for employees who can sign in on the app and cannot sign in on the web. */
export function appInboxChannel(source) {
    return assigneeAcceptChannel(source) === 'app' ? 'app' : null;
}

/**
 * Pending rows the employee must act on.
 * Copies that only tell the sender what happened stay off this list.
 */
export function isActionableAppInboxRow(row) {
    if (!row) return false;
    if (String(row.status || 'Pending') !== 'Pending') return false;
    if (isAcceptedAssignmentOutcomeNotification(row)) return false;

    const meta = parseExtra3(row.extra3);
    const type = String(row.requestType || '').trim();
    if (type === 'Asset Assignment' && meta?.handoverViewerRole === 'assigner') return false;
    if (type === 'Company Activation' && meta?.companyActivationViewerRole === 'requester') return false;
    if (meta?.assignmentOutcome === true) {
        const outcome = String(meta.outcome || '').toLowerCase();
        if (outcome === 'accept' || outcome === 'accepted') return false;
    }
    return true;
}

/** Tell the app this row is for an app-only employee, without renaming the request. */
export function tagAppAcceptChannel(extra3) {
    let base = {};
    if (extra3 && typeof extra3 === 'object' && !Array.isArray(extra3)) {
        base = { ...extra3 };
    } else if (typeof extra3 === 'string' && extra3.trim()) {
        const parsed = parseExtra3(extra3);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = { ...parsed };
        else base = { text: extra3 };
    }
    return JSON.stringify({
        ...base,
        acceptChannel: 'app',
    });
}

export function presentAppInboxRow(row) {
    return {
        dashboardActionId: String(row._id),
        requestType: row.requestType,
        requestedDate: row.requestedDate || row.createdAt || null,
        requestedByName: row.requestedByName || '',
        subjectName: row.subjectName || '',
        extra1: row.extra1 || '',
        extra2: row.extra2 || '',
        extra3: tagAppAcceptChannel(row.extra3),
        requestObjectId: row.requestId ? String(row.requestId) : '',
        status: 'Pending',
    };
}
