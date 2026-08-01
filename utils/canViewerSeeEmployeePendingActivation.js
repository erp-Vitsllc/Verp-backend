import { isEmployeeProfileActivationDesignatedHr } from "./isEmployeeProfileActivationDesignatedHr.js";
import { isReqUserAdmin } from "./sendAdminDeletionNotificationEmails.js";
import { portalActorMatchesStoredId } from "./resolvePortalActorId.js";
import { pendingChangesIncludeLeftUser } from "./employeeLeftUserWorkflow.js";

const normEmpId = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, "");

function portalUserEmployeeObjectId(req) {
    return String(req?.user?.employeeObjectId || req?.user?.empObjectId || req?.user?.linkedEmployee || "").trim();
}

function viewerIsEmployeeProfileSubject(req, employee) {
    if (!req?.user || !employee) return false;
    const profObj = String(employee._id || "");
    const myObj = portalUserEmployeeObjectId(req);
    const myEid = normEmpId(req.user.employeeId);
    const profEid = normEmpId(employee.employeeId);
    const myUserId = String(req.user.id || req.user._id || "").trim();

    if (profObj && myObj && profObj === myObj) return true;
    if (profEid && myEid && profEid === myEid) return true;
    if (myUserId && profObj && myUserId === profObj) return true;

    const emails = new Set(
        [employee.email, employee.workEmail, employee.companyEmail, employee.personalEmail]
            .map((e) => String(e || "").toLowerCase().trim())
            .filter(Boolean),
    );
    const myEmails = [req.user.email, req.user.workEmail, req.user.companyEmail, req.user.personalEmail]
        .map((e) => String(e || "").toLowerCase().trim())
        .filter(Boolean);
    if (emails.size && myEmails.some((m) => emails.has(m))) return true;

    return false;
}

function viewerIsProfileActivationDraftEditor(req, employee) {
    if (!req?.user || !employee) return false;
    return portalActorMatchesStoredId(req, employee.profileActivationDraftEditor);
}

function viewerIsProfileActivationSubmitter(req, employee) {
    if (!req?.user || !employee) return false;
    if (!isProfileApprovalSubmitted(employee)) {
        if (viewerIsEmployeeProfileSubject(req, employee)) return true;
        if (viewerIsProfileActivationDraftEditor(req, employee)) return true;
    }
    const sid = employee.profileActivationSubmittedBy;
    if (sid && portalActorMatchesStoredId(req, sid)) return true;
    if (!sid) return viewerIsEmployeeProfileSubject(req, employee);
    return false;
}

function isProfileApprovalSubmitted(employee) {
    return String(employee?.profileApprovalStatus || "draft").toLowerCase() === "submitted";
}

/** Strip pending queue / hold from API when viewer must not see draft-only changes. */
export async function canViewerSeeEmployeePendingActivation(req, employee) {
    if (!req?.user || !employee) return false;
    const isSubmitter = viewerIsProfileActivationSubmitter(req, employee);
    const isSubject = viewerIsEmployeeProfileSubject(req, employee);
    const isHrOrAdmin =
        (await isReqUserAdmin(req)) || (await isEmployeeProfileActivationDesignatedHr(req, employee));

    if (isProfileApprovalSubmitted(employee)) {
        return isHrOrAdmin || isSubmitter || isSubject;
    }

    // Left User queued for HR: designated HR/admin may see the queue before Send for Activation.
    if (isHrOrAdmin && pendingChangesIncludeLeftUser(employee.pendingReactivationChanges)) {
        return true;
    }

    return isSubmitter || isSubject || viewerIsProfileActivationDraftEditor(req, employee);
}

export function redactEmployeePendingActivationForViewer(employee) {
    if (!employee || typeof employee !== "object") return employee;
    employee.pendingReactivationChanges = [];
    employee.profileActivationHold = null;
    employee.profileActivationDraftEditor = null;
    return employee;
}
