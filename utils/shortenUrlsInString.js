/**
 * Builds a single-line attachment summary for activation requests.
 * Never embeds full storage URLs — keeps notifications and emails readable.
 */
export const formatActivationAttachmentLine = (attachment, attachmentName) => {
    const raw = attachment != null ? String(attachment).trim() : "";
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) {
        const name = attachmentName != null ? String(attachmentName).trim() : "";
        if (name) return `Attachment: ${name}`;
        try {
            const seg = new URL(raw).pathname.split("/").filter(Boolean).pop();
            if (seg) {
                try {
                    return `Attachment: ${decodeURIComponent(seg)}`;
                } catch {
                    return `Attachment: ${seg}`;
                }
            }
        } catch {
            /* ignore */
        }
        return "Attachment: uploaded";
    }
    return `Attachment: ${raw}`;
};

/**
 * Collapses http(s) URLs to a short label (last path segment) so dashboard / email text stays readable.
 */
export const shortenUrlsInString = (input) => {
    if (input == null || typeof input !== "string") return "";
    return input.replace(/https?:\/\/[^\s|]+/gi, (raw) => {
        try {
            const { pathname } = new URL(raw);
            const seg = pathname.split("/").filter(Boolean).pop();
            if (seg) {
                try {
                    return decodeURIComponent(seg);
                } catch {
                    return seg;
                }
            }
        } catch {
            /* invalid URL */
        }
        return "[link]";
    });
};
