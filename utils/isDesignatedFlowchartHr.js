import { getDepartmentHOD } from "./getDepartmentHOD.js";

/** True when the authenticated user's linked employee is the active Flowchart HR holder. */
export const isRequestUserDesignatedFlowchartHr = async (req) => {
    if (!req?.user?.employeeObjectId) return false;
    const hr = await getDepartmentHOD("hr");
    if (!hr?._id) return false;
    return String(hr._id) === String(req.user.employeeObjectId);
};

/** True when `actor` (e.g. req.user) is the same employee as the resolved Flowchart HR document. */
export const isActorDesignatedFlowchartHr = (actor, hrEmployee) => {
    if (!actor || !hrEmployee?._id) return false;
    const actorEmpId = actor.employeeObjectId || actor._id;
    if (!actorEmpId) return false;
    return String(actorEmpId) === String(hrEmployee._id);
};
