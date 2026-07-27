import { recordActivityAsync } from '../utils/activityLog.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Paths that should never produce activity rows (noise / auth / telemetry). */
const SKIP_PREFIXES = [
    '/api/Login',
    '/api/login',
    '/api/health',
    '/api/storage',
    '/api/locator',
    '/api/ActivityLog',
    '/api/document-ai',
];

const MODULE_RULES = [
    { test: /^\/api\/Employee/i, module: 'HRM', entityType: 'Employee', listHref: '/emp' },
    { test: /^\/api\/Fine/i, module: 'HRM', entityType: 'Fine', listHref: '/HRM/Fine' },
    { test: /^\/api\/Reward/i, module: 'HRM', entityType: 'Reward', listHref: '/HRM/Reward' },
    { test: /^\/api\/Payment/i, module: 'Accounts', entityType: 'Payment', listHref: '/Accounts/Payments' },
    { test: /^\/api\/Expense/i, module: 'Accounts', entityType: 'Expense', listHref: '/Accounts/Expenses' },
    { test: /^\/api\/UtilityBill/i, module: 'HRM', entityType: 'UtilityBill', listHref: '/HRM/Asset/UtilityBills' },
    { test: /^\/api\/Company/i, module: 'Company', entityType: 'Company', listHref: '/Company' },
    { test: /^\/api\/company/i, module: 'Company', entityType: 'Company', listHref: '/Company' },
    { test: /^\/api\/AssetItem/i, module: 'Assets', entityType: 'Asset', listHref: '/HRM/Asset' },
    { test: /^\/api\/AssetType/i, module: 'Assets', entityType: 'AssetType', listHref: '/HRM/Asset' },
    { test: /^\/api\/AssetAccessoryCatalog/i, module: 'Assets', entityType: 'AccessoryCatalog', listHref: '/HRM/Asset' },
    { test: /^\/api\/Department/i, module: 'HRM', entityType: 'Department', listHref: '/emp' },
    { test: /^\/api\/Designation/i, module: 'HRM', entityType: 'Designation', listHref: '/emp' },
    { test: /^\/api\/User/i, module: 'Settings', entityType: 'User', listHref: '/Settings/User' },
    { test: /^\/api\/Flowchart/i, module: 'Settings', entityType: 'Flowchart', listHref: '/Settings/FlowChart' },
    { test: /^\/api\/AdminDeletionArchive/i, module: 'Settings', entityType: 'DeletedRecord', listHref: '/Settings/DeletedRecords' },
    { test: /^\/api\/zoho/i, module: 'Accounts', entityType: 'Zoho', listHref: '/Accounts/Vendors' },
];

