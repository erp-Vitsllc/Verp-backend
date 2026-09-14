/** Portal App / Web login flags. Unset employees keep both on (legacy). */

export const ACCESS_CONTROL_PATCH_KEYS = ["loginThrough", "enablePortalAccess"];

export function normalizeLoginThrough(source) {
    const stored = source?.loginThrough;
    const hasStored =
        stored &&
        (typeof stored.portalApp === 'boolean' || typeof stored.web === 'boolean');
    if (!hasStored) {
        return { portalApp: true, web: true };
    }
    return {
        portalApp: stored.portalApp !== false,
        web: stored.web !== false,
    };
}

export function loginThroughFromBody(body, current) {
    const next = normalizeLoginThrough(current);
    const incoming = body?.loginThrough;
    if (!incoming || typeof incoming !== 'object') return next;
    if (typeof incoming.portalApp === 'boolean') next.portalApp = incoming.portalApp;
    if (typeof incoming.web === 'boolean') next.web = incoming.web;
    return next;
}

function pendingProposedPayload(entry) {
    if (!entry || typeof entry !== "object") return {};
    const proposed = entry.proposedData || entry.proposed || entry.newData || entry.toData;
    if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) return {};
    return proposed;
}

/** Login / portal flags are access settings — never HR activation queue rows. */
export function isAccessControlOnlyPendingEntry(entry) {
    const proposed = pendingProposedPayload(entry);
    const keys = Object.keys(proposed).filter((key) => proposed[key] !== undefined);
    if (keys.length === 0) return false;
    return keys.every((key) => ACCESS_CONTROL_PATCH_KEYS.includes(key));
}

export function accessControlSetFromPendingEntry(entry) {
    const proposed = pendingProposedPayload(entry);
    const set = {};
    if (proposed.loginThrough !== undefined) {
        set.loginThrough = normalizeLoginThrough({ loginThrough: proposed.loginThrough });
    }
    if (typeof proposed.enablePortalAccess === "boolean") {
        set.enablePortalAccess = proposed.enablePortalAccess;
    }
    return set;
}
