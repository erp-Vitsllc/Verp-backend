import axios from "axios";
import { getSignedFileUrl, normalizeS3Key, s3ObjectExists } from "./s3Upload.js";

/** Signed download links in email HTML — valid 7 days. */
export const EMAIL_FILE_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

const MAX_INLINE_ATTACHMENTS = 8;
const MAX_FETCH_BYTES = 10 * 1024 * 1024;

const escapeHtml = (value = "") =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

function isBlockedHost(url) {
    return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(String(url || ""));
}

function isFetchableHttpsUrl(url) {
    if (typeof url !== "string") return false;
    const u = url.trim();
    if (!u.startsWith("https://")) return false;
    return !isBlockedHost(u);
}

function guessFilename(urlOrKey, preferredName, index) {
    if (preferredName && String(preferredName).trim()) {
        return String(preferredName).trim();
    }
    try {
        if (String(urlOrKey).startsWith("http")) {
            const path = new URL(urlOrKey).pathname;
            const base = path.split("/").filter(Boolean).pop();
            if (base && base.includes(".")) return decodeURIComponent(base);
        }
        const base = String(urlOrKey).split("/").filter(Boolean).pop();
        if (base && base.includes(".")) return decodeURIComponent(base);
    } catch {
        /* ignore */
    }
    return `file-${index + 1}.pdf`;
}

async function resolveFetchUrl(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    if (isFetchableHttpsUrl(s)) return s;
    if (s.startsWith("http://")) return null;
    try {
        const signed = await getSignedFileUrl(s, EMAIL_FILE_LINK_TTL_SECONDS);
        return isFetchableHttpsUrl(signed) ? signed : null;
    } catch {
        return null;
    }
}

/**
 * Build nodemailer attachments users can open directly from their inbox.
 * @param {{ url?: string, name?: string, storageKey?: string }[]} fileRefs
 */
export async function buildInlineEmailAttachments(fileRefs = [], maxCount = MAX_INLINE_ATTACHMENTS) {
    const list = Array.isArray(fileRefs) ? fileRefs : [fileRefs];
    const seen = new Set();
    const attachments = [];
    let index = 0;

    for (const file of list) {
        if (attachments.length >= maxCount) break;
        const raw = file?.storageKey || file?.url || file?.key;
        if (!raw) continue;
        const dedupeKey = normalizeS3Key(raw) || String(raw).split("?")[0];
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const key = normalizeS3Key(raw);
        if (key && !(await s3ObjectExists(key))) continue;

        const fetchUrl = await resolveFetchUrl(raw);
        if (!fetchUrl) continue;

        try {
            const response = await axios.get(fetchUrl, {
                responseType: "arraybuffer",
                timeout: 15_000,
                maxContentLength: MAX_FETCH_BYTES,
                maxBodyLength: MAX_FETCH_BYTES,
            });
            const content = Buffer.from(response.data);
            if (!content.length) continue;
            attachments.push({
                filename: guessFilename(raw, file?.name, index),
                content,
                contentDisposition: "attachment",
            });
            index += 1;
        } catch (e) {
            console.warn("[buildInlineEmailAttachments] fetch failed:", e?.message || e);
        }
    }

    return attachments;
}

/**
 * Resolve user-clickable file links for email HTML (long-lived signed URLs).
 */
export async function resolveEmailFileLinksForHtml(attachments = []) {
    const list = Array.isArray(attachments) ? attachments : [attachments];
    const out = [];

    for (const raw of list) {
        let name = "File";
        let key = null;

        if (typeof raw === "string") {
            const trimmed = raw.trim();
            if (!trimmed || trimmed.startsWith("data:")) continue;
            key = trimmed;
            name = trimmed.split("/").pop() || "File";
        } else if (raw && typeof raw === "object") {
            name = raw.name || raw.fileName || "File";
            key = raw.storageKey || raw.publicId || raw.key || raw.url || raw.href || null;
            if (!key && raw.url) key = raw.url;
            if (key && !name) name = String(key).split("/").pop() || "File";
        }

        if (!key) continue;
        const signed = await getSignedFileUrl(key, EMAIL_FILE_LINK_TTL_SECONDS);
        out.push({
            name: name || "File",
            url: signed || key,
            storageKey: normalizeS3Key(key) || key,
        });
    }

    return out;
}

export function renderEmailFileListHtml(files = [], { showAttachHint = true } = {}) {
    const list = Array.isArray(files) ? files.filter((f) => f?.url || f?.name) : [];
    if (!list.length) {
        return `<p style="margin:6px 0 0;font-size:12px;color:#64748b;">No file on record for this change.</p>`;
    }

    const items = list
        .map((f) => {
            const label = escapeHtml(f.name || "Download file");
            const href = escapeHtml(f.url || "#");
            return `<li style="margin:4px 0;"><a href="${href}" style="color:#2563eb;font-weight:500;text-decoration:underline;">${label}</a></li>`;
        })
        .join("");

    const hint = showAttachHint
        ? `<p style="margin:8px 0 0;font-size:11px;color:#475569;">These files are <strong>attached to this email</strong> so you can open them from your inbox. Links above stay valid for 7 days.</p>`
        : `<p style="margin:8px 0 0;font-size:11px;color:#475569;">Download links stay valid for 7 days.</p>`;

    return `
        <div style="margin:8px 0 0;padding:10px 12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;">
            <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#1e40af;">File${list.length === 1 ? "" : "s"} (${list.length})</p>
            <ul style="margin:0;padding-left:18px;">${items}</ul>
            ${hint}
        </div>`;
}

export function renderEmailPrimaryButton(href, label, color = "#0f766e") {
    const safeHref = escapeHtml(href || "#");
    const safeLabel = escapeHtml(label || "Open in VeRP");
    return `<a href="${safeHref}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:700;font-size:14px;">${safeLabel}</a>`;
}

export function renderEmailSiteFooter(siteHost = "") {
    const host = escapeHtml(siteHost || "VeRP");
    return `<p style="font-size:12px;color:#64748b;margin:16px 0 0;line-height:1.5;">Sent through VeRP (${host}). If a button or link does not open, sign in at the same site or use any file attached to this email.</p>`;
}
