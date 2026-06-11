import { getDepartmentHOD } from "./getDepartmentHOD.js";

const normEmpId = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, "");

/** True when the authenticated user's linked employee is the active Flowchart HR holder. */
export const isRequestUserDesignatedFlowchartHr = async (req) => {
    if (!req?.user) return false;
    const hr = await getDepartmentHOD("hr");
    if (!hr?._id) return false;

    const myObj = req.user.employeeObjectId || req.user.empObjectId;
    if (myObj && String(hr._id) === String(myObj)) return true;

    const myEid = String(req.user.employeeId || "").trim();
    if (myEid && hr.employeeId && normEmpId(hr.employeeId) === normEmpId(myEid)) return true;

    return false;
};

/** True when `actor` (e.g. req.user) is the same employee as the resolved Flowchart HR document. */
export const isActorDesignatedFlowchartHr = (actor, hrEmployee) => {
    if (!actor || !hrEmployee?._id) return false;
    const actorEmpId = actor.employeeObjectId || actor._id;
    if (!actorEmpId) return false;
    return String(actorEmpId) === String(hrEmployee._id);
};
