import nodemailer from "nodemailer";

const PATCH_FLAG = "__verpEmailSubjectTagPatched";

const parseUrlHostname = (rawUrl = "") => {
    try {
        return new URL(rawUrl).hostname.toLowerCase();
    } catch {
        return "";
    }
};

const getCurrentDomain = () => {
    const explicit = (process.env.EMAIL_TAG_DOMAIN || "").trim().toLowerCase();
    if (explicit) return explicit;

    const frontendHost = parseUrlHostname((process.env.FRONTEND_URL || "").trim());
    if (frontendHost) return frontendHost;

    const backendHost = parseUrlHostname((process.env.BACKEND_URL || "").trim());
    if (backendHost) return backendHost;

    return "";
};

const parseDomainTagMap = () => {
    const raw = (process.env.EMAIL_SUBJECT_TAG_MAP || "").trim();
    if (!raw) return {};

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }

        return Object.entries(parsed).reduce((acc, [domain, tag]) => {
            const domainKey = String(domain || "").trim().toLowerCase();
            const tagText = String(tag || "").trim();
            if (domainKey && tagText) {
                acc[domainKey] = tagText;
            }
            return acc;
        }, {});
    } catch (error) {
        console.warn("[email-tag] Invalid EMAIL_SUBJECT_TAG_MAP JSON. Ignoring map.");
        return {};
    }
};

const resolveEmailSubjectTag = () => {
    const explicitTag = (process.env.EMAIL_SUBJECT_TAG || "").trim();
    if (explicitTag) return explicitTag;

    const domainTagMap = parseDomainTagMap();
    const domain = getCurrentDomain();
    if (domain && domainTagMap[domain]) {
        return domainTagMap[domain];
    }

    const isLocal =
        process.env.NODE_ENV !== "production" ||
        domain === "localhost" ||
        domain === "127.0.0.1";

    return isLocal ? "local-server" : "";
};

const appendTagToSubject = (subject, tag) => {
    const normalizedTag = String(tag || "").trim();
    if (!normalizedTag) return String(subject || "").trim();

    const normalizedSubject = String(subject || "").trim();
    const marker = `(${normalizedTag})`;

    if (!normalizedSubject) return marker;
    if (normalizedSubject.includes(marker)) return normalizedSubject;
    return `${normalizedSubject} ${marker}`;
};

export const setupEmailSubjectTag = () => {
    if (nodemailer[PATCH_FLAG]) {
        return;
    }

    const originalCreateTransport = nodemailer.createTransport.bind(nodemailer);
    nodemailer.createTransport = (...args) => {
        const transporter = originalCreateTransport(...args);
        const originalSendMail = transporter.sendMail.bind(transporter);

        transporter.sendMail = (mailOptions = {}, ...rest) => {
            const tag = resolveEmailSubjectTag();
            if (!tag) {
                return originalSendMail(mailOptions, ...rest);
            }

            const nextMailOptions = {
                ...mailOptions,
                subject: appendTagToSubject(mailOptions?.subject, tag),
            };

            return originalSendMail(nextMailOptions, ...rest);
        };

        return transporter;
    };

    nodemailer[PATCH_FLAG] = true;

    const activeTag = resolveEmailSubjectTag();
    if (activeTag) {
        console.log(`[email-tag] Subject tag enabled: (${activeTag})`);
    } else {
        console.log("[email-tag] Subject tag disabled.");
    }
};
