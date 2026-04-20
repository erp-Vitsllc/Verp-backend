import User from "../../models/User.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";

// Returns employees that also have a linked user account.
export const getReporteeOptions = async (req, res) => {
    try {
        const { excludeEmployeeId } = req.query || {};

        const users = await User.find({
            employeeId: { $ne: null },
        })
            .select("employeeId status")
            .lean();

        const employeeIdSet = new Set(
            users
                .map((u) => String(u.employeeId || "").trim())
                .filter(Boolean)
        );

        if (excludeEmployeeId) {
            employeeIdSet.delete(String(excludeEmployeeId).trim());
        }

        const employeeIds = Array.from(employeeIdSet);
        if (employeeIds.length === 0) {
            return res.status(200).json({ options: [] });
        }

        const employees = await EmployeeBasic.find({
            employeeId: { $in: employeeIds },
        })
            .select("_id employeeId firstName lastName designation companyEmail workEmail email")
            .lean();

        const options = employees
            .map((emp) => {
                const fullName = `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.employeeId;
                return {
                    value: String(emp._id),
                    label: `${fullName} (${emp.designation || "No designation"})`,
                    email: emp.companyEmail || emp.workEmail || emp.email || "",
                    sortKey: fullName.toLowerCase(),
                };
            })
            .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
            .map(({ sortKey, ...rest }) => rest);

        return res.status(200).json({ options });
    } catch (error) {
        console.error("getReporteeOptions error:", error);
        return res.status(500).json({ message: "Failed to fetch reportee options." });
    }
};

