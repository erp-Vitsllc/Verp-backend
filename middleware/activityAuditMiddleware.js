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
    // /api/Employee/EMP-001 or /api/Fine/64f...
    if (parts.length >= 3) {
        const candidate = parts[2];
        if (candidate && !['access', 'tree', 'meta', 'items', 'list', 'stats'].includes(candidate.toLowerCase())) {
            return candidate;
        }
    }
    return '';
}

function buildViewHref(rule, path, body) {
    const id =
        body?.employee?.employeeId ||
        body?.employeeId ||
        body?.fine?._id ||
        body?.reward?._id ||
        body?.company?._id ||
        body?.item?._id ||
        body?._id ||
        extractIdFromPath(path);

    if (rule.entityType === 'Employee' && id) return `/emp/${encodeURIComponent(String(id))}`;
    if (rule.entityType === 'Fine' && id) return `/HRM/Fine/${encodeURIComponent(String(id))}`;
    if (rule.entityType === 'Reward' && id) return `/HRM/Reward`;
    if (rule.entityType === 'Company' && id) return `/Company/${encodeURIComponent(String(id))}`;
    if (rule.entityType === 'DeletedRecord' && id) return `/Settings/DeletedRecords?item=${encodeURIComponent(String(id))}`;
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
                const entityId =
                    body?.employee?.employeeId ||
                    body?.employeeId ||
                    body?.fine?._id ||
                    body?.reward?._id ||
                    body?.company?._id ||
                    body?.item?._id ||
                    body?._id ||
                    extractIdFromPath(path) ||
                    '';

                const nameHint =
                    [body?.employee?.firstName, body?.employee?.lastName].filter(Boolean).join(' ') ||
                    body?.employee?.name ||
                    body?.fine?.employeeName ||
                    body?.reward?.title ||
                    body?.company?.name ||
                    body?.item?.name ||
                    body?.message ||
                    '';

                const entityLabel = humanLabel(rule.entityType);
                const verb = verbForAction(action);
                const summary = nameHint && !String(nameHint).toLowerCase().includes('success')
                    ? `${verb} ${entityLabel} ${String(nameHint).slice(0, 120)}`
                    : `${verb} ${entityLabel}${entityId ? ` ${entityId}` : ''}`;

                recordActivityAsync({
                    req,
                    module: rule.module,
                    action,
                    entityType: rule.entityType,
                    entityId,
                    summary,
                    viewHref: buildViewHref(rule, path, body),
                    metadata: { auto: true },
                });
            }
        } catch (err) {
            console.error('[activityAuditMiddleware]', err?.message || err);
        }
        return originalJson(body);
    };

    return next();
}
