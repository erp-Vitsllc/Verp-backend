import EmployeeBasic from '../models/EmployeeBasic.js';

const escapeRegExp = (value) => {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// Build an "exact match ignoring whitespace" regex for employeeId.
const buildWhitespaceAgnosticExactRegex = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    const pattern = parts.map(p => escapeRegExp(p)).join('\\s*');
    return new RegExp(`^${pattern}$`, 'i');
};

/**
 * Ensure flowchart asset controller has EmployeeBasic _id (for actionRequiredBy + DashboardAction.assignedTo).
 */
export async function resolveAssetControllerEmployee(assetController) {
    if (!assetController) return null;
    if (assetController._id) {
        // Ensure we have enough fields for dashboard + email fallback logic.
        const emp = await EmployeeBasic.findById(assetController._id)
            .select('_id employeeId firstName lastName companyEmail workEmail personalEmail email primaryReportee')
            .populate('primaryReportee', 'companyEmail workEmail personalEmail email')
            .lean()
            .catch(() => null);
        return emp || assetController;
    }
    if (!assetController.employeeId) return assetController;
    const safeEmployeeIdRegex = buildWhitespaceAgnosticExactRegex(assetController.employeeId);
    if (!safeEmployeeIdRegex) return assetController;

    const emp = await EmployeeBasic.findOne({
        employeeId: { $regex: safeEmployeeIdRegex }
    })
        .select('_id employeeId firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
        .populate('primaryReportee', 'companyEmail workEmail personalEmail email')
        .lean();
    if (!emp) return assetController;
    return { ...assetController, ...emp };
}

/** Prefer employee directory name for dashboard / email "requested by". */
export async function getAssetRequesterDisplayName(req) {
    const fallback = (req.user?.name && String(req.user.name).trim()) || 'System';
    try {
        if (req.user?.employeeObjectId) {
            const emp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName').lean();
            if (emp) {
                const n = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
                if (n) return n;
            }
        }
        if (req.user?.employeeId) {
            const safeEmployeeIdRegex = buildWhitespaceAgnosticExactRegex(req.user.employeeId);
            if (!safeEmployeeIdRegex) return fallback;

            const emp = await EmployeeBasic.findOne({
                employeeId: { $regex: safeEmployeeIdRegex }
            })
                .select('firstName lastName')
                .lean();
            if (emp) {
                const n = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
                if (n) return n;
            }
        }
    } catch (e) {
        /* use fallback */
    }
    return fallback;
}
