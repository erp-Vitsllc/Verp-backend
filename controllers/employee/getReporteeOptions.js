import User from "../../models/User.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { isEligibleReportee } from "../../utils/reporteeEligibility.js";

// Primary and secondary reportee lists: active profile, Web access, company email.
export const getReporteeOptions = async (req, res) => {
    try {
        const { excludeEmployeeId } = req.query || {};

        const users = await User.find({
            employeeId: { $ne: null },
            status: "Active",
        })
            .select("employeeId")
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
            status: { $ne: "Left User" },
            "loginThrough.web": true,
            companyEmail: { $regex: /\S/ },
            $or: [
                { profileStatus: "active" },
                { profileApprovalStatus: "active" },
                { "profileWorkflow.status": "active" },
            ],
        })
            .select("_id employeeId firstName lastName designation companyEmail profileStatus profileApprovalStatus profileWorkflow status loginThrough")
            .lean();

        const options = employees
            .filter((emp) => isEligibleReportee(emp))
            .map((emp) => {
                const fullName = `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.employeeId;
                return {
                    value: String(emp._id),
                    label: `${fullName} (${emp.designation || "No designation"})`,
                    email: String(emp.companyEmail || "").trim(),
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

