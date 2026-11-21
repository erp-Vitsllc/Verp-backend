import { httpError } from './http.js';

export const PDF_MAX_BYTES = 5 * 1024 * 1024;

function payloadOf(data) {
    const text = String(data || '').trim();
    const comma = text.indexOf(',');
    return (comma >= 0 ? text.slice(comma + 1) : text).replace(/\s/g, '');
}

function byteLength(payload) {
    if (!payload) return 0;
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return Math.floor((payload.length * 3) / 4) - padding;
}

/** Reject a newly uploaded attachment unless it is a real PDF of 5 MB or less. */
export function assertPdfAttachment(incoming) {
    const data = incoming?.data || incoming?.base64 || '';
    if (!data) return;
    const name = String(incoming?.name || incoming?.fileName || '').toLowerCase();
    const mime = String(incoming?.mimeType || incoming?.mime || '').toLowerCase();
    const header = String(data).slice(0, 80).toLowerCase();
    const looksPdf = mime === 'application/pdf'
        || name.endsWith('.pdf')
        || header.startsWith('data:application/pdf');
    if (!looksPdf) throw httpError(400, 'Only PDF files are allowed (max 5 MB).');

    const payload = payloadOf(data);
    const bytes = byteLength(payload);
    if (!Number.isFinite(bytes) || bytes <= 0) throw httpError(400, 'Could not read the PDF.');
    if (bytes > PDF_MAX_BYTES) throw httpError(400, 'PDF must be 5 MB or less.');

    const head = Buffer.from(payload.slice(0, 24), 'base64').subarray(0, 5).toString('latin1');
    if (!head.startsWith('%PDF')) throw httpError(400, 'Only PDF files are allowed (max 5 MB).');
}
