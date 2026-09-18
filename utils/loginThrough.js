/** Portal App / Web login flags. Unset until someone checks them on the profile. */

export const ACCESS_CONTROL_PATCH_KEYS = ["loginThrough", "enablePortalAccess"];

export function normalizeLoginThrough(source) {
    const stored = source?.loginThrough;
    if (!stored || typeof stored !== 'object') {
        return { portalApp: false, web: false };
    }
    return {
        portalApp: stored.portalApp === true,
        web: stored.web === true,
    };
}

/** True when the employee can sign in on at least one channel (Web or Portal App). */
export function canLoginThroughAnyChannel(source) {
    const through = normalizeLoginThrough(source);
    return through.portalApp === true || through.web === true;
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
