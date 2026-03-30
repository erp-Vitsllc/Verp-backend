import EmployeeBasic from '../models/EmployeeBasic.js';

/**
 * Ensure flowchart asset controller has EmployeeBasic _id (for actionRequiredBy + DashboardAction.assignedTo).
 */
export async function resolveAssetControllerEmployee(assetController) {
    if (!assetController) return null;
    if (assetController._id) return assetController;
    if (!assetController.employeeId) return assetController;
    const emp = await EmployeeBasic.findOne({
        employeeId: { $regex: new RegExp(`^${String(assetController.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
    })
        .select('_id employeeId firstName lastName companyEmail email')
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
            const emp = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
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