function shouldSkip(path) {
    const p = String(path || '').split('?')[0];
    if (!p.startsWith('/api/')) return true;
    return SKIP_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

function resolveRule(path) {
    const p = String(path || '').split('?')[0];
    return MODULE_RULES.find((r) => r.test.test(p)) || {
        module: 'General',
        entityType: 'Record',
        listHref: '',
    };
}

function actionFromMethod(method, path) {
    const p = String(path || '').toLowerCase();
    if (/\/approve/.test(p)) return 'approve';
    if (/\/reject/.test(p)) return 'reject';
    if (/\/restore/.test(p)) return 'restore';
    if (/\/assign/.test(p)) return 'assign';
    if (/\/unassign/.test(p)) return 'unassign';
    switch (String(method || '').toUpperCase()) {
        case 'POST':
            return 'create';
        case 'PUT':
        case 'PATCH':
            return 'update';
        case 'DELETE':
            return 'delete';
        default:
            return 'other';
    }
}

function verbForAction(action) {
    switch (action) {
        case 'create':
            return 'created';
        case 'update':
            return 'updated';
        case 'delete':
            return 'deleted';
        case 'approve':
            return 'approved';
        case 'reject':
            return 'rejected';
        case 'restore':
            return 'restored';
        case 'assign':
            return 'assigned';
        case 'unassign':
            return 'unassigned';
        default:
            return 'performed an action on';
    }
}

function extractIdFromPath(path) {
    const p = String(path || '').split('?')[0];
    const parts = p.split('/').filter(Boolean);
    // /api/Employee/EMP-001 or /api/Fine/64f... or /api/AssetItem/:id/...
    if (parts.length >= 3) {
        const candidate = parts[2];
        if (candidate && !['access', 'tree', 'meta', 'items', 'list', 'stats', 'bulk'].includes(candidate.toLowerCase())) {
            return candidate;
        }
    }
    return '';
}

function looksLikeObjectId(value) {
    return /^[a-fA-F0-9]{24}$/.test(String(value || '').trim());
}

function buildViewHref(rule, path, body, entityId = '') {
    const id =
        body?.employee?.employeeId ||
        body?.employeeId ||
        body?.fine?._id ||
        body?.reward?._id ||
        body?.company?._id ||
        body?.item?._id ||
        body?._id ||
        entityId ||
        extractIdFromPath(path);

    if (rule.entityType === 'Employee' && id) return `/emp/${encodeURIComponent(String(id))}`;
    if (rule.entityType === 'Fine' && id) return `/HRM/Fine/${encodeURIComponent(String(id))}`;
    if (rule.entityType === 'Reward' && id) return `/HRM/Reward`;
    if (rule.entityType === 'Company' && id) return `/Company/${encodeURIComponent(String(id))}`;
    if (rule.entityType === 'DeletedRecord' && id) return `/Settings/DeletedRecords?item=${encodeURIComponent(String(id))}`;
    if (rule.entityType === 'Asset' && id) {
        return `/HRM/Asset/Vehicle/details/${encodeURIComponent(String(id))}`;
    }
    return rule.listHref || '';
}

function humanLabel(entityType) {
    const map = {
        Employee: 'employee',
        Fine: 'fine',
        Reward: 'reward',
        Payment: 'payment',
        Expense: 'expense',
        UtilityBill: 'utility bill',
        Company: 'company',
        Asset: 'asset',
        AssetType: 'asset type',
        AccessoryCatalog: 'accessory catalog',
        Department: 'department',
        Designation: 'designation',
        User: 'user',
        Flowchart: 'flowchart',
        DeletedRecord: 'deleted record',
        Zoho: 'Zoho record',
        Record: 'record',
    };
    return map[entityType] || String(entityType || 'record').toLowerCase();
}

function pickAssetDisplayFromBody(body = {}) {
    const assetId = String(
        body?.assetId || body?.item?.assetId || body?.asset?.assetId || '',
    ).trim();
    const name = String(body?.name || body?.item?.name || body?.asset?.name || '').trim();
    const plate = [body?.plateEmirate || body?.item?.plateEmirate, body?.plateNumber || body?.item?.plateNumber]
        .filter(Boolean)
        .join(' ')
        .trim();
    if (!assetId && !name && !plate) return '';
    if (assetId && name) return `${assetId} · ${name}`;
    if (assetId && plate) return `${assetId} · ${plate}`;
    return assetId || name || plate;
}

async function resolveAssetDisplayLabel(entityId, body = {}) {
    const fromBody = pickAssetDisplayFromBody(body);
    if (fromBody) return fromBody;

    const id = String(entityId || '').trim();
    if (!id || !looksLikeObjectId(id)) return id;

    try {
        const AssetItem = (await import('../models/AssetItem.js')).default;
        const asset = await AssetItem.findById(id)
            .select('assetId name plateNumber plateEmirate')
            .lean();
        if (!asset) return id;
        const plate = [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(' ').trim();
        if (asset.assetId && asset.name) return `${asset.assetId} · ${asset.name}`;
        if (asset.assetId && plate) return `${asset.assetId} · ${plate}`;
        return asset.assetId || asset.name || id;
    } catch {
        return id;
    }
}

/**
 * Catch-all audit for successful mutating API calls.
 * Controllers that call recordActivity() set req._activityLogged to avoid duplicates.
 */
export function activityAuditMiddleware(req, res, next) {
    if (!MUTATING.has(String(req.method || '').toUpperCase())) {
        return next();
    }

    const path = req.originalUrl || req.url || '';
    if (shouldSkip(path)) {
        return next();
    }

    const originalJson = res.json.bind(res);
    res.json = function activityAuditJson(body) {
        try {
            const status = res.statusCode || 200;
            if (
                !req._activityLogged &&
                req.user &&
                status >= 200 &&
                status < 300
            ) {
                const rule = resolveRule(path);
                const action = actionFromMethod(req.method, path);
                const pathAssetId =
                    rule.entityType === 'Asset' ? extractIdFromPath(path) : '';
                const rawEntityId =
                    body?.employee?.employeeId ||
                    body?.employeeId ||
                    body?.fine?._id ||
                    body?.reward?._id ||
                    body?.company?._id ||
                    body?.item?._id ||
                    // AssetItem routes: prefer :id from URL (never history subdoc _id).
                    (rule.entityType === 'Asset'
                        ? pathAssetId || body?.asset?._id || body?._id
                        : body?._id) ||
                    extractIdFromPath(path) ||
                    '';

                // Prefer business id for assets (VEGA-VHCL-004), keep mongo id for links.
                const mongoIdForAsset =
                    rule.entityType === 'Asset'
                        ? String(pathAssetId || body?.asset?._id || '').trim()
                        : '';

                void (async () => {
                    let nameHint =
                        [body?.employee?.firstName, body?.employee?.lastName].filter(Boolean).join(' ') ||
                        body?.employee?.name ||
                        body?.fine?.employeeName ||
                        body?.reward?.title ||
                        body?.company?.name ||
                        body?.item?.name ||
                        '';

                    let entityId = String(rawEntityId || '');
                    let viewHref = buildViewHref(rule, path, body, mongoIdForAsset || entityId);

                    if (rule.entityType === 'Asset') {
                        const display = await resolveAssetDisplayLabel(
                            mongoIdForAsset || entityId,
                            body && typeof body === 'object' ? body : {},
                        );
                        if (display) nameHint = display;
                        // Store human-readable id when available; keep mongo in metadata for linking.
                        const businessId = String(
                            body?.assetId || body?.item?.assetId || '',
                        ).trim();
                        if (businessId) entityId = businessId;
                        else if (display && !looksLikeObjectId(display.split('·')[0].trim())) {
                            entityId = display.split('·')[0].trim();
                        }
                        if (mongoIdForAsset) {
                            viewHref = `/HRM/Asset/Vehicle/details/${encodeURIComponent(mongoIdForAsset)}`;
                        }
                    }

                    const entityLabel = humanLabel(rule.entityType);
                    const verb = verbForAction(action);
                    const summary =
                        nameHint && !String(nameHint).toLowerCase().includes('success')
                            ? `${verb} ${entityLabel} ${String(nameHint).slice(0, 120)}`
                            : `${verb} ${entityLabel}${entityId ? ` ${entityId}` : ''}`;

                    recordActivityAsync({
                        req,
                        module: rule.module,
                        action,
                        entityType: rule.entityType,
                        entityId,
                        summary,
                        viewHref,
                        metadata: {
                            auto: true,
                            ...(mongoIdForAsset ? { assetMongoId: mongoIdForAsset } : {}),
                            ...(nameHint ? { displayLabel: String(nameHint).slice(0, 160) } : {}),
                        },
                    });
                })();
            }
        } catch (err) {
            console.error('[activityAuditMiddleware]', err?.message || err);
        }
        return originalJson(body);
    };

    return next();
}
