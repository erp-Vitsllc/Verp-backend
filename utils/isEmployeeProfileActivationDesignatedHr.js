import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import { hasPermission, isUserAdministrator } from "../services/permissionService.js";
import { isReqUserAdmin } from "./sendAdminDeletionNotificationEmails.js";

const normEmpId = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, "");

/**
 * User may perform HR activation actions (approve / hold / reject / direct HR activate),
 * aligned with the employee profile UI: designated HR, Flowchart HR, parent Employees edit, or admin.
 * Does NOT treat `hrm_employees_view_activation` Create alone as HR — that is for submitting only.
 */
export async function isEmployeeProfileActivationDesignatedHr(req, employee) {
    if (!req?.user) return false;

    if (await isReqUserAdmin(req.user)) return true;

    if (req.user.isAdmin === true || /^admin$/i.test(String(req.user.role || "").trim()) || req.user.role === "ROOT") {
        return true;
    }

    const userId = req.user.id;
    if (userId && (await isUserAdministrator(userId))) return true;

    if (userId && (await hasPermission(userId, "hrm_employees", "edit"))) return true;

    const myObj = req.user.employeeObjectId || req.user.empObjectId;
    const myObjStr = myObj ? String(myObj) : "";

    const submittedToRaw = employee?.profileSubmittedTo;
    const submittedToStr = submittedToRaw
        ? typeof submittedToRaw === "object"
            ? String(submittedToRaw._id || submittedToRaw)
            : String(submittedToRaw)
        : "";
    if (submittedToStr && myObjStr && submittedToStr === myObjStr) return true;

    const wf = Array.isArray(employee?.profileWorkflow) ? employee.profileWorkflow : [];
    const submittedStep = [...wf].reverse().find((w) => String(w?.status || "").toLowerCase() === "submitted");
    const assignedRaw = submittedStep?.assignedTo;
    const assignedStr = assignedRaw
        ? typeof assignedRaw === "object"
            ? String(assignedRaw._id || assignedRaw)
            : String(assignedRaw)
        : "";
    if (assignedStr && myObjStr && assignedStr === myObjStr) return true;

    const hrResolved = await resolveFlowchartHrEmployee();
    if (!hrResolved.error && hrResolved.employee?._id && myObjStr && String(hrResolved.employee._id) === myObjStr) {
        return true;
    }
    const myEid = String(req.user.employeeId || "").trim();
    if (!hrResolved.error && hrResolved.employee?.employeeId && myEid) {
        if (normEmpId(hrResolved.employee.employeeId) === normEmpId(myEid)) return true;
    }

    return false;
}
