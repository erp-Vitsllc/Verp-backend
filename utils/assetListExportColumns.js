/**
 * Shared column keys for Asset List PDF/Excel export.
 * Serial No is always included by the generators; these are selectable data columns.
 */
export const ASSET_LIST_EXPORT_COLUMN_DEFS = [
    { key: 'assignedTo', label: 'Assigned to', weight: 1.25 },
    { key: 'assetType', label: 'Asset Type', weight: 1 },
    { key: 'category', label: 'Category', weight: 1 },
    { key: 'assetName', label: 'Asset Name', weight: 1.25 },
    { key: 'accessories', label: 'Accessories', weight: 1.35 },
    { key: 'assetId', label: 'Asset ID', weight: 1.1 },
    { key: 'qty', label: 'QTY', weight: 0.55 },
    { key: 'value', label: 'Value (AED)', weight: 0.95 },
];

/** Classic ASSET LIST template columns (no type/category) — used when `columns` is omitted. */
export const ASSET_LIST_CLASSIC_COLUMN_KEYS = [
    'assignedTo',
    'assetName',
    'accessories',
    'assetId',
    'qty',
    'value',
];

const ALLOWED_KEYS = new Set(ASSET_LIST_EXPORT_COLUMN_DEFS.map((c) => c.key));

/**
 * Parse `columns` from query/body. Returns null when omitted (classic layout).
 * @param {string|string[]|undefined|null} raw
 * @returns {string[]|null}
 */
export function parseAssetListExportColumns(raw) {
    if (raw == null || raw === '') return null;

    const tokens = (Array.isArray(raw) ? raw.flatMap((v) => String(v).split(',')) : String(raw).split(','))
        .map((s) => s.trim())
        .filter(Boolean);

    const seen = new Set();
    const keys = [];
    for (const token of tokens) {
        if (!ALLOWED_KEYS.has(token) || seen.has(token)) continue;
        seen.add(token);
        keys.push(token);
    }
    return keys.length ? keys : null;
}

/**
 * Resolve ordered column defs for export.
 * @param {string[]|null} columnKeys
 */
export function resolveAssetListExportColumns(columnKeys) {
    const keys = columnKeys?.length ? columnKeys : ASSET_LIST_CLASSIC_COLUMN_KEYS;
    const byKey = new Map(ASSET_LIST_EXPORT_COLUMN_DEFS.map((c) => [c.key, c]));
    return keys.map((key) => byKey.get(key)).filter(Boolean);
}

export function formatAccessoriesCell(accessories) {
    if (!accessories?.length) return 'NO ACC';
    return accessories.map((acc, idx) => `${idx + 1}. ${acc?.name || '—'}`).join('; ');
}
