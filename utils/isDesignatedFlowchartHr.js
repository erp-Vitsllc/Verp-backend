import { getDepartmentHOD } from "./getDepartmentHOD.js";

/** True when the authenticated user's linked employee is the active Flowchart HR holder. */
export const isRequestUserDesignatedFlowchartHr = async (req) => {
    if (!req?.user?.employeeObjectId) return false;
    const hr = await getDepartmentHOD("hr");
    if (!hr?._id) return false;
    return String(hr._id) === String(req.user.employeeObjectId);
};
