import AttendanceChangeRequest from "../models/AttendanceChangeRequest.js";
import { isAttendanceTaskType } from "./attendanceTaskCopy.js";

function plain(value) {
    return String(value || "").trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function samePerson(a, b) {
    const left = plain(a).toLowerCase();
    const right = plain(b).toLowerCase();
    return Boolean(left && right && left === right);
}

function isObjectId(value) {
    return /^[a-fA-F0-9]{24}$/.test(String(value || "").trim());
}

function holderStep(task) {
    const reassigned = plain(task.reassignedAssigneeName);
    const current = plain(task.assigneeName);
    const name = reassigned || current;
    if (!name) return [];
    return [{
        key: reassigned ? "reassigned" : "assigned",
        status: "In Progress",
        personName: name,
        personId: String(task.reassignedAssigneeId || task.assigneeId || ""),
        approvalTitle: "",
    }];
}

function attendanceSteps(change, currentName) {
    const stage = String(change?.stage || "");
    const steps = [];
    const reportee = plain(change.reporteeName);
    const hr = plain(change.hrName);
    if (reportee) {
        const active = stage === "pending_reportee";
        const away = active && currentName && !samePerson(currentName, reportee);
        if (away) {
            steps.push({
                key: "reportee",
                status: "Completed",
                personName: reportee,
                personId: String(change.reporteeId || ""),
                approvalTitle: "Reportee Approval",
            });
            steps.push({
                key: "reassigned",
                status: "In Progress",
                personName: currentName,
                personId: "",
                approvalTitle: "",
            });
        } else {
            const status = active
                ? "In Progress"
                : (stage === "pending_hr" || stage === "approved" || stage === "pending_requester" ? "Completed" : "Not Started");
            steps.push({
                key: "reportee",
                status,
                personName: reportee,
                personId: String(change.reporteeId || ""),
                approvalTitle: "Reportee Approval",
            });
        }
    }
    if (hr) {
        const active = stage === "pending_hr";
        const away = active && currentName && !samePerson(currentName, hr);
        if (away) {
            steps.push({
                key: "hr",
                status: "Completed",
                personName: hr,
                personId: String(change.hrId || ""),
                approvalTitle: "HR Approval",
            });
            steps.push({
                key: "reassigned",
                status: "In Progress",
                personName: currentName,
                personId: "",
                approvalTitle: "",
            });
        } else {
            steps.push({
                key: "hr",
                status: active ? "In Progress" : "Not Started",
                personName: hr,
                personId: String(change.hrId || ""),
                approvalTitle: "HR Approval",
            });
        }
    }
    return steps;
}

/**
 * Steps the list and the details page both use to say who a task is waiting on.
 * A completion that is with the original assignee names that person, plus any
 * other approval that is still waiting.
 */
export function waitingStepsFromFacts(task = {}, change = null) {
    const shown = String(task.displayStatus || task.status || "");
    if (["Completed", "Cancelled", "Rejected", "Closed", "Dismissed"].includes(shown) || task.closeScheduled) return [];
    if (task.reviewPending) {
        const name = plain(task.requesterName);
        return name ? [{ key: "review", status: "In Progress", personName: name, personId: "", approvalTitle: "" }] : [];
    }
    const currentName = plain(task.reassignedAssigneeName) || plain(task.assigneeName);
    if (task.completionPending) {
        const original = plain(task.originalAssigneeName) || plain(task.mainAssigneeName);
        const steps = [];
        if (original) {
            steps.push({ key: "completion", status: "In Progress", personName: original, personId: "", approvalTitle: "" });
        }
        const stage = String(change?.stage || "");
        if (change && (stage === "pending_reportee" || stage === "pending_hr" || stage === "pending_requester")) {
            for (const step of attendanceSteps(change, currentName)) {
                if (step.status === "Completed") continue;
                if (samePerson(step.personName, currentName)) continue;
                if (samePerson(step.personName, original)) continue;
                steps.push(step);
            }
        }
        return steps;
    }
    const stage = String(change?.stage || "");
    if (change && (stage === "pending_reportee" || stage === "pending_hr") && (change.reporteeName || change.hrName)) {
        return attendanceSteps(change, currentName);
    }
    return holderStep(task);
}

async function changesByRequestId(ids) {
    const unique = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
    const map = new Map();
    if (!unique.length) return map;
    const objectIds = unique.filter((id) => isObjectId(id));
    const direct = objectIds.length
        ? await AttendanceChangeRequest.find({ _id: { $in: objectIds } })
            .select("stage reporteeId reporteeName hrId hrName proposed.attendanceId updatedAt")
            .lean()
        : [];
    for (const row of direct) map.set(String(row._id), row);
    const missing = unique.filter((id) => !map.has(id));
    if (!missing.length) return map;
    const extra = await AttendanceChangeRequest.find({
        "proposed.attendanceId": { $in: missing },
        stage: { $ne: "superseded" },
    })
        .sort({ updatedAt: -1 })
        .select("stage reporteeId reporteeName hrId hrName proposed.attendanceId updatedAt")
        .lean();
    for (const row of extra) {
        const key = String(row?.proposed?.attendanceId || "");
        if (key && !map.has(key)) map.set(key, row);
    }
    return map;
}

/** Adds holdSteps to each list or detail row. Failures leave the row without steps. */
export async function attachHoldSteps(tasks = []) {
    const list = Array.isArray(tasks) ? tasks : [];
    const ids = [];
    for (const task of list) {
        if (!isAttendanceTaskType(task?.requestType)) continue;
        const id = String(task?.id || "").trim();
        if (id) ids.push(id);
    }
    let changes = new Map();
    try {
        changes = await changesByRequestId(ids);
    } catch (error) {
        console.error("Attendance waiting steps failed:", error);
    }
    for (const task of list) {
        const change = changes.get(String(task?.id || "")) || null;
        task.holdSteps = waitingStepsFromFacts(task, change);
    }
    return list;
}
