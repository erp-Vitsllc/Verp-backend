import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";

/**
 * Get Employee Hierarchy
 * Returns a flat list of downstream employees who have a portal User account
 * (same people who can open a dashboard). Each entry includes `depth` relative
 * to the logged-in user. primaryReportee is re-pointed past any non-user
 * ancestors so the Team Performance tree stays connected.
 */
export const getHierarchy = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: "Unauthorized" });

        const manager = await EmployeeBasic.findOne({
            $or: [{ employeeId: currentUser.employeeId }, { companyEmail: currentUser.companyEmail }],
        }).select("_id firstName lastName employeeId designation department profilePicture");

        if (!manager) {
            return res.status(200).json({ hierarchy: [] });
        }

        const rows = await EmployeeBasic.aggregate([
            { $match: { _id: manager._id } },
            {
                $graphLookup: {
                    from: "employeebasics",
                    startWith: "$_id",
                    connectFromField: "_id",
                    connectToField: "primaryReportee",
                    as: "team",
                    depthField: "depth",
                },
            },
            { $unwind: "$team" },
            {
                $project: {
                    _id: "$team._id",
                    firstName: "$team.firstName",
                    lastName: "$team.lastName",
                    employeeId: "$team.employeeId",
                    designation: "$team.designation",
                    department: "$team.department",
                    profilePicture: "$team.profilePicture",
                    primaryReportee: "$team.primaryReportee",
                    depth: "$team.depth",
                },
            },
            { $sort: { depth: 1, firstName: 1 } },
        ]);

        const empIds = [
            ...new Set(
                rows
                    .map((r) => String(r.employeeId || "").trim())
                    .filter(Boolean),
            ),
        ];

        // Only employees with a linked portal User (login account).
        const usersWithAccounts = empIds.length
            ? await User.find({
                  employeeId: { $in: empIds },
                  status: { $nin: ["Inactive", "Suspended"] },
                  enablePortalAccess: { $ne: false },
              })
                  .select("employeeId")
                  .lean()
            : [];

        const accountEmpIds = new Set(
            usersWithAccounts.map((u) => String(u.employeeId || "").trim()).filter(Boolean),
        );

        const byId = new Map(rows.map((r) => [String(r._id), r]));
        const managerId = String(manager._id);

        const resolveUserAccountParent = (emp) => {
            let parentId = emp.primaryReportee != null ? String(emp.primaryReportee) : null;
            const visited = new Set();
            while (parentId) {
                if (visited.has(parentId)) return managerId;
                visited.add(parentId);
                if (parentId === managerId) return managerId;

                const parent = byId.get(parentId);
                if (!parent) return managerId;

                const parentEmpId = String(parent.employeeId || "").trim();
                if (parentEmpId && accountEmpIds.has(parentEmpId)) {
                    return parentId;
                }
                parentId = parent.primaryReportee != null ? String(parent.primaryReportee) : managerId;
            }
            return managerId;
        };

        // One row per employeeId (drops duplicate EmployeeBasic profiles that share an id).
        const seenEmpIds = new Set();
        const hierarchy = [];
        for (const row of rows) {
            const empId = String(row.employeeId || "").trim();
            if (!empId || !accountEmpIds.has(empId)) continue;
            if (seenEmpIds.has(empId)) continue;
            seenEmpIds.add(empId);

            hierarchy.push({
                _id: row._id,
                firstName: row.firstName,
                lastName: row.lastName,
                employeeId: row.employeeId,
                designation: row.designation,
                department: row.department,
                profilePicture: row.profilePicture,
                depth: row.depth,
                primaryReportee: resolveUserAccountParent(row),
                hasUserAccount: true,
            });
        }

        return res.status(200).json({
            manager,
            hierarchy,
        });
    } catch (error) {
        console.error("Get Hierarchy Error:", error);
        res.status(500).json({ message: "Failed to fetch hierarchy" });
    }
};
