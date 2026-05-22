import { listDeletionAttachmentRefs } from './listDeletionAttachmentRefs.js';
import { inferAdminDeletionArchiveMeta } from './inferAdminDeletionArchive.js';

const SKIP_KEYS = new Set([
    '_id',
    '__v',
    'buffer',
    'assignedEmployees',
    'pendingReactivationChanges',
    'password',
    'refreshToken',
]);

const SKIP_SUFFIXES = ['.data', '.publicId', '.mimeType'];

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function humanizeKey(path) {
    const last = String(path || '').split('.').pop() || path;
    return String(last)
        .replace(/([A-Z])/g, ' $1')
        .replace(/[_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\w/, (c) => c.toUpperCase());
}

function formatPathLabel(path) {
    const parts = String(path || '')
        .split('.')
        .filter(Boolean)
        .map(humanizeKey);
    return parts.join(' · ') || 'Field';
}

function isSkippablePath(path) {
    if (SKIP_SUFFIXES.some((s) => path.endsWith(s))) return true;
    const lower = path.toLowerCase();
    if (lower.includes('password')) return true;
    return false;
}

function formatScalar(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    }
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s) return null;
        if (s.startsWith('data:')) return '(embedded file)';
        if (s.length > 500) return `${s.slice(0, 500)}…`;
        return s;
    }
    if (typeof value === 'number') return String(value);
    return String(value);
}

function isPlainObject(val) {
    return val != null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date);
}

function isAttachmentBlob(obj) {
    if (!isPlainObject(obj)) return false;
    return !!(obj.url || obj.publicId || obj.attachment);
}

function flattenPayloadRows(obj, rows, path = '', depth = 0) {
    if (depth > 12 || obj == null) return;

    if (Array.isArray(obj)) {
        if (obj.length === 0) return;
        obj.forEach((item, i) => flattenPayloadRows(item, rows, path ? `${path}[${i}]` : `[${i}]`, depth + 1));
        return;
    }

    if (!isPlainObject(obj)) {
        const formatted = formatScalar(obj);
        if (formatted != null && path && !isSkippablePath(path)) {
            rows.push({ label: formatPathLabel(path), value: formatted });
        }
        return;
    }

    if (isAttachmentBlob(obj)) {
        const name = obj.name || obj.fileName || '';
        const label = formatPathLabel(path || 'attachment');
        rows.push({
            label,
            value: name ? `File: ${name}` : '(uploaded file — see email attachments)',
        });
        return;
    }

    const entries = Object.entries(obj);
    if (!entries.length) return;

    for (const [key, val] of entries) {
        if (SKIP_KEYS.has(key)) continue;
        const nextPath = path ? `${path}.${key}` : key;
        if (isSkippablePath(nextPath)) continue;

        if (val == null || val === '') continue;

        if (isPlainObject(val) || Array.isArray(val)) {
            if (isAttachmentBlob(val)) {
                const name = val.name || val.fileName || '';
                rows.push({
                    label: formatPathLabel(nextPath),
                    value: name ? `File: ${name}` : '(uploaded file — see email attachments)',
                });
                continue;
            }
            flattenPayloadRows(val, rows, nextPath, depth + 1);
            continue;
        }

        const formatted = formatScalar(val);
        if (formatted != null) {
            rows.push({ label: formatPathLabel(nextPath), value: formatted });
        }
    }
}

/**
 * Whole-record / list deletes (employee, company, asset row, fine, etc.) — short email only.
 * Card/section deletes (labour card, passport, single document) — include field table in email.
 */
export function shouldShowDeletionFieldsInManagementEmail({ moduleName, deletedPayload } = {}) {
    if (deletedPayload?.complete != null && deletedPayload?.collections != null) {
        return false;
    }
    const meta = inferAdminDeletionArchiveMeta({ moduleName, deletedPayload });
    if (meta.category === 'list') return false;
    return true;
}

/**
 * HTML table of deleted record fields for management notification emails.
 * @param {object} deletedPayload
 */
export function buildAdminDeletionFieldsHtmlTable(deletedPayload) {
    if (deletedPayload == null) return '';

    const rows = [];
    flattenPayloadRows(deletedPayload, rows);
    if (!rows.length) return '';

    const body = rows
        .map(
            (r) =>
                `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;vertical-align:top;width:38%;font-size:13px;">${escapeHtml(r.label)}</td><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;">${escapeHtml(r.value)}</td></tr>`
        )
        .join('');

    return `
        <div style="margin-top:16px">
            <p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#334155">Deleted record fields</p>
            <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
                <tbody>${body}</tbody>
            </table>
        </div>`;
}

export function buildAdminDeletionAttachmentSummaryLine(deletedPayload) {
    const count = listDeletionAttachmentRefs(deletedPayload).length;
    if (!count) return '';
    return `<p style="font-size:12px;color:#64748b;">Uploaded file(s) from this record are attached (${count}). Open Deleted Records to view or download them from recovery.</p>`;
}
