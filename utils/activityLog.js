import ActivityLog from '../models/ActivityLog.js';

/** Best-effort client IP (supports proxies via x-forwarded-for / x-real-ip). */
export function getClientIp(req) {
    if (!req) return '';
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded[0]) {
        return String(forwarded[0]).split(',')[0].trim();
    }
    const realIp = req.headers?.['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
    if (req.ip) return String(req.ip);
    if (req.socket?.remoteAddress) return String(req.socket.remoteAddress);
    return '';
}

/**
 * Persist an ERP activity row. Never throws to callers — logging must not break CRUD.
 * Sets req._activityLogged so the catch-all audit middleware skips a duplicate row.
 */
export async function recordActivity({
    req,
    module = 'General',
    action = 'other',
    entityType = '',
    entityId = '',
    summary,
    viewHref = '',
    metadata = {},
    actor: actorOverride = null,
    ip: ipOverride = '',
} = {}) {
    try {
        if (!summary || typeof summary !== 'string') return null;

        const actorName =
            actorOverride?.name ||
            req?.user?.name ||
            req?.user?.username ||
            metadata?.actorName ||
            'System';

        const doc = await ActivityLog.create({
            module,
            action,
            entityType: entityType ? String(entityType) : '',
            entityId: entityId != null && entityId !== '' ? String(entityId) : '',
            summary: summary.trim(),
            actor: {
                userId:
                    actorOverride?.userId ||
                    req?.user?.id ||
                    req?.user?._id ||
                    undefined,
                name: actorName,
                employeeId:
                    actorOverride?.employeeId ||
                    req?.user?.employeeId ||
                    metadata?.employeeId ||
                    '',
            },
            viewHref: viewHref || '',
            metadata: metadata && typeof metadata === 'object' ? metadata : {},
            method: req?.method || '',
            path: req?.originalUrl || req?.url || '',
            ip: ipOverride || getClientIp(req),
        });

        if (req) req._activityLogged = true;
        return doc;
    } catch (err) {
        console.error('[recordActivity] failed:', err?.message || err);
        return null;
    }
}

/** Fire-and-forget wrapper so controllers do not await logging. */
export function recordActivityAsync(opts) {
    // Mark immediately so catch-all middleware / archive hooks skip duplicates
    // even though the DB write is async.
    if (opts?.req) opts.req._activityLogged = true;
    Promise.resolve()
        .then(() => recordActivity(opts))
        .catch((err) => console.error('[recordActivityAsync]', err?.message || err));
}

export function actorDisplayName(req) {
    return req?.user?.name || req?.user?.username || 'Someone';
}
