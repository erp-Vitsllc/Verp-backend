import EmployeeBasic from "../models/EmployeeBasic.js";

const SELECT_FIELDS =
    "_id employeeId firstName lastName designation companyEmail workEmail email personalEmail primaryReportee";

/**
 * Resolves submitter EmployeeBasic for profile activation emails and submitter dashboard rows.
 * Uses profileActivationSubmittedBy first, then a dashboard row with activationViewerRole "submitter".
 */
export async function resolveProfileActivationSubmitterEmployee(employee, pendingDashboardRows = []) {
    const findEmpByIdOrUserId = async (rawId) => {
        if (!rawId) return null;
        let emp = await EmployeeBasic.findById(String(rawId)).select(SELECT_FIELDS).lean();
        if (emp) return emp;
        const sid = String(rawId);
        if (!/^[0-9a-fA-F]{24}$/.test(sid)) return null;
        const User = (await import("../models/User.js")).default;
        const user = await User.findById(sid).select("employeeId").lean();
        if (!user?.employeeId) return null;
        emp = await EmployeeBasic.findOne({ employeeId: user.employeeId }).select(SELECT_FIELDS).lean();
        return emp || null;
    };

    const fromField =
        employee?.profileActivationSubmittedBy != null
            ? await findEmpByIdOrUserId(employee.profileActivationSubmittedBy)
            : null;
    if (fromField) return fromField;

    const rows = Array.isArray(pendingDashboardRows) ? pendingDashboardRows : [];
    for (const row of rows) {
        let role = null;
        try {
            role = JSON.parse(row.extra3 || "{}")?.activationViewerRole || null;
        } catch {
            /* ignore */
        }
        if (role === "submitter" && row.assignedTo) {
            const fromRow = await findEmpByIdOrUserId(row.assignedTo);
            if (fromRow) return fromRow;
        }
    }

    return null;
}
