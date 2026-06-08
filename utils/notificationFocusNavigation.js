/** Deep-link query helpers for HR informative emails (mirrors frontend focus navigation). */

const appendQuery = (path, key, value) => {
    if (!path || value == null || value === "") return path;
    const [base, hash = ""] = String(path).split("#");
    const sep = base.includes("?") ? "&" : "?";
    const withQuery = `${base}${sep}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
    return hash ? `${withQuery}#${hash}` : withQuery;
};

/** Append owner tab + focus card for scroll/highlight after notification navigation. */
export function buildCompanyPathWithFocus(path, { focusCard, ownerTab } = {}) {
    let out = String(path || "");
    if (Number.isInteger(ownerTab) && ownerTab >= 0) {
        out = appendQuery(out, "ownerTab", ownerTab);
    }
    if (focusCard) {
        out = appendQuery(out, "focusCard", focusCard);
    }
    return out;
}

export function extractNotificationLabelText(text = "") {
    const raw = String(text || "").trim();
    const prefix = "Expiry follow-up required:";
    const withoutPrefix = raw.toLowerCase().startsWith(prefix.toLowerCase())
        ? raw.slice(prefix.length).trim()
        : raw;
    return withoutPrefix.replace(/\s*\(Exp:\s*[^)]+\)\s*$/i, "").trim();
}

/** Map label → employee basic/doc section element id (focusCard query value). */
export function resolveEmployeeFocusElementId(label = "") {
    const l = extractNotificationLabelText(label).toLowerCase();
    if (!l) return null;
    if (l.includes("passport")) return "passport";
    if (
        l.includes("visit visa") ||
        l.includes("employment visa") ||
        l.includes("spouse visa") ||
        l.includes("visa")
    ) {
        return "visa";
    }
    if (l.includes("emirates") || l.includes("eid")) return "emirates-id";
    if (l.includes("labour")) return "labour-card";
    if (l.includes("medical")) return "medical-insurance";
    if (l.includes("driving")) return "driving-license";
    if (l.includes("basic detail")) return "basic-details";
    if (
        l.includes("document with expiry") ||
        l.includes("moa") ||
        l.includes("memo") ||
        l.includes("certificate")
    ) {
        const slug = l.replace(/\s+/g, "-");
        return `doc-${slug}`;
    }
    return null;
}

export function buildEmployeePathWithFocus(basePath, label = "") {
    const id = resolveEmployeeFocusElementId(label);
    if (!id) return basePath;
    const withoutHash = String(basePath || "").split("#")[0];
    return appendQuery(withoutHash, "focusCard", id);
}
