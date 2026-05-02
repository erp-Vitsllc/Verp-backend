import EmployeeBasic from "../models/EmployeeBasic.js";

/**
 * EmployeeBasic _id for the portal user submitting activation (req.user after `protect`).
 * Uses linked `employeeObjectId`, else resolves by `req.user.employeeId`.
 */
export async function resolveProfileActivationSubmitterId(req) {
    const direct = req.user?.employeeObjectId || req.user?.empObjectId;
    if (direct) return direct;

    const eid = req.user?.employeeId;
    if (!eid || !String(eid).trim()) return null;

    let emp = await EmployeeBasic.findOne({ employeeId: String(eid).trim() }).select("_id").lean();
    if (!emp) {
        const userNorm = String(eid)
            .toLowerCase()
            .replace(/\s+/g, "");
        if (userNorm) {
            emp = await EmployeeBasic.findOne({
                $expr: {
                    $eq: [
                        {
                            $replaceAll: {
                                input: { $toLower: { $ifNull: ["$employeeId", ""] } },
                                find: " ",
                                replacement: "",
                            },
                        },
                        userNorm,
                    ],
                },
            })
                .select("_id")
                .lean();
        }
    }
    return emp?._id || null;
}
