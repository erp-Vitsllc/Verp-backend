/**
 * Bell rows that were never saved (profile incomplete, company activation incomplete)
 * become one pending task each. A finished or deleted notice closes that task.
 * The current flowchart HR also keeps the activation queues the bell already shows them.
 */

import Company from "../models/Company.js";
import DashboardAction from "../models/DashboardAction.js";
import TaskManagerTask from "../models/TaskManagerTask.js";
import { calculateCompanyActivationProgress, isCompanyFullyActivated } from "./companyActivation.js";
import { listDeletedNoticeKeys, noticeKeysForRecord } from "./deletedTaskNotice.js";
import { getDepartmentHOD } from "./getDepartmentHOD.js";
import { collectIncompleteMandatoryProfileItems } from "./scanIncompleteMandatoryProfiles.js";
import { COMPANY_LIST_SELECT, enrichCompaniesForList } from "../services/companyPartitionService.js";

export const PROFILE_INCOMPLETE_TYPE = "Profile Incomplete";
export const COMPANY_ACTIVATION_INCOMPLETE_TYPE = "Company Activation Incomplete";

/** Pending queues the bell shows to the current flowchart HR even when an older HR is still the assignee. */
const HR_BELL_QUEUE = new Set([
    "Company Activation",
    "Vehicle Inspection",
    "Vehicle Profile Activation",
    "Vehicle Profile Edit",
    "Profile Activation",
    PROFILE_INCOMPLETE_TYPE,
    COMPANY_ACTIVATION_INCOMPLETE_TYPE,
]);

const SYNC_TTL_MS = 60 * 1000;

let syncFlight = null;
let syncedAt = 0;
let hrCache = null;
let hrCachedAt = 0;

function personName(person) {
    return `${person?.firstName || ""} ${person?.lastName || ""}`.trim();
}

function samePerson(viewer, hr) {
    if (!viewer || !hr?._id) return false;
    if (viewer.employeeObjectId && String(viewer.employeeObjectId) === String(hr._id)) return true;
    const left = String(viewer.employeeId || "").trim().toLowerCase();
    const right = String(hr.employeeId || "").trim().toLowerCase();
    return Boolean(left && right && left === right);
}

export function flowchartHrOwnsTask(viewer, action, hr) {
    if (!samePerson(viewer, hr)) return false;
    if (String(action?.status || "") !== "Pending") return false;
    return HR_BELL_QUEUE.has(String(action?.requestType || ""));
}

function wasDeleted(record, deletedKeys) {
    if (!deletedKeys?.size) return false;
    return noticeKeysForRecord(record).some((key) => deletedKeys.has(key));
}

/**
 * One open task per live notification.
 * A second open copy is dismissed. A notice that is finished is completed.
 * A notice the user already deleted is not opened again.
 */
export function planNoticeSync({ openRows = [], liveItems = [], assigneeId = "", deletedKeys = new Set() } = {}) {
    const live = new Map();
    for (const item of liveItems || []) {
        const id = String(item?.requestId || "").trim();
        if (id) live.set(id, item);
    }

    const completeIds = [];
    const dismissIds = [];
    const updates = [];
    const creates = [];
    const seen = new Set();

    for (const row of openRows || []) {
        const id = String(row?.requestId || "").trim();
        if (!row?._id || !id) continue;
        const item = live.get(id);
        if (!item) {
            completeIds.push(row._id);
            continue;
        }
        if (seen.has(id) || wasDeleted(item, deletedKeys)) {
            dismissIds.push(row._id);
            seen.add(id);
            continue;
        }
        seen.add(id);
        const assigneeChanged = String(row.assignedTo || "") !== String(assigneeId || "");
        const textChanged = String(row.extra1 || "") !== String(item.extra1 || "")
            || String(row.extra2 || "") !== String(item.extra2 || "")
            || String(row.subjectName || "") !== String(item.subjectName || "")
            || String(row.subjectEmployeeId || "") !== String(item.subjectEmployeeId || "");
        if (assigneeChanged || textChanged) updates.push({ id: row._id, item, assigneeChanged });
    }

    for (const [id, item] of live) {
        if (seen.has(id) || wasDeleted(item, deletedKeys)) continue;
        creates.push(item);
    }

    return { completeIds, dismissIds, updates, creates };
}

async function currentFlowchartHr() {
    if (hrCache && Date.now() - hrCachedAt < SYNC_TTL_MS) return hrCache;
    hrCache = await getDepartmentHOD("hr");
    hrCachedAt = Date.now();
    return hrCache;
}

export async function loadFlowchartHr() {
    return currentFlowchartHr();
}

function profileItems(rows) {
    return (rows || []).map((item) => ({
        requestId: item.id,
        requestType: PROFILE_INCOMPLETE_TYPE,
        extra1: item.extra1 || "",
        extra2: item.extra2 || "",
        extra3: item.extra3 || "",
        subjectName: item.subjectName || "",
        subjectEmployeeId: item.targetEmployeeId || "",
        requestedByName: "System",
    })).filter((item) => item.requestId);
}

