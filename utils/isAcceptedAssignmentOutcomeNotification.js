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

/**
 * FYI "assignment accepted" inbox rows. Accept is email-only — these should not appear
 * in pending bells. Reject outcomes are still shown.
 */
export function isAcceptedAssignmentOutcomeNotification(row = {}) {
    const requestType = String(row.requestType || row.type || '').trim();
    if (requestType && requestType !== 'Asset Assignment' && requestType !== 'Asset') {
        return false;
    }
    const meta = parseExtra3(row.extra3);
    if (meta?.isBulkAssignment === true) return false;

    const extra1 = String(row.extra1 || '').trim();
    const extra2 = String(row.extra2 || '').trim();
    const outcome = String(meta?.outcome || '').toLowerCase();

    if (meta?.assignmentOutcome === true && (outcome === 'accept' || outcome === 'accepted')) {
        return true;
    }
    if (/\bassignment accepted\b/i.test(extra1) && !/^bulk assignment\b/i.test(extra1)) return true;
    if (/^assignment accepted$/i.test(extra2)) return true;
    return false;
}
