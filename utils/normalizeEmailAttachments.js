import { pdfOutputToBuffer } from './generatePdf.js';

/**
 * Ensures PDF attachment content is a Buffer (Puppeteer may return Uint8Array) and sets MIME fields for SMTP clients.
 */
export function normalizePdfAttachments(attachments = []) {
    if (!Array.isArray(attachments) || attachments.length === 0) return [];
    const out = [];
    for (const a of attachments) {
        if (!a || a.content == null) continue;
        const content = pdfOutputToBuffer(a.content) || (Buffer.isBuffer(a.content) ? a.content : null);
        if (!content?.length) continue;
        out.push({
            filename: a.filename || 'attachment.pdf',
            content,
            contentType: a.contentType || 'application/pdf',
            contentDisposition: a.contentDisposition || 'attachment'
        });
    }
    return out;
}