async function companyIncompleteItems() {
    const companies = await Company.find({ status: "Active", activationStatus: "active" })
        .select(COMPANY_LIST_SELECT)
        .lean()
        .maxTimeMS(8000);
    const enriched = await enrichCompaniesForList(companies);
    const items = [];
    for (const company of enriched || []) {
        if (!company?._id || !isCompanyFullyActivated(company)) continue;
        let percentage = 100;
        try {
            percentage = Number(calculateCompanyActivationProgress(company)?.percentage);
        } catch (error) {
            console.warn("Company activation progress:", company?._id, error?.message || error);
            continue;
        }
        if (!Number.isFinite(percentage) || percentage >= 100) continue;
        const displayName = company.name || "Company";
        const companyKey = String(company.companyId || company._id);
        items.push({
            requestId: company._id,
            requestType: COMPANY_ACTIVATION_INCOMPLETE_TYPE,
            extra1: `${displayName} is missing mandatory cards. Please complete them.`,
            extra2: `${displayName} (${companyKey})`.trim(),
            extra3: JSON.stringify({ kind: "mandatory-cards" }),
            subjectName: displayName,
            subjectEmployeeId: companyKey,
            requestedByName: "System",
        });
    }
    return items;
}

async function applyNoticePlan({ requestType, liveItems, hr }) {
    if (!hr?._id) return;
    const deletedKeys = new Set(await listDeletedNoticeKeys());
    const openRows = await DashboardAction.find({ requestType, status: "Pending" })
        .select("_id requestId assignedTo extra1 extra2 subjectName subjectEmployeeId")
        .lean();
    const plan = planNoticeSync({
        openRows,
        liveItems,
        assigneeId: String(hr._id),
        deletedKeys,
    });
    const now = new Date();
    const hrName = personName(hr);
    const writes = [];

    if (plan.completeIds.length) {
        writes.push(DashboardAction.updateMany(
            { _id: { $in: plan.completeIds }, status: "Pending" },
            { $set: { status: "Approved", actionedDate: now, comment: "Completed: this notification is finished." } },
        ));
        writes.push(TaskManagerTask.updateMany(
            {
                sourceDashboardActionId: { $in: plan.completeIds },
                status: { $nin: ["Completed", "Cancelled", "Rejected"] },
            },
            { $set: { status: "Completed" } },
        ));
    }
    if (plan.dismissIds.length) {
        writes.push(DashboardAction.updateMany(
            { _id: { $in: plan.dismissIds }, status: "Pending" },
            { $set: { status: "Dismissed", actionedDate: now, comment: "Closed: this notification was removed." } },
        ));
        writes.push(TaskManagerTask.updateMany(
            {
                sourceDashboardActionId: { $in: plan.dismissIds },
                status: { $nin: ["Completed", "Cancelled", "Rejected"] },
            },
            { $set: { status: "Cancelled" } },
        ));
    }
    if (writes.length) await Promise.all(writes);

    const moved = [];
    for (const update of plan.updates) {
        await DashboardAction.updateOne(
            { _id: update.id },
            {
                $set: {
                    extra1: update.item.extra1 || "",
                    extra2: update.item.extra2 || "",
                    extra3: update.item.extra3 || "",
                    subjectName: update.item.subjectName || "",
                    subjectEmployeeId: update.item.subjectEmployeeId || "",
                    assignedTo: hr._id,
                    assignedToEmpId: hr.employeeId || "",
                    status: "Pending",
                },
            },
        );
        if (update.assigneeChanged) moved.push(update.id);
    }
    if (moved.length) {
        await TaskManagerTask.updateMany(
            {
                sourceDashboardActionId: { $in: moved },
                status: { $nin: ["Cancelled", "Rejected"] },
            },
            {
                $set: {
                    assignee: hr._id,
                    assigneeEmpId: hr.employeeId || "",
                    assigneeName: hrName,
                    status: "Pending",
                },
            },
        );
    }
    if (!plan.creates.length) return;
    await DashboardAction.insertMany(plan.creates.map((item) => ({
        assignedTo: hr._id,
        assignedToEmpId: hr.employeeId || "",
        requestId: item.requestId,
        requestType,
        status: "Pending",
        subjectEmployeeId: item.subjectEmployeeId || "",
        subjectName: item.subjectName || "",
        requestedByName: item.requestedByName || "System",
        requestedDate: now,
        extra1: item.extra1 || "",
        extra2: item.extra2 || "",
        extra3: item.extra3 || "",
    })), { ordered: false });
}

async function syncProfileIncompleteTasks(hr) {
    const items = profileItems(await collectIncompleteMandatoryProfileItems());
    await applyNoticePlan({ requestType: PROFILE_INCOMPLETE_TYPE, liveItems: items, hr });
}

async function syncCompanyActivationIncompleteTasks(hr) {
    const items = await companyIncompleteItems();
    await applyNoticePlan({ requestType: COMPANY_ACTIVATION_INCOMPLETE_TYPE, liveItems: items, hr });
}

/** Save a task for every open profile-incomplete and company-activation-incomplete notification. */
export async function ensureNotificationTasks() {
    if (syncFlight) return syncFlight;
    if (Date.now() - syncedAt < SYNC_TTL_MS) return;
    syncFlight = (async () => {
        const hr = await currentFlowchartHr();
        if (!hr?._id) return;
        await Promise.all([
            syncProfileIncompleteTasks(hr),
            syncCompanyActivationIncompleteTasks(hr),
        ]);
        syncedAt = Date.now();
    })().catch((error) => {
        console.error("Notification tasks:", error?.message || error);
    }).finally(() => {
        syncFlight = null;
    });
    return syncFlight;
}
