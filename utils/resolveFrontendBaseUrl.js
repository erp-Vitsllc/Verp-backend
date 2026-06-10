import { AsyncLocalStorage } from "node:async_hooks";

const stripTrailingSlash = (url = "") => String(url || "").replace(/\/+$/, "");

/** Per-request frontend base URL (set by Express middleware). */
const requestFrontendStore = new AsyncLocalStorage();

const isUsablePublicOrigin = (origin = "") => {
    const o = String(origin || "").trim();
    if (!o.startsWith("http://") && !o.startsWith("https://")) return false;
    try {
        const { hostname } = new URL(o);
        if (!hostname) return false;
        if (hostname === "localhost" || hostname === "127.0.0.1") {
            return process.env.NODE_ENV !== "production";
        }
        return true;
    } catch {
        return false;
    }
};

const envFrontendBaseUrl = () => {
    const env =
        process.env.FRONTEND_URL ||
        process.env.CLIENT_URL ||
        process.env.NEXT_PUBLIC_APP_URL ||
        "";
    return env ? stripTrailingSlash(env) : "";
};

/** Prefer browser origin / forwarded host so hosted sites never fall back to localhost. */
export function pickOriginFromRequest(req) {
    if (!req?.headers) return null;

    const origin = String(req.headers.origin || "").trim();
    if (isUsablePublicOrigin(origin)) return stripTrailingSlash(origin);

    const referer = String(req.headers.referer || "").trim();
    if (referer) {
        try {
            const fromReferer = new URL(referer).origin;
            if (isUsablePublicOrigin(fromReferer)) return stripTrailingSlash(fromReferer);
        } catch {
            /* ignore */
        }
    }

    const xfHost = String(req.headers["x-forwarded-host"] || "").split(",")[0]?.trim();
    if (xfHost && !/^localhost(:\d+)?$/i.test(xfHost) && !/^127\.0\.0\.1(:\d+)?$/i.test(xfHost)) {
        const xfProto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0]?.trim() || "https";
        return stripTrailingSlash(`${xfProto}://${xfHost}`);
    }

    const host = String(req.headers.host || "").trim();
    if (host && !/^localhost(:\d+)?$/i.test(host) && !/^127\.0\.0\.1(:\d+)?$/i.test(host)) {
        const proto =
            req.secure === true
                ? "https"
                : String(req.headers["x-forwarded-proto"] || "http").split(",")[0]?.trim() || "http";
        return stripTrailingSlash(`${proto}://${host}`);
    }

    return null;
}

/**
 * Resolve VeRP frontend base URL for links in emails and PDFs.
 * Order: explicit value → req origin → active request (ALS) → env → localhost (dev only).
 */
export function resolveFrontendBaseUrl(reqOrOrigin = null) {
    if (typeof reqOrOrigin === "string" && reqOrOrigin.startsWith("http")) {
        return stripTrailingSlash(reqOrOrigin);
    }

    if (reqOrOrigin && typeof reqOrOrigin === "object") {
        if (reqOrOrigin.frontendBaseUrl) {
            return stripTrailingSlash(reqOrOrigin.frontendBaseUrl);
        }
        const fromReq = pickOriginFromRequest(reqOrOrigin);
        if (fromReq) return fromReq;
    }

    const fromStore = requestFrontendStore.getStore();
    if (fromStore) return stripTrailingSlash(fromStore);

    const fromEnv = envFrontendBaseUrl();
    if (fromEnv) return fromEnv;

    return "http://localhost:3000";
}

/** Safe for embedding in single-quoted HTML attributes. */
export function emailFrontendUrl(reqOrOrigin = null) {
    return resolveFrontendBaseUrl(reqOrOrigin).replace(/'/g, "");
}

export function resolveFrontendHostLabel(reqOrOrigin = null) {
    try {
        return new URL(resolveFrontendBaseUrl(reqOrOrigin)).host;
    } catch {
        return "VeRP";
    }
}

export function withFrontendPath(path = "", reqOrOrigin = null) {
    const base = resolveFrontendBaseUrl(reqOrOrigin);
    const p = String(path || "").trim();
    if (!p) return base;
    if (p.startsWith("http://") || p.startsWith("https://")) return p;
    return `${base}${p.startsWith("/") ? p : `/${p}`}`;
}

/** Express middleware helper — run downstream handlers inside request URL context. */
export function runWithRequestFrontendBaseUrl(baseUrl, next) {
    return requestFrontendStore.run(stripTrailingSlash(baseUrl || ""), next);
}
