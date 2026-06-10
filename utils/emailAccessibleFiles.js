import axios from "axios";
import { isValidStorageUrl } from "../config/storageConfig.js";
import { getSignedFileUrl, normalizeS3Key, s3ObjectExists } from "./s3Upload.js";

/** Internal fetch TTL when downloading files for email attachments (never exposed in HTML). */
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

function displayNameFromRef(raw) {
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith("data:")) return null;
        try {
            if (/^https?:\/\//i.test(trimmed)) {
                const seg = new URL(trimmed).pathname.split("/").filter(Boolean).pop();
                if (seg) return decodeURIComponent(seg);
            }
        } catch {
            /* ignore */
        }
        return trimmed.split("/").filter(Boolean).pop() || "File";
    }
    if (raw && typeof raw === "object") {
        const name = raw.name || raw.fileName;
        if (name && String(name).trim()) return String(name).trim();
        const key = raw.storageKey || raw.publicId || raw.key || raw.url || raw.href || null;
        if (key) return String(key).split("/").filter(Boolean).pop() || "File";
    }
    return null;
}

function storageKeyFromRef(raw) {
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        return trimmed && !trimmed.startsWith("data:") ? trimmed : null;
    }
    if (raw && typeof raw === "object") {
        return raw.storageKey || raw.publicId || raw.key || raw.url || raw.href || null;
    }
    return null;
}

/** File metadata for email HTML — never includes storage or presigned URLs. */
export async function resolveEmailFileLinksForHtml(attachments = []) {
    const list = Array.isArray(attachments) ? attachments : [attachments];
    const out = [];

    for (const raw of list) {
        const key = storageKeyFromRef(raw);
        if (!key) continue;
        const name = displayNameFromRef(raw) || "File";
        out.push({
            name,
            storageKey: normalizeS3Key(key) || key,
        });
    }

    return out;
}

/** Plain-text attachment line for activation / workflow emails (no storage links). */
export function renderEmailAttachmentLineHtml(fileName, { attached = true } = {}) {
    const label = escapeHtml(fileName || "Attachment");
    const note = attached
        ? " — attached to this email"
        : " — open the VeRP link below to view in the application";
    return `<p style="margin:6px 0 0;font-size:13px;color:#334155;"><strong>Attachment:</strong> ${label}<span style="color:#64748b;">${note}</span></p>`;
}

export function renderEmailFileListHtml(files = [], { showAttachHint = true } = {}) {
    const list = Array.isArray(files) ? files.filter((f) => f?.name || f?.storageKey) : [];
    if (!list.length) {
        return `<p style="margin:6px 0 0;font-size:12px;color:#64748b;">No file on record for this change.</p>`;
    }

    const items = list
        .map((f) => {
            const label = escapeHtml(f.name || "File");
            return `<li style="margin:4px 0;color:#1e293b;">${label}</li>`;
        })
        .join("");

    const hint = showAttachHint
        ? `<p style="margin:8px 0 0;font-size:11px;color:#475569;">These files are <strong>attached to this email</strong>. Use the VeRP button below to review changes in the application — storage links are not included in email for security.</p>`
        : `<p style="margin:8px 0 0;font-size:11px;color:#475569;">Open the VeRP link in this email to view files in the application.</p>`;

    return `
        <div style="margin:8px 0 0;padding:10px 12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;">
            <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#1e40af;">File${list.length === 1 ? "" : "s"} (${list.length})</p>
            <ul style="margin:0;padding-left:18px;">${items}</ul>
            ${hint}
        </div>`;
}

/** Build nodemailer attachments from a single activation/workflow upload reference. */
export async function buildEmailAttachmentsFromRef(attachment, attachmentName) {
    const raw = attachment != null ? String(attachment).trim() : "";
    if (!raw || raw.startsWith("data:")) return [];
    const name = attachmentName && String(attachmentName).trim() ? String(attachmentName).trim() : undefined;
    if (/^https?:\/\//i.test(raw) && !isValidStorageUrl(raw)) return [];
    return buildInlineEmailAttachments([{ url: raw, storageKey: raw, name }], 1);
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
