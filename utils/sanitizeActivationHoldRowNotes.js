/**
 * Optional per-queue-row notes from HR on partial hold (entryId -> text).
 * Only keys listed in allowedEntryIds are kept; empty strings omitted.
 */
export function sanitizeActivationHoldRowNotes(raw, allowedEntryIds = []) {
    const ids = [...new Set((allowedEntryIds || []).map(String))].filter(Boolean);
    if (!ids.length) return undefined;
    if (!raw || typeof raw !== "object") return undefined;
    const out = {};
    for (const sid of ids) {
        const v = raw[sid];
        if (v == null) continue;
        const t = String(v).trim();
        if (t) out[sid] = t.slice(0, 4000);
    }
    return Object.keys(out).length ? out : undefined;
}
