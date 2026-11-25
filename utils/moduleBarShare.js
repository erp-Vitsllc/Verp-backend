import DashboardAction from "../models/DashboardAction.js";
import { isGeneralHubRequestType } from "./employeeHubRequestTypes.js";
import { isObjectId } from "./taskManagerModule.js";

/** Pending module-bar copy. The task stays on one row; this copy is only for the other person's bell. */
export const MODULE_BAR_SHARE_PREFIX = "module-bar-share:";

export function isModuleBarShare(action) {
    return String(action?.comment || "").startsWith(MODULE_BAR_SHARE_PREFIX);
}

export function moduleBarShareComment(sourceId, employeeId) {
    return `${MODULE_BAR_SHARE_PREFIX}${sourceId}:${employeeId}`;
}

/** Workflow and system bells can be shared. General tasks and task-manager notices cannot. */
export function sharesModuleBar(requestType, _extra2 = "") {
    if (!requestType || String(requestType) === "Task Manager") return false;
    if (isGeneralHubRequestType(requestType)) return false;
    return true;
}

export function moduleBarBellKey(action) {
    return [
        String(action?.requestType || ""),
        String(action?.requestId || ""),
        String(action?.extra1 || ""),
        String(action?.extra3 || ""),
    ].join("|");
}

/** A person who already has the real bell does not also get the shared copy. */
export function omitDuplicateModuleBarShares(items) {
    const list = Array.isArray(items) ? items : [];
    const real = new Set();
    for (const item of list) {
        if (!isModuleBarShare(item)) real.add(moduleBarBellKey(item));
    }
    return list.filter((item) => !isModuleBarShare(item) || !real.has(moduleBarBellKey(item)));
}

function addPerson(people, id, empId) {
    if (!isObjectId(id)) return;
    if (people.some((person) => String(person.id) === String(id))) return;
    people.push({ id, empId: String(empId || "") });
}

/** Which source rows need a copy, and for whom. The person who already holds the row is skipped. */
export function moduleBarShareCopies(sources, people) {
    const copies = [];
    for (const source of sources || []) {
        if (!source?._id || isModuleBarShare(source)) continue;
        if (!sharesModuleBar(source.requestType, source.extra2 || "")) continue;
        for (const person of people || []) {
            if (!isObjectId(person?.id)) continue;
            if (String(source.assignedTo || "") === String(person.id)) continue;
            copies.push({
                source,
                person,
                comment: moduleBarShareComment(source._id, person.id),
            });
        }
    }
    return copies;
}

async function upsertModuleBarShare(source, person, comment) {
    const fields = {
        assignedTo: person.id,
        assignedToEmpId: person.empId || "",
        requestId: source.requestId,
        requestType: source.requestType,
        status: source.status === "On Hold" ? "On Hold" : "Pending",
        subjectEmployeeId: source.subjectEmployeeId || "",
        subjectName: source.subjectName || "",
        requestedByName: source.requestedByName || "",
        requestedDate: source.requestedDate || source.createdAt || new Date(),
        extra1: source.extra1 || "",
        extra2: source.extra2 || "",
        extra3: source.extra3 || "",
        comment,
        actionedDate: null,
    };
    const existing = await DashboardAction.findOne({
        requestId: source.requestId,
        requestType: source.requestType,
        comment,
    }).select("_id");
    if (existing) {
        await DashboardAction.updateOne({ _id: existing._id }, { $set: fields });
        return;
    }
    await DashboardAction.create(fields);
}

export async function dismissModuleBarShares(requestId) {
    if (!isObjectId(requestId)) return;
    await DashboardAction.updateMany(
        {
            requestId,
            status: { $in: ["Pending", "On Hold"] },
            comment: { $regex: `^${MODULE_BAR_SHARE_PREFIX}` },
        },
        { $set: { status: "Dismissed", actionedDate: new Date() } },
    );
}

/**
 * After a workflow or system task is reassigned, every open notification for that
 * same record stays on the original assignee and is also shown to the reassignee.
 */
export async function shareReassignedModuleNotifications({
    action,
    originalId,
    originalEmpId = "",
    reassigneeId,
    reassigneeEmpId = "",
} = {}) {
    if (!action?.requestId || !sharesModuleBar(action.requestType, action.extra2 || "")) return;
    const people = [];
    addPerson(people, originalId, originalEmpId);
    addPerson(people, reassigneeId, reassigneeEmpId);
    if (people.length < 2) {
        await dismissModuleBarShares(action.requestId);
        return;
    }

    const holderIds = new Set(people.map((person) => String(person.id)));
    const rows = await DashboardAction.find({
        requestId: action.requestId,
        status: { $in: ["Pending", "On Hold"] },
        requestType: { $ne: "Task Manager" },
    }).lean();
    const sources = (rows || []).filter((row) => (
        !isModuleBarShare(row)
        && holderIds.has(String(row.assignedTo || ""))
    ));
    const copies = moduleBarShareCopies(sources, people);
    for (const copy of copies) {
        await upsertModuleBarShare(copy.source, copy.person, copy.comment);
    }
    const kept = copies.map((copy) => copy.comment);
    await DashboardAction.updateMany(
        {
            requestId: action.requestId,
            status: { $in: ["Pending", "On Hold"] },
            comment: kept.length
                ? { $regex: `^${MODULE_BAR_SHARE_PREFIX}`, $nin: kept }
                : { $regex: `^${MODULE_BAR_SHARE_PREFIX}` },
        },
        { $set: { status: "Dismissed", actionedDate: new Date() } },
    );
}
