import mongoose from "mongoose";
import AssetItem from "../../models/AssetItem.js";
import DashboardAction from "../../models/DashboardAction.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeeHubRequest from "../../models/EmployeeHubRequest.js";
import Fine from "../../models/Fine.js";
import TaskManagerTask from "../../models/TaskManagerTask.js";
import User from "../../models/User.js";
import { getSignedFileUrl, isPresignedUrlStillFresh } from "../../utils/s3Upload.js";
import {
    isVehicleServicePendingTitle,
    personRequesterName,
    requesterNameFromService,
} from "../../utils/vehicleServiceNotificationCopy.js";
import {
    accessPathFor,
    displayTaskType,
    moduleForRequestType,
    moduleForText,
    promoteDueTaskCompletions,
    reassignmentAssignees,
    latestReassignedAt,
    resolveTaskViewer,
    viewerCanReassign,
} from "../../utils/taskManagerModule.js";
import { viewerMayDeleteTask } from "../../utils/taskDeleteAccess.js";
import { listDeletedNoticeKeys, noticeKeysForRecord } from "../../utils/deletedTaskNotice.js";
import { assignTaskNumbers } from "../../utils/taskNumber.js";
import { chooseKeptDuplicate, documentTaskLabel, duplicateOverlayShouldClose, taskMatchHints } from "../../utils/taskDuplicateKey.js";
import { formatTaskDisplayParts, vehicleRecordId } from "../../utils/taskDisplayName.js";
import { composeTaskDescription } from "../../utils/taskDetailDescription.js";
import { attendanceFactsByActionId } from "../../utils/loadAttendanceTaskFacts.js";
import { syncPendingSalaryEnrollmentTasks } from "../../utils/syncPendingSalaryEnrollmentTasks.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import {
    fineNeedsAccountsPaymentInbox,
    fineStillNeedsApprovalInbox,
    fineStillNeedsInbox,
    getExpectedRoleForFineStatus,
} from "../../utils/fineStageAuth.js";

function collapseUtilityBillReminderActions(actions = []) {
    const groups = new Map();
    const order = [];
    for (const action of actions) {
        if (String(action?.requestType || "") !== "Utility Bill Payment Reminder") {
            order.push(action);
            continue;
        }
        let meta = {};
        try {
            meta = JSON.parse(action.extra3 || "{}");
        } catch {
            meta = {};
        }
        const utilityType = String(meta.utilityType || "").trim();
        const month = String(meta.billMonth || meta.yearMonth || "").trim();
        if (!utilityType || !/^\d{4}-\d{2}$/.test(month)) {
            order.push(action);
            continue;
        }
        const key = `${utilityType.toLowerCase()}|${month}`;
        if (!groups.has(key)) {
            groups.set(key, []);
            order.push({ __billGroup: key });
        }
        groups.get(key).push(action);
    }
    return order.map((item) => {
        if (!item?.__billGroup) return item;
        const members = groups.get(item.__billGroup) || [];
        if (members.length <= 1) return members[0];
        const first = members[0];
        let meta = {};
        try {
            meta = JSON.parse(first.extra3 || "{}");
        } catch {
            meta = {};
        }
        const utilityType = String(meta.utilityType || "Utility").trim() || "Utility";
        const month = String(meta.billMonth || meta.yearMonth || "");
        const [year, monthNum] = month.split("-").map(Number);
        const monthLabel = new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleDateString("en-GB", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
        });
        const count = members.length;
        return {
            ...first,
            extra1: `${utilityType} · ${monthLabel}`,
            extra2: `${monthLabel.replace(/\s+\d{4}$/, "")} — ${count} ${utilityType} pending for payment`,
            extra3: JSON.stringify({
                ...meta,
                accountNo: "",
                groupedBillCount: count,
                detailsPath: "/HRM/Asset/UtilityBills",
            }),
        };
    });
}

const DUBAI_DATE = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

const PENDING_STATUSES = new Set(["Pending", "On Hold"]);

function dubaiDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return DUBAI_DATE.format(date);
}

function monthKeyFromDateKey(dateKey) {
    return dateKey ? dateKey.slice(0, 7) : "";
}

function shiftMonth(year, month, delta) {
    const cursor = new Date(Date.UTC(year, month - 1 + delta, 1));
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    return `${y}-${String(m).padStart(2, "0")}`;
}

function daysBetween(fromKey, toKey) {
    if (!fromKey || !toKey) return 0;
    const [fy, fm, fd] = fromKey.split("-").map(Number);
    const [ty, tm, td] = toKey.split("-").map(Number);
    return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

function isObjectId(value) {
    const text = String(value || "");
    return /^[a-fA-F0-9]{24}$/.test(text) && mongoose.Types.ObjectId.isValid(text);
}

function personName(record) {
    if (!record) return "";
    if (record.name) return String(record.name).trim();
    return [record.firstName, record.lastName].filter(Boolean).join(" ").trim();
}

function cleanRequester(name) {
    return String(name || "").trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function isPersonRequester(name) {
    return Boolean(personRequesterName(name));
}

function dashboardMeta(extra3) {
    if (!extra3) return null;
    if (typeof extra3 === "object") return extra3;
    try {
        return JSON.parse(String(extra3));
    } catch {
        return null;
    }
}

function requesterSourceKeys(action) {
    const requestId = String(action?.requestId || "");
    if (!requestId) return [];
    const serviceId = String(dashboardMeta(action?.extra3)?.serviceRecordId || "");
    const keys = [];
    if (serviceId) keys.push(`${requestId}:${serviceId}`);
    keys.push(requestId);
    return keys;
}

/**
 * Fines store the real creator on the fine. Vehicle service rows sometimes store the
 * workflow title ("Mechanical Work pending with …") instead of the person who requested it.
 */
export async function sourceRequesterNameMap(actions = []) {
    const fineIds = [];
    const vehicleServices = new Map();
    for (const action of actions) {
        if (!action || isPersonRequester(action.requestedByName)) continue;
        const requestType = String(action.requestType || "");
        const id = String(action.requestId || "");
        if (/fine/i.test(requestType) && isObjectId(id)) fineIds.push(id);
        if (requestType !== "Vehicle Service Request" || !isObjectId(id)) continue;
        const serviceId = String(dashboardMeta(action.extra3)?.serviceRecordId || "");
        if (!isObjectId(serviceId)) continue;
        const services = vehicleServices.get(id) || new Set();
        services.add(serviceId);
        vehicleServices.set(id, services);
    }
    const map = new Map();
    if (fineIds.length) {
        const fines = await Fine.find({ _id: { $in: [...new Set(fineIds)] } })
            .select("createdBy")
            .populate("createdBy", "name")
            .lean();
        for (const fine of fines) {
            const name = personRequesterName(fine.createdBy?.name);
            if (name) map.set(String(fine._id), name);
        }
    }
    if (vehicleServices.size) {
        const assets = await AssetItem.find({ _id: { $in: [...vehicleServices.keys()] } })
            .select("services._id services.remark services.requestedBy")
            .lean();
        const employeeIds = [];
        const unresolved = [];
        for (const asset of assets) {
            const wanted = vehicleServices.get(String(asset._id));
            if (!wanted) continue;
            for (const service of asset.services || []) {
                const serviceId = String(service?._id || "");
                if (!wanted.has(serviceId)) continue;
                const key = `${asset._id}:${serviceId}`;
                const fromRemark = requesterNameFromService(service);
                if (fromRemark) {
                    map.set(key, fromRemark);
                    continue;
                }
                const employeeId = String(service?.requestedBy || "");
                if (isObjectId(employeeId)) {
                    employeeIds.push(employeeId);
                    unresolved.push({ key, employeeId });
                }
            }
        }
        if (employeeIds.length) {
            const employees = await EmployeeBasic.find({ _id: { $in: [...new Set(employeeIds)] } })
                .select("firstName lastName name")
                .lean();
            const byId = new Map(employees.map((employee) => [String(employee._id), personName(employee)]));
            for (const row of unresolved) {
                const name = personRequesterName(byId.get(row.employeeId));
                if (name) map.set(row.key, name);
            }
        }
    }
    return map;
}

export function preferRequesterName(...values) {
    const names = values.map(cleanRequester);
    const person = names.find((name) => isPersonRequester(name));
    if (person) return person;
    return names.find((name) => name && !isVehicleServicePendingTitle(name)) || "";
}

export function displayRequesterName(stored, action, sourceMap) {
    const name = cleanRequester(stored);
    if (isPersonRequester(name)) return name;
    for (const key of requesterSourceKeys(action)) {
        const found = personRequesterName(sourceMap?.get(key));
        if (found) return found;
    }
    if (name && !isVehicleServicePendingTitle(name)) return name;
    return "System";
}

const GENERAL_REQUEST_TYPES = new Set([
    "employee salary request",
    "employee certificate request",
    "employee asset request",
]);

const GENERAL_TITLES = {
    "employee salary request": "Early Salary",
    "employee certificate request": "Salary Certificate",
    "employee asset request": "Assets",
};

function isFollowUpSentence(value) {
    return /^expiry follow-up required:/i.test(String(value || "").trim());
}

/** Plate, or the fleet id when the plate is empty. Tools assets stay on asset id and name. */
export async function vehicleDisplayById(actions = []) {
    const ids = [...new Set(actions.map((action) => vehicleRecordId(action)).filter(Boolean))];
    const map = new Map();
    if (!ids.length) return map;
    const assets = await AssetItem.find({ _id: { $in: ids } })
        .select("assetId name plateNumber plateEmirate")
        .lean();
    for (const asset of assets) {
        const plate = [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(" ").trim();
        const assetId = String(asset.assetId || "").trim();
        const name = String(asset.name || "").trim();
        map.set(String(asset._id), {
            vehicleNo: plate || assetId || name,
            assetNo: assetId,
            assetName: name,
            assetLabel: [assetId, name].filter(Boolean).join(" — "),
            hasPlate: Boolean(plate),
        });
    }
    return map;
}

const COMPANY_FINE_IDS = new Set(["VEGA-HR-0000", "VEGA_INTERNAL"]);

function fineBaseId(fineId = "") {
    const id = String(fineId || "").trim();
    const parts = id.split("-");
    if (parts.length > 3) return parts.slice(0, 3).join("-");
    return id;
}

function finePeople(fines = []) {
    const names = [];
    const ids = [];
    const seen = new Set();
    for (const fine of fines) {
        for (const row of fine?.assignedEmployees || []) {
            const id = String(row?.employeeId || "").trim();
            if (!id || COMPANY_FINE_IDS.has(id) || seen.has(id)) continue;
            seen.add(id);
            ids.push(id);
            const name = String(row?.employeeName || "").trim();
            if (name) names.push(name);
        }
    }
    return { names, ids, isGroup: ids.length > 1 };
}

/** One person is an individual fine. Sibling rows (-A/-B) and a company share stay one fine. */
export async function fineFamilyByRequestId(actions = []) {
    const ids = [...new Set(
        actions
            .filter((action) => /^(fine|group fine request)$/i.test(String(action?.requestType || "")))
            .map((action) => String(action?.requestId || ""))
            .filter(isObjectId),
    )];
    const map = new Map();
    if (!ids.length) return map;
    const seeds = await Fine.find({ _id: { $in: ids } })
        .select("fineId fineType assignedEmployees")
        .lean();
    const bases = [...new Set(seeds.map((fine) => fineBaseId(fine.fineId)).filter(Boolean))];
    const family = bases.length
        ? await Fine.find({
            $or: bases.map((base) => ({ fineId: new RegExp(`^${escapeRegex(base)}(-[A-Z])?$`, "i") })),
        })
            .select("fineId fineType assignedEmployees")
            .lean()
        : [];
    const byBase = new Map();
    for (const fine of family) {
        const base = fineBaseId(fine.fineId);
        const list = byBase.get(base) || [];
        list.push(fine);
        byBase.set(base, list);
    }
    const infoFor = (fine, members) => {
        const people = finePeople(members);
        const primary = members.find((row) => finePeople([row]).ids.length) || fine;
        return {
            fineId: people.isGroup
                ? fineBaseId(primary?.fineId || fine.fineId)
                : String(primary?.fineId || fine.fineId || "").trim(),
            fineType: String(primary?.fineType || fine.fineType || "").trim(),
            employeeName: people.names.join(", "),
            employeeId: people.ids.join(", "),
            isGroup: people.isGroup,
            peopleCount: people.ids.length,
            baseId: fineBaseId(fine.fineId),
        };
    };
    for (const fine of seeds) {
        const base = fineBaseId(fine.fineId);
        map.set(String(fine._id), infoFor(fine, byBase.get(base) || [fine]));
    }
    for (const members of byBase.values()) {
        for (const fine of members) {
            const key = String(fine._id);
            if (!map.has(key)) map.set(key, infoFor(fine, members));
        }
    }
    return map;
}

/**
 * An individual fine must not stay labeled Group Fine, and the same fine must not
 * produce two pending tasks (the person row and the company row, or Fine plus Group Fine).
 */
export async function collapsePendingFineDashboardRows(actions = []) {
    const fineInfo = await fineFamilyByRequestId(actions);
    const drop = new Set();
    const keptByBase = new Map();
    for (const action of actions) {
        const type = String(action?.requestType || "");
        const status = String(action?.status || "");
        if (!/^(fine|group fine request)$/i.test(type)) continue;
        if (status !== "Pending" && status !== "On Hold") continue;
        const info = fineInfo.get(String(action.requestId || ""));
        const key = info?.baseId || String(action.requestId || action._id);
        const previous = keptByBase.get(key);
        if (!previous) {
            keptByBase.set(key, action);
            continue;
        }
        const previousTime = new Date(previous.requestedDate || previous.createdAt || 0).getTime();
        const nextTime = new Date(action.requestedDate || action.createdAt || 0).getTime();
        if (nextTime >= previousTime) {
            drop.add(String(previous._id));
            keptByBase.set(key, action);
        } else {
            drop.add(String(action._id));
        }
    }
    const corrections = [];
    for (const action of keptByBase.values()) {
        const info = fineInfo.get(String(action.requestId || ""));
        if (!info) continue;
        const nextType = info.isGroup ? "Group Fine Request" : "Fine";
        const patch = {};
        if (action.requestType !== nextType) patch.requestType = nextType;
        if (info.isGroup) {
            const label = `Group Fine - ${info.peopleCount} Employees`;
            if (action.subjectName !== label) patch.subjectName = label;
        } else if (/^Group Fine/i.test(String(action.subjectName || ""))) {
            const person = String(info.employeeName || "").split(",")[0].trim();
            if (person) patch.subjectName = person;
        }
        if (!Object.keys(patch).length) continue;
        Object.assign(action, patch);
        corrections.push(DashboardAction.updateOne({ _id: action._id }, { $set: patch }));
    }
    if (drop.size) {
        corrections.push(DashboardAction.updateMany(
            { _id: { $in: [...drop] }, status: { $in: ["Pending", "On Hold"] } },
            {
                $set: {
                    status: "Dismissed",
                    actionedDate: new Date(),
                    comment: "Closed: duplicate fine task",
                },
            },
        ));
    }
    if (corrections.length) await Promise.all(corrections);
    return {
        rows: actions.filter((action) => !drop.has(String(action._id))),
        fineInfo,
    };
}

const FINE_TASK_TYPES = /^(fine|group fine request)$/i;
const FINISHED_FINE_STATUSES = new Set(["Approved", "Active", "Paid", "Completed"]);

function overlayWasReassigned(overlay) {
    return Boolean(
        String(overlay?.closeRequest?.originalAssigneeId || "").trim()
        || String(overlay?.closeRequest?.originalAssigneeName || "").trim(),
    );
}

function fineStagePerson(fine, hods) {
    if (!fine || !hods) return null;
    if (fineNeedsAccountsPaymentInbox(fine)) return hods.Accounts || null;
    if (!fineStillNeedsApprovalInbox(fine)) return null;
    const role = getExpectedRoleForFineStatus(fine.fineStatus, fine.workflow || []);
    if (role === "HR") return hods.HR || null;
    if (role === "Accounts") return hods.Accounts || null;
    if (role === "Management") return hods.Management || null;
    return null;
}

function closedFineDashboardStatus(members = []) {
    const statuses = members.map((fine) => String(fine?.fineStatus || ""));
    if (statuses.some((status) => FINISHED_FINE_STATUSES.has(status))) return "Approved";
    if (statuses.some((status) => status === "Rejected")) return "Rejected";
    return "Dismissed";
}

function sameFineAssignee(action, person) {
    const current = String(action?.assignedTo || "");
    const idMatch = [person?.employeeObjectId, person?.userId].filter(Boolean).map(String).includes(current);
    const code = String(action?.assignedToEmpId || "").trim().toLowerCase();
    const nextCode = String(person?.employeeId || "").trim().toLowerCase();
    if (!code || !nextCode) return idMatch;
    return idMatch && code === nextCode;
}

function packFineHod(hod, userIdByCode) {
    const employeeObjectId = hod?._id ? String(hod._id) : "";
    if (!employeeObjectId) return null;
    const employeeId = String(hod.employeeId || "").trim();
    return {
        employeeId,
        employeeObjectId,
        userId: userIdByCode.get(employeeId.toLowerCase()) || "",
        name: personName(hod),
    };
}

async function loadFineStageAssignees() {
    const [hr, accounts, management] = await Promise.all([
        getDepartmentHOD("hr"),
        getDepartmentHOD("finance"),
        getManagementHOD(),
    ]);
    const codes = [...new Set(
        [hr, accounts, management].map((hod) => String(hod?.employeeId || "").trim()).filter(Boolean),
    )];
    const users = codes.length
        ? await User.find({ employeeId: { $in: codes } }).select("_id employeeId").lean()
        : [];
    const userIdByCode = new Map(
        users.map((user) => [String(user.employeeId || "").trim().toLowerCase(), String(user._id)]),
    );
    return {
        HR: packFineHod(hr, userIdByCode),
        Accounts: packFineHod(accounts, userIdByCode),
        Management: packFineHod(management, userIdByCode),
    };
}

function markFineOverlayClosed(overlay) {
    if (!overlay) return;
    if (overlay.status === "Completed" || overlay.status === "Cancelled") return;
    overlay.status = "Completed";
}

/**
 * Pending fine tasks follow the fine itself.
 * A finished fine leaves the pending list. An open fine shows the current stage assignee.
 */
export async function alignOpenFineDashboardRows(actions = [], overlaysByAction = new Map()) {
    try {
        const pending = (actions || []).filter((action) => (
            FINE_TASK_TYPES.test(String(action?.requestType || ""))
            && (action.status === "Pending" || action.status === "On Hold")
        ));
        if (!pending.length) return actions;

        const ids = [...new Set(pending.map((action) => String(action.requestId || "")).filter(isObjectId))];
        const fineSelect = "fineId fineStatus workflow accountsPaymentPath zohoBillId zohoBillNumber vendorBillStatus";
        const missingOverlayIds = pending
            .map((action) => action._id)
            .filter((id) => id && !overlaysByAction.has(String(id)));
        const [seeds, extraOverlays] = await Promise.all([
            ids.length ? Fine.find({ _id: { $in: ids } }).select(fineSelect).lean() : [],
            missingOverlayIds.length
                ? TaskManagerTask.find({ sourceDashboardActionId: { $in: missingOverlayIds } })
                    .select("assignee assigneeEmpId assigneeName sourceDashboardActionId status closeRequest")
                    .lean()
                : [],
        ]);
        for (const overlay of extraOverlays) {
            const key = String(overlay.sourceDashboardActionId || "");
            if (key && !overlaysByAction.has(key)) overlaysByAction.set(key, overlay);
        }
        const seedById = new Map(seeds.map((fine) => [String(fine._id), fine]));
        const bases = [...new Set(seeds.map((fine) => fineBaseId(fine.fineId)).filter(Boolean))];
        const family = bases.length
            ? await Fine.find({
                $or: bases.map((base) => ({ fineId: new RegExp(`^${escapeRegex(base)}(-[A-Z])?$`, "i") })),
            }).select(fineSelect).lean()
            : [];
        const byBase = new Map();
        for (const fine of family) {
            const base = fineBaseId(fine.fineId);
            const list = byBase.get(base) || [];
            list.push(fine);
            byBase.set(base, list);
        }

        const needsAssignee = pending.some((action) => {
            const seed = seedById.get(String(action.requestId || ""));
            if (!seed) return false;
            const members = byBase.get(fineBaseId(seed.fineId)) || [seed];
            return members.some((fine) => fineStillNeedsInbox(fine));
        });
        const hods = needsAssignee ? await loadFineStageAssignees() : null;

        const closeByStatus = new Map();
        const dismissIds = [];
        const assigneeWrites = [];
        for (const action of pending) {
            const seed = seedById.get(String(action.requestId || ""));
            const overlay = overlaysByAction.get(String(action._id || ""));
            if (!seed) {
                action.status = "Dismissed";
                action.actionedDate = action.actionedDate || new Date();
                if (action._id) dismissIds.push(action._id);
                markFineOverlayClosed(overlay);
                continue;
            }
            const members = byBase.get(fineBaseId(seed.fineId)) || [seed];
            const openFine = members.find((fine) => String(fine._id) === String(action.requestId) && fineStillNeedsInbox(fine))
                || members.find((fine) => fineStillNeedsInbox(fine));
            if (!openFine) {
                const nextStatus = closedFineDashboardStatus(members);
                action.status = nextStatus;
                action.actionedDate = action.actionedDate || new Date();
                if (action._id) {
                    const bucket = closeByStatus.get(nextStatus) || [];
                    bucket.push(action._id);
                    closeByStatus.set(nextStatus, bucket);
                }
                markFineOverlayClosed(overlay);
                continue;
            }
            const person = fineStagePerson(openFine, hods);
            if (!person?.employeeObjectId || sameFineAssignee(action, person)) continue;
            action.assignedTo = person.employeeObjectId;
            action.assignedToEmpId = person.employeeId;
            assigneeWrites.push({ action, person, overlay });
            if (overlay && !overlayWasReassigned(overlay)) {
                overlay.assignee = person.employeeObjectId;
                overlay.assigneeEmpId = person.employeeId;
                if (person.name) overlay.assigneeName = person.name;
            }
        }

        const writes = [];
        for (const [nextStatus, ids] of closeByStatus) {
            writes.push(DashboardAction.updateMany(
                { _id: { $in: ids }, status: { $in: ["Pending", "On Hold"] } },
                {
                    $set: {
                        status: nextStatus,
                        actionedDate: new Date(),
                        comment: nextStatus === "Rejected"
                            ? "Closed: fine was rejected"
                            : nextStatus === "Dismissed"
                                ? "Closed: fine is not waiting for anyone"
                                : "Closed: fine is already completed",
                    },
                },
            ));
        }
        if (dismissIds.length) {
            writes.push(DashboardAction.updateMany(
                { _id: { $in: dismissIds }, status: { $in: ["Pending", "On Hold"] } },
                {
                    $set: {
                        status: "Dismissed",
                        actionedDate: new Date(),
                        comment: "Closed: fine record is gone",
                    },
                },
            ));
        }
        if (assigneeWrites.length) {
            writes.push(DashboardAction.bulkWrite(assigneeWrites.map(({ action, person }) => ({
                updateOne: {
                    filter: { _id: action._id, status: { $in: ["Pending", "On Hold"] } },
                    update: {
                        $set: {
                            assignedTo: person.employeeObjectId,
                            assignedToEmpId: person.employeeId,
                        },
                    },
                },
            }))));
            const overlayWrites = assigneeWrites.filter(({ overlay }) => overlay?._id && !overlayWasReassigned(overlay));
            if (overlayWrites.length) {
                writes.push(TaskManagerTask.bulkWrite(overlayWrites.map(({ overlay, person }) => ({
                    updateOne: {
                        filter: { _id: overlay._id },
                        update: {
                            $set: {
                                assignee: person.employeeObjectId,
                                assigneeEmpId: person.employeeId,
                                ...(person.name ? { assigneeName: person.name } : {}),
                            },
                        },
                    },
                }))));
            }
        }
        const finishedOverlayIds = [...closeByStatus.values()].flat().concat(dismissIds);
        if (finishedOverlayIds.length) {
            writes.push(TaskManagerTask.updateMany(
                {
                    sourceDashboardActionId: { $in: finishedOverlayIds },
                    status: { $in: ["Pending", "In Progress", "On Hold"] },
                },
                { $set: { status: "Completed" } },
            ));
        }
        if (writes.length) await Promise.all(writes);
        return actions;
    } catch (error) {
        console.error("Align fine tasks failed:", error);
        return actions;
    }
}

export function vehicleDisplayFor(action, vehicles) {
    const record = vehicles?.get(vehicleRecordId(action)) || null;
    return {
        vehicleNo: record?.vehicleNo || "",
        assetNo: record?.assetNo || "",
        assetName: record?.assetName || "",
        assetLabel: record?.assetLabel || "",
        hasPlate: Boolean(record?.hasPlate),
    };
}

/** Short title in the header. The written request stays in the description. */
export function taskTitleAndDescription({
    requestType,
    extra1,
    extra2,
    extra3,
    subjectName,
    subjectEmployeeId,
    comment,
    requestedBy,
    taskName,
    description,
    vehicleNo,
    assetNo,
    assetName,
    assetLabel,
    hasPlate,
    manual,
    source,
} = {}) {
    const typeKey = String(requestType || "").trim().toLowerCase();
    const label = String(extra2 || "").trim();
    const body = String(extra1 || "").trim();
    const storedName = String(taskName || "").trim();
    const storedDescription = String(description || "").trim();
    const followUp = [body, storedName].find((value) => isFollowUpSentence(value)) || "";
    let baseName = "";
    let baseDescription = "";
    if (followUp && (!storedName || isFollowUpSentence(storedName))) {
        const subject = [label, storedDescription].find((value) => value && !isFollowUpSentence(value)) || "";
        baseName = subject || requestType || "Task";
        baseDescription = followUp;
    } else if (!GENERAL_REQUEST_TYPES.has(typeKey)) {
        baseName = storedName || body || requestType || "Notification";
        baseDescription = storedDescription || label || body;
    } else {
        const shortTitle = label || GENERAL_TITLES[typeKey] || requestType || "Task";
        const nameIsTheDescription = Boolean(storedName && body && storedName === body);
        baseName = !storedName || nameIsTheDescription ? shortTitle : storedName;
        const longText = storedDescription && storedDescription !== baseName ? storedDescription : body;
        baseDescription = longText && longText !== baseName ? longText : "";
    }

    const displayParts = formatTaskDisplayParts({
        requestType,
        extra1,
        extra2,
        extra3,
        subjectName,
        subjectEmployeeId,
        taskName,
        vehicleNo,
        assetNo,
        assetName,
        assetLabel,
        hasPlate,
        manual,
        source,
    });
    const nextName = displayParts.title || baseName;
    const taskSubject = displayParts.subject || "";
    let nextDescription = baseDescription;
    if (nextName !== baseName && baseName && baseName !== nextName) {
        if (!nextDescription || nextDescription === nextName) nextDescription = baseName;
    }
    if (nextDescription === nextName) nextDescription = "";
    const composed = composeTaskDescription({
        requestType,
        extra1,
        extra2,
        extra3,
        subjectName,
        subjectEmployeeId,
        comment,
        taskName: nextName,
        requestedBy,
        assetNo,
        assetName,
        vehicleNo,
        manual,
        source,
    });
    return { taskName: nextName, taskSubject, description: composed || nextDescription };
}

function isGeneralHubRequest(requestType, extra = "") {
    const type = String(requestType || "").trim().toLowerCase();
    if (GENERAL_REQUEST_TYPES.has(type)) return true;
    const label = String(extra || "").trim().toLowerCase();
    return type === "employee asset request" && /^assets\b/.test(label);
}

/** One approval step, created by the system (expiry and the same kind of reminder). */
function isSingleStepSystemTask(requestType) {
    const type = String(requestType || "");
    return /expiry|not renew|card deleted|value missing|asset overdue|profile incomplete|payment reminder|fuel reminder/i.test(type);
}

/**
 * System Task: system-created, one approval step (expiry and similar reminders).
 * Workflow Task: more than one approval step or approver, whether the system or a person started it.
 * General Task: only Early Salary, Salary Certificate, and Assets from the dashboard request row.
 */
export function taskCategory(requestType, extra = "") {
    if (isGeneralHubRequest(requestType, extra)) return "General Task";
    if (
        String(requestType || "").trim() === "Salary Enrollment"
        && String(extra || "").trim().toLowerCase() === "pending for enrollment"
    ) {
        return "System Task";
    }
    if (isSingleStepSystemTask(requestType)) return "System Task";
    return "Workflow Task";
}

function generalLifecycleStatus(taskType, closeRequest, storedStatus) {
    if (String(taskType || "") !== "General Task") return "";
    const saved = closeRequest || {};
    if (saved.closedAt && !saved.reviewPending) return "Closed";
    if (saved.reopenedAt && !saved.closedAt && storedStatus === "Pending") return "Open";
    return "";
}

function canDeleteTask(viewer, fields) {
    return viewerMayDeleteTask(viewer, fields);
}

function viewerCanReturnTask(viewer, row) {
    if (!row) return false;
    const saved = row.closeRequest || {};
    const reassigned = Boolean(saved.originalAssigneeId || saved.originalAssigneeName);
    if (!reassigned) return false;
    const status = String(row.status || "");
    if (status === "Completed" || status === "Cancelled" || status === "Rejected") return false;
    if (String(row.taskType || "") === "General Task" && saved.closedAt && !saved.reviewPending) return false;
    const current = assigneeIsViewer(viewer, String(row.assignee || ""), row.assigneeEmpId, row.assigneeName);
    if (!current) return false;
    return !viewerOwnsOriginal(viewer, row);
}

function viewerOwnsOriginal(viewer, row) {
    const id = String(row?.closeRequest?.originalAssigneeId || "");
    const ids = [viewer?.employeeObjectId, viewer?.userId].map((value) => String(value || "")).filter(Boolean);
    if (id && ids.includes(id)) return true;
    const code = String(row?.closeRequest?.originalAssigneeEmpId || "").trim().toLowerCase();
    if (
        code
        && viewer?.employeeId
        && code === String(viewer.employeeId).trim().toLowerCase()
    ) return true;
    const originalName = personKey(cleanRequester(row?.closeRequest?.originalAssigneeName));
    const viewerName = personKey(viewer?.name);
    return Boolean(originalName && viewerName && originalName === viewerName);
}

function assigneeColumns({ assigneeName, assigneeId, assigneePhoto, originalAssigneeName, originalAssigneeId, byId, photoForName, closed = false }) {
    const pair = reassignmentAssignees({ assigneeName, originalAssigneeName, closed });
    const originalRecord = byId.get(String(originalAssigneeId || ""));
    const currentPhoto = assigneePhoto || "";
    const originalPhoto = originalRecord?.profilePicture || photoForName(pair.mainAssigneeName) || "";
    const reassigned = Boolean(pair.reassignedAssigneeName);
    const originalOnly = Boolean(closed && String(originalAssigneeName || "").trim());
    return {
        mainAssigneeName: pair.mainAssigneeName,
        reassignedAssigneeName: pair.reassignedAssigneeName,
        mainAssigneePhoto: reassigned || originalOnly ? originalPhoto : currentPhoto,
        reassignedAssigneePhoto: reassigned ? currentPhoto : "",
        reassignedAssigneeId: reassigned ? String(assigneeId || "") : "",
        originalAssigneeEmpId: String(originalRecord?.employeeId || "").trim(),
        assigneeLockedToOriginal: originalOnly,
        listedAssigneeId: originalOnly ? String(originalAssigneeId || assigneeId || "") : "",
        listedAssigneeName: originalOnly ? pair.mainAssigneeName : "",
        listedAssigneePhoto: originalOnly ? originalPhoto : "",
        listedAssigneeEmpId: originalOnly ? String(originalRecord?.employeeId || "").trim() : "",
    };
}

function taskMine(viewer, { assigneeId, assigneeEmpId, assigneeName, row, requesterName, requestedByUserId, closed = false }) {
    const originalName = String(row?.closeRequest?.originalAssigneeName || "").trim();
    if (closed && originalName) return viewerOwnsOriginal(viewer, row);
    const shown = String(assigneeName || "").trim();
    const pair = reassignmentAssignees({
        assigneeName: shown,
        originalAssigneeName: row?.closeRequest?.originalAssigneeName,
    });
    if (pair.reassignedAssigneeName) {
        if (assigneeIsViewer(viewer, assigneeId, assigneeEmpId, pair.reassignedAssigneeName)) return true;
        return viewerOwnsOriginal(viewer, row);
    }
    const paren = shown.match(/\(([^)]+)\)\s*$/);
    const leadName = paren ? shown.slice(0, shown.lastIndexOf("(")).trim() : shown;
    if (assigneeIsViewer(viewer, assigneeId, assigneeEmpId, leadName)) return true;
    if (viewerOwnsOriginal(viewer, row)) return true;
    if (!paren) return false;
    if (requestedByUserId && viewer?.userId && String(requestedByUserId) === String(viewer.userId)) return true;
    const viewerName = personKey(viewer?.name);
    const requester = personKey(cleanRequester(requesterName || paren[1]));
    if (requester && viewerName && requester === viewerName) return true;
    const heldId = String(row?.closeRequest?.returnAssigneeId || "");
    const heldEmp = String(row?.closeRequest?.returnAssigneeEmpId || "");
    const heldName = String(row?.closeRequest?.returnAssigneeName || "");
    return assigneeIsViewer(viewer, heldId, heldEmp, heldName);
}

function assigneeIsViewer(viewer, assigneeId, assigneeEmpId, assigneeName = "") {
    const ids = [viewer?.employeeObjectId, viewer?.userId].map((value) => String(value || "")).filter(Boolean);
    if (assigneeId && ids.includes(String(assigneeId))) return true;
    if (
        assigneeEmpId
        && viewer?.employeeId
        && String(assigneeEmpId).trim().toLowerCase() === String(viewer.employeeId).trim().toLowerCase()
    ) {
        return true;
    }
    const name = String(viewer?.name || "").trim().toLowerCase();
    const assignee = String(assigneeName || "").trim().toLowerCase();
    return Boolean(name && assignee && name === assignee);
}

const DUPLICATE_TASK_COMMENT = "Closed: duplicate task";

function actionDuplicateKey(action) {
    const type = String(action.requestType || "");
    const requestId = String(action.requestId || "").trim();
    const extra = documentTaskLabel(action.extra1);
    const subject = String(action.subjectName || action.requestedByName || "").trim().toLowerCase();
    const assignee = String(action.assignedTo || action.assignedToEmpId || "");
    if (taskCategory(type) === "System Task") {
        if (!requestId && !extra) return "";
        return `system|${type}|${requestId}|${extra}`;
    }
    if (/^(fine|group fine request)$/i.test(type)) {
        return requestId ? `fine|${requestId}` : "";
    }
    const detail = extra && extra !== type.toLowerCase() ? extra : "";
    if (detail) return `request|${type}|${subject}|${detail}`;
    if (subject || assignee) return `request|${type}|${subject}|${assignee}`;
    if (requestId) return `request|${type}|${requestId}`;
    return "";
}

function dedupeOpenActions(actions) {
    const uniqueActions = [];
    const seenRequest = new Map();
    for (const action of actions) {
        if (action.requestType === "Task Manager") continue;
        const key = actionDuplicateKey(action);
        if (!key) {
            uniqueActions.push(action);
            continue;
        }
        const previous = seenRequest.get(key);
        if (!previous) {
            seenRequest.set(key, action);
            continue;
        }
        const openness = (status) => (status === "Pending" || status === "On Hold" ? 0 : 1);
        const previousTime = new Date(previous.requestedDate || previous.createdAt || 0).getTime();
        const nextTime = new Date(action.requestedDate || action.createdAt || 0).getTime();
        const nextIsBetter = openness(action.status) < openness(previous.status)
            || (openness(action.status) === openness(previous.status) && nextTime >= previousTime);
        if (nextIsBetter) seenRequest.set(key, action);
    }
    uniqueActions.push(...seenRequest.values());
    return uniqueActions;
}

function overlayWasCopied(overlay) {
    return Boolean(
        String(overlay?.closeRequest?.originalAssigneeId || "").trim()
        || String(overlay?.closeRequest?.originalAssigneeName || "").trim(),
    );
}

/**
 * One open task per request. Extra copies are closed, and a reassigned copy is the one kept.
 * An overlay that belonged to a closed copy moves onto the kept task when that task has none.
 */
export async function collapseDuplicateDashboardTasks(actions = [], overlays = null, { preferId = "" } = {}) {
    const pending = (actions || []).filter((action) => (
        action
        && action.requestType !== "Task Manager"
        && ["Pending", "On Hold"].includes(String(action.status || ""))
        && String(action.comment || "") !== DUPLICATE_TASK_COMMENT
    ));
    let overlayRows = Array.isArray(overlays) ? overlays : null;
    if (!overlayRows) {
        const ids = pending.map((action) => action._id).filter(Boolean);
        overlayRows = ids.length
            ? await TaskManagerTask.find({
                sourceDashboardActionId: { $in: ids },
                status: { $nin: ["Completed", "Cancelled", "Rejected"] },
            })
                .select("sourceDashboardActionId status closeRequest createdAt updatedAt")
                .lean()
            : [];
    }

    const openOverlays = overlayRows.filter((row) => (
        row?.sourceDashboardActionId
        && !["Completed", "Cancelled", "Rejected"].includes(String(row.status || ""))
    ));
    const bySource = new Map();
    for (const row of openOverlays) {
        const sourceId = String(row.sourceDashboardActionId);
        const list = bySource.get(sourceId) || [];
        list.push(row);
        bySource.set(sourceId, list);
    }

    const overlayByAction = new Map();
    const reassignedActionIds = new Set();
    const hiddenOverlayIds = new Set();
    for (const [sourceId, list] of bySource) {
        const ranked = [...list].sort((left, right) => {
            const leftRank = overlayWasCopied(left) ? 1 : 0;
            const rightRank = overlayWasCopied(right) ? 1 : 0;
            if (leftRank !== rightRank) return rightRank - leftRank;
            return new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0);
        });
        overlayByAction.set(sourceId, ranked[0]);
        if (overlayWasCopied(ranked[0])) reassignedActionIds.add(sourceId);
        for (const extra of ranked.slice(1)) hiddenOverlayIds.add(String(extra._id));
    }

    const drop = new Set();
    const groups = new Map();
    for (const action of pending) {
        const key = actionDuplicateKey(action);
        if (!key) continue;
        const list = groups.get(key) || [];
        list.push(action);
        groups.set(key, list);
    }
    const moves = [];
    for (const list of groups.values()) {
        if (list.length < 2) continue;
        const kept = chooseKeptDuplicate(list, { reassignedIds: reassignedActionIds, preferId });
        const keptId = String(kept?._id || "");
        if (!keptId) continue;
        for (const action of list) {
            const id = String(action._id);
            if (id === keptId) continue;
            drop.add(id);
            const loserOverlay = overlayByAction.get(id);
            if (!loserOverlay) continue;
            if (!overlayByAction.has(keptId)) {
                moves.push({ overlayId: loserOverlay._id, winnerId: kept._id });
                overlayByAction.set(keptId, loserOverlay);
                if (overlayWasCopied(loserOverlay)) reassignedActionIds.add(keptId);
            } else {
                hiddenOverlayIds.add(String(loserOverlay._id));
            }
            overlayByAction.delete(id);
        }
    }

    const now = new Date();
    const writes = [];
    if (drop.size) {
        writes.push(DashboardAction.updateMany(
            { _id: { $in: [...drop] }, status: { $in: ["Pending", "On Hold"] } },
            { $set: { status: "Dismissed", actionedDate: now, comment: DUPLICATE_TASK_COMMENT } },
        ));
    }
    const cancelIds = [...hiddenOverlayIds];
    if (cancelIds.length) {
        writes.push(TaskManagerTask.updateMany(
            { _id: { $in: cancelIds }, status: { $nin: ["Completed", "Cancelled"] } },
            { $set: { status: "Cancelled" } },
        ));
    }
    for (const move of moves) {
        writes.push(TaskManagerTask.updateOne(
            { _id: move.overlayId },
            { $set: { sourceDashboardActionId: move.winnerId } },
        ));
        hiddenOverlayIds.add(String(move.overlayId));
    }
    if (writes.length) await Promise.all(writes);
    if (cancelIds.length) {
        const needles = cancelIds.map((id) => String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        await DashboardAction.updateMany(
            {
                requestType: "Task Manager",
                status: "Pending",
                $or: needles.map((id) => ({ extra3: new RegExp(id) })),
            },
            { $set: { status: "Dismissed", actionedDate: now } },
        );
    }

    return {
        rows: (actions || []).filter((action) => (
            !drop.has(String(action?._id || ""))
            && String(action?.comment || "") !== DUPLICATE_TASK_COMMENT
        )),
        overlayByAction,
        hiddenOverlayIds,
    };
}

/** Close other open copies of this task after it is assigned or reassigned. */
export async function collapseOpenDuplicatesOf(action) {
    if (!action?._id || !action.requestId || !action.requestType) return;
    const siblings = await DashboardAction.find({
        requestId: action.requestId,
        requestType: action.requestType,
        status: { $in: ["Pending", "On Hold"] },
    })
        .select("requestId requestType status subjectName requestedByName assignedTo assignedToEmpId extra1 extra2 requestedDate createdAt comment")
        .lean();
    if (siblings.length < 2) return;
    await collapseDuplicateDashboardTasks(siblings, null, { preferId: String(action._id) });
}

export function displayStatus(rawStatus, requestType, requestedKey, todayKey) {
    const status = String(rawStatus || "Pending");
    if (status === "Approved") return "Completed";
    if (status === "Rejected") return "Rejected";
    if (status === "Dismissed") return "Dismissed";
    if (!PENDING_STATUSES.has(status)) return status || "Pending";

    const age = daysBetween(requestedKey, todayKey);
    // A pending task stays pending. After 2 days it is also overdue.
    if (age >= 2) return "Pending Due";
    if (status === "On Hold") return "On Hold";
    return "Pending";
}

function priorityFor(status, requestType) {
    if (status === "Pending Due") return "High";
    if (
        (status === "Pending" || status === "On Hold") &&
        /fine|salary|payment|expiry|overdue|activation/i.test(String(requestType || ""))
    ) {
        return "High";
    }
    if (status === "Pending" || status === "On Hold") return "Medium";
    return "Low";
}

function percentChange(current, previous) {
    if (!previous && !current) return 0;
    if (!previous) return 100;
    return Math.round(((current - previous) / previous) * 100);
}

export async function viewerMaySeeAllNotifications(req) {
    if (req.user?.isAdministrator || req.user?.isAdmin || req.user?.isSystemSuperUser) {
        return true;
    }

    let userId = req.user?.id || req.user?._id || null;
    if (req.user?.actor === "employee") {
        const code = String(req.user.employeeId || "").trim();
        const linked = code
            ? await User.findOne({ employeeId: code }).select("_id").lean()
            : null;
        userId = linked?._id || null;
    }
    if (!userId) return false;

    const { getUserPermissions, isUserAdministrator } = await import("../../services/permissionService.js");
    if (await isUserAdministrator(userId)) return true;

    const record = await getUserPermissions(userId);
    const permissions = record?.permissions || {};
    if (record?.isAdministrator || record?.isAdmin) return true;

    const allowed = (entry) => entry?.isView === true || entry?.isActive === true;
    if (allowed(permissions.hrm)) return true;
    return Object.keys(permissions).some((key) => key.startsWith("hrm_") && allowed(permissions[key]));
}

/**
 * Company-wide notification list.
 * Finished fines are taken off the pending list, and an open fine shows the current stage assignee.
 */
export const getTaskManagerNotifications = async (req, res) => {
    try {
        if (!(await viewerMaySeeAllNotifications(req))) {
            return res.status(403).json({
                message: "Access denied. HRM view permission is required to see every notification.",
            });
        }
        const viewer = await resolveTaskViewer(req);
        await syncPendingSalaryEnrollmentTasks();
        const promotion = promoteDueTaskCompletions().catch((error) => {
            console.error("Promote due tasks failed:", error);
        });

        const [actions, people] = await Promise.all([
            DashboardAction.find({})
                .select(
                    "assignedTo assignedToEmpId requestId requestType status subjectEmployeeId subjectName requestedDate requestedByName actionedDate extra1 extra2 extra3 createdAt",
                )
                .lean()
                .maxTimeMS(20000),
            EmployeeBasic.find({
                employeeId: { $ne: "VEGA-HR-0000" },
            })
                .select("firstName lastName employeeId profilePicture status")
                .lean(),
        ]);

        const assigneeIds = [
            ...new Set(actions.map((row) => String(row.assignedTo || "")).filter(isObjectId)),
        ];

        const byId = new Map();
        const byCode = new Map();
        const nameOwners = new Map();
        const leftUserIds = new Set();
        const leftUserCodes = new Set();
        for (const person of people) {
            const id = String(person._id);
            const code = String(person.employeeId || "").trim();
            byId.set(id, person);
            if (code) byCode.set(code, person);
            if (String(person.status || "") === "Left User") {
                leftUserIds.add(id);
                if (code) leftUserCodes.add(code.toUpperCase());
            }
            const name = personName(person).toLowerCase();
            if (!name) continue;
            const owners = nameOwners.get(name) || [];
            owners.push(person);
            nameOwners.set(name, owners);
        }

        const taskInvolvesLeftUser = (id, code) => {
            const idKey = String(id || "").trim();
            const codeKey = String(code || "").trim().toUpperCase();
            if (idKey && (leftUserIds.has(idKey) || leftUserCodes.has(idKey.toUpperCase()))) return true;
            if (codeKey && (leftUserCodes.has(codeKey) || leftUserIds.has(codeKey))) return true;
            return false;
        };

        const missingUserIds = assigneeIds.filter((id) => !byId.has(id));
        if (missingUserIds.length) {
            const users = await User.find({ _id: { $in: missingUserIds } })
                .select("name employeeId")
                .lean();
            for (const user of users) {
                byId.set(String(user._id), user);
                const code = String(user.employeeId || "").trim();
                if (code && !byCode.has(code)) byCode.set(code, user);
            }
        }

        const photoForName = (name) => {
            const owners = nameOwners.get(String(name || "").trim().toLowerCase()) || [];
            if (owners.length !== 1) return "";
            return owners[0].profilePicture || "";
        };

        const todayKey = dubaiDateKey(new Date());
        const todayParts = todayKey.split("-").map(Number);
        const thisMonth = monthKeyFromDateKey(todayKey);
        const lastMonth = shiftMonth(todayParts[0], todayParts[1], -1);

        const manualRows = await TaskManagerTask.find({})
            .select(
                "taskType priority taskName description assignee assigneeEmpId assigneeName completionDate requestedByName requestedByUserId status createdAt updatedAt sourceDashboardActionId closeRequest history",
            )
            .lean()
            .maxTimeMS(10000);
        await promotion;
        const createdRows = [];
        for (const row of manualRows) {
            if (!row.sourceDashboardActionId) createdRows.push(row);
        }

        const monthCounts = {
            total: { current: 0, previous: 0 },
            pending: { current: 0, previous: 0 },
            pendingDue: { current: 0, previous: 0 },
            completed: { current: 0, previous: 0 },
        };
        const bump = (bucket, month) => {
            if (month === thisMonth) monthCounts[bucket].current += 1;
            else if (month === lastMonth) monthCounts[bucket].previous += 1;
        };

        const summary = { total: 0, pending: 0, pendingDue: 0, completed: 0 };
        const preparedFines = await collapsePendingFineDashboardRows(actions);
        const fineOverlays = new Map();
        for (const row of manualRows) {
            if (row.sourceDashboardActionId) fineOverlays.set(String(row.sourceDashboardActionId), row);
        }
        await alignOpenFineDashboardRows(preparedFines.rows, fineOverlays);
        const collapsedTasks = await collapseDuplicateDashboardTasks(preparedFines.rows, manualRows);
        const overlayByAction = collapsedTasks.overlayByAction;
        const hiddenOverlayIds = collapsedTasks.hiddenOverlayIds;
        const actionById = new Map((actions || []).map((action) => [String(action._id), action]));
        const deletedNoticeSet = new Set(await listDeletedNoticeKeys());
        const suppressedActionIds = new Set(
            (actions || [])
                .filter((action) => noticeKeysForRecord(action).some((key) => deletedNoticeSet.has(key)))
                .map((action) => String(action._id)),
        );
        const listedTaskKeys = new Set();
        const uniqueActions = dedupeOpenActions(collapsedTasks.rows).filter((action) => {
            if (suppressedActionIds.has(String(action._id))) return false;
            const overlay = overlayByAction.get(String(action._id));
            if (taskInvolvesLeftUser(overlay?.assignee || action.assignedTo, overlay?.assigneeEmpId || action.assignedToEmpId)) {
                return false;
            }
            if (taskInvolvesLeftUser(action.subjectEmployeeId, action.subjectEmployeeId)) return false;
            return true;
        });
        const finesByRequest = preparedFines.fineInfo;

        const [sourceRequesters, vehicles, attendanceByAction] = await Promise.all([
            sourceRequesterNameMap(uniqueActions),
            vehicleDisplayById(uniqueActions),
            attendanceFactsByActionId(uniqueActions),
        ]);
        const pendingLive = uniqueActions
            .filter((action) => ["Pending", "On Hold"].includes(String(action.status || "")))
            .map((action) => {
                const vehicle = vehicles.get(vehicleRecordId(action)) || null;
                return {
                    ...action,
                    day: dubaiDateKey(action.requestedDate || action.createdAt),
                    hints: taskMatchHints(vehicle?.vehicleNo, vehicle?.assetName, vehicle?.assetNo, vehicle?.assetLabel),
                };
            });
        const liveIds = new Set(uniqueActions.map((action) => String(action._id)));
        const liveKeys = new Set(pendingLive.map((action) => actionDuplicateKey(action)).filter(Boolean));
        const keptOverlayIds = new Set(
            [...overlayByAction.values()].map((row) => String(row?._id || "")).filter(Boolean),
        );
        const duplicateOverlayIds = [];
        for (const row of manualRows) {
            if (keptOverlayIds.has(String(row._id))) continue;
            const sourceId = String(row.sourceDashboardActionId || "");
            const source = sourceId ? actionById.get(sourceId) : null;
            if (!duplicateOverlayShouldClose({
                overlay: { ...row, day: dubaiDateKey(row.createdAt) },
                source,
                liveActions: pendingLive,
                sourceIsLive: Boolean(sourceId && liveIds.has(sourceId)),
                sourceKey: source ? actionDuplicateKey(source) : "",
                liveKeys,
            })) continue;
            duplicateOverlayIds.push(row._id);
            hiddenOverlayIds.add(String(row._id));
        }
        if (duplicateOverlayIds.length) {
            const now = new Date();
            await TaskManagerTask.updateMany(
                { _id: { $in: duplicateOverlayIds }, status: { $nin: ["Completed", "Cancelled"] } },
                { $set: { status: "Cancelled" } },
            );
            const needles = duplicateOverlayIds.map((id) => String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            await DashboardAction.updateMany(
                {
                    requestType: "Task Manager",
                    status: "Pending",
                    $or: needles.map((id) => ({ extra3: new RegExp(id) })),
                },
                { $set: { status: "Dismissed", actionedDate: now } },
            );
        }
        const tasks = collapseUtilityBillReminderActions(uniqueActions).map((action) => {
            const duplicateKey = actionDuplicateKey(action);
            if (duplicateKey) listedTaskKeys.add(duplicateKey);
            const requestedAt = action.requestedDate || action.createdAt || null;
            const requestedKey = dubaiDateKey(requestedAt);
            let status = displayStatus(action.status, action.requestType, requestedKey, todayKey);
            const assignee =
                byId.get(String(action.assignedTo || "")) ||
                byCode.get(String(action.assignedToEmpId || "").trim()) ||
                null;
            const overlay = overlayByAction.get(String(action._id));
            const assigneeId = String(overlay?.assignee || action.assignedTo || "");
            const assigneeEmpId = String(overlay?.assigneeEmpId || action.assignedToEmpId || "").trim();
            const assigneeRecord = byId.get(assigneeId) || byCode.get(assigneeEmpId) || assignee;
            const assigneeName = personName(assigneeRecord) || overlay?.assigneeName || String(action.assignedToEmpId || "").trim() || "Unassigned";
            const requesterBase = displayRequesterName(
                preferRequesterName(overlay?.requestedByName, action.requestedByName),
                action,
                sourceRequesters,
            );
            const originalAssigneeName = String(overlay?.closeRequest?.originalAssigneeName || "").trim();
            const originalAssigneeId = String(overlay?.closeRequest?.originalAssigneeId || "");
            const requesterName = requesterBase;
            const assigneeClosed = String(overlay?.status || "") === "Completed"
                || (Boolean(overlay?.closeRequest?.closedAt) && !overlay?.closeRequest?.reviewPending);
            const assigneeDisplay = assigneeColumns({
                assigneeName,
                assigneeId,
                assigneePhoto: assigneeRecord?.profilePicture || "",
                originalAssigneeName,
                originalAssigneeId,
                byId,
                photoForName,
                closed: assigneeClosed,
            });
            const destination = moduleForRequestType(action.requestType, `${action.extra1 || ""} ${action.extra2 || ""}`);
            const category = taskCategory(action.requestType, action.extra2 || "");
            const priority = category === "System Task" ? "High" : (overlay?.priority || priorityFor(status, action.requestType));
            const copy = taskTitleAndDescription({
                requestType: action.requestType,
                extra1: action.extra1,
                extra2: action.extra2,
                extra3: action.extra3,
                subjectName: action.subjectName,
                subjectEmployeeId: action.subjectEmployeeId,
                comment: action.comment,
                requestedBy: requesterBase,
                taskName: overlay?.taskName,
                description: overlay?.description,
                source: {
                    ...(attendanceByAction.get(String(action._id)) || {}),
                    ...(finesByRequest.get(String(action.requestId)) || {}),
                },
                ...vehicleDisplayFor(action, vehicles),
            });
            const requestMonth = monthKeyFromDateKey(requestedKey);
            const completedMonth = monthKeyFromDateKey(dubaiDateKey(action.actionedDate || requestedAt));
            const closedReview = Boolean(overlay?.closeRequest?.closedAt) && !overlay?.closeRequest?.reviewPending;
            const life = generalLifecycleStatus(
                overlay?.taskType || (category === "General Task" ? "General Task" : ""),
                overlay?.closeRequest,
                overlay?.status,
            );
            if (overlay?.status === "Rejected") status = "Rejected";
            else if (overlay?.status === "Cancelled") status = "Cancelled";
            else if (life) status = life;
            else if (closedReview && overlay?.status !== "Completed") status = "Closed";
            else if (overlay?.status === "Completed") status = "Completed";
            else if (overlay?.status === "In Progress") status = "In Progress";
            else if (overlay?.status === "Pending" && overlay?.closeRequest?.reopenedAt) {
                status = "Open";
            }
            const actionsLocked = status === "Closed" || status === "Rejected" || status === "Cancelled";

            summary.total += 1;
            bump("total", requestMonth);
            if (status === "Pending" || status === "On Hold" || status === "Pending Due" || status === "In Progress" || status === "Reopened" || status === "Open" || status === "Pending Review") {
                summary.pending += 1;
                bump("pending", requestMonth);
                if (status === "Pending Due") {
                    summary.pendingDue += 1;
                    bump("pendingDue", requestMonth);
                }
            } else if (status === "Completed" || status === "Closed") {
                summary.completed += 1;
                bump("completed", completedMonth);
            }

            return {
                actionId: String(action._id),
                manual: false,
                workflowLocked: action.requestType !== "Task Manager",
                canReassign: !actionsLocked && (viewerCanReassign(viewer, assigneeId, assigneeEmpId) || viewerOwnsOriginal(viewer, overlay)),
                canReturn: viewerCanReturnTask(viewer, overlay),
                canDelete: !actionsLocked && canDeleteTask(viewer, {
                    taskCategory: category,
                    requestedByName: requesterBase,
                    requestedByUserId: overlay?.requestedByUserId,
                    closed: actionsLocked,
                }),
                taskNumber: "",
                requestDate: requestedAt,
                reassignedAt: latestReassignedAt(overlay),
                completionDate: overlay?.completionDate || action.actionedDate || null,
                taskCategory: category,
                accessPath: accessPathFor(destination, action.requestId, action.subjectEmployeeId, {
                    extra1: action.extra1,
                    extra2: action.extra2,
                    extra3: action.extra3,
                    requestType: action.requestType,
                }),
                requestType: action.requestType || "Notification",
                taskName: copy.taskName,
                taskSubject: copy.taskSubject || "",
                description: copy.description,
                requesterName,
                requesterBaseName: cleanRequester(requesterBase),
                requesterPhoto: photoForName(requesterBase),
                originalAssigneeName,
                originalAssigneeId,
                originalAssigneeEmpId: assigneeDisplay.originalAssigneeEmpId || String(overlay?.closeRequest?.originalAssigneeEmpId || "").trim(),
                ...assigneeDisplay,
                assigneeId: assigneeDisplay.assigneeLockedToOriginal ? assigneeDisplay.listedAssigneeId : assigneeId,
                assigneeName: assigneeDisplay.assigneeLockedToOriginal ? assigneeDisplay.listedAssigneeName : assigneeName,
                assigneePhoto: assigneeDisplay.assigneeLockedToOriginal ? assigneeDisplay.listedAssigneePhoto : (assigneeRecord?.profilePicture || ""),
                assigneeEmpId: assigneeDisplay.assigneeLockedToOriginal
                    ? (assigneeDisplay.listedAssigneeEmpId || String(overlay?.closeRequest?.originalAssigneeEmpId || "").trim())
                    : String(assigneeRecord?.employeeId || assigneeEmpId).trim(),
                priority,
                module: destination.module,
                moduleLabel: destination.label,
                modulePath: destination.path,
                mine: taskMine(viewer, {
                    assigneeId,
                    assigneeEmpId,
                    assigneeName,
                    row: overlay,
                    requesterName: requesterBase,
                    closed: assigneeClosed,
                }),
                displayStatus: status,
                rawStatus: action.status || "Pending",
                id: action.requestId ? String(action.requestId) : "",
                type: action.requestType || "",
                extra1: action.extra1 || "",
                extra2: action.extra2 || "",
                extra3: action.extra3 || "",
                targetEmployeeId: action.subjectEmployeeId || "",
                subjectName: action.subjectName || "",
                requestedBy: requesterName,
                requestedByName: requesterName,
                status: action.status || "Pending",
                requestedDate: requestedAt,
            };
        });

        const listedActionIds = new Set(tasks.map((task) => String(task.actionId || "")));
        const visibleTaskRows = [
            ...createdRows,
            ...manualRows.filter((row) => {
                if (hiddenOverlayIds.has(String(row._id))) return false;
                const sourceId = String(row.sourceDashboardActionId || "");
                if (sourceId && suppressedActionIds.has(sourceId)) return false;
                if (!sourceId || listedActionIds.has(sourceId)) return false;
                const source = actionById.get(sourceId);
                const sourceKey = source ? actionDuplicateKey(source) : "";
                if (sourceKey && listedTaskKeys.has(sourceKey)) return false;
                return true;
            }),
        ];

        for (const row of visibleTaskRows) {
            if (taskInvolvesLeftUser(row.assignee, row.assigneeEmpId)) continue;
            const requestedAt = row.createdAt || null;
            const requestedKey = dubaiDateKey(requestedAt);
            const dueKey = dubaiDateKey(row.completionDate);
            const closedReview = Boolean(row.closeRequest?.closedAt) && !row.closeRequest?.reviewPending;
            const open = row.status !== "Completed" && row.status !== "Cancelled" && row.status !== "Rejected" && !closedReview;
            const generalReview = String(row.taskType || "") === "General Task" && !row.sourceDashboardActionId;
            const life = generalLifecycleStatus(row.taskType, row.closeRequest, row.status);
            const status = row.status === "Rejected"
                ? "Rejected"
                : row.status === "Cancelled"
                ? "Cancelled"
                : life
                ? life
                : closedReview
                ? "Closed"
                : row.status === "Completed"
                ? "Completed"
                : generalReview && row.closeRequest?.reviewPending
                        ? "Pending Review"
                        : generalReview && row.closeRequest?.reviewReturned
                            ? "Open"
                            : row.status === "Pending" && row.closeRequest?.reopenedAt && !row.closeRequest?.reviewPending
                                ? "Open"
                                : open && daysBetween(requestedKey, todayKey) >= 2
                                    ? "Pending Due"
                                    : "Pending";
            const actionsLocked = status === "Closed" || status === "Rejected" || status === "Cancelled";
            const assignee = byId.get(String(row.assignee || "")) || null;
            const heldAssignee = String(row.closeRequest?.returnAssigneeName || "").trim();
            const rawAssigneeName = heldAssignee || personName(assignee) || row.assigneeName || row.assigneeEmpId || "Unassigned";
            const requesterPlain = String(row.requestedByName || "").trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
            const assigneeName = heldAssignee && requesterPlain && requesterPlain.toLowerCase() !== heldAssignee.toLowerCase()
                ? `${heldAssignee} (${requesterPlain})`
                : rawAssigneeName;
            const requesterBase = String(row.requestedByName || "").trim() || "System";
            const originalAssigneeName = String(row.closeRequest?.originalAssigneeName || "").trim();
            const originalAssigneeId = String(row.closeRequest?.originalAssigneeId || "");
            const requesterName = requesterBase;
            const assigneeId = String(row.assignee || "");
            const assigneeClosed = status === "Completed" || status === "Closed";
            const assigneeDisplay = assigneeColumns({
                assigneeName,
                assigneeId,
                assigneePhoto: assignee?.profilePicture || "",
                originalAssigneeName,
                originalAssigneeId,
                byId,
                photoForName,
                closed: assigneeClosed,
            });
            const requestMonth = monthKeyFromDateKey(requestedKey);
            const completedMonth = monthKeyFromDateKey(dueKey);

            summary.total += 1;
            bump("total", requestMonth);
            if (status === "Closed" || status === "Completed") {
                summary.completed += 1;
                bump("completed", completedMonth);
            } else if (status === "Pending" || status === "Pending Due" || status === "Pending Review" || status === "Open" || status === "Reopened") {
                summary.pending += 1;
                bump("pending", requestMonth);
                if (status === "Pending Due") {
                    summary.pendingDue += 1;
                    bump("pendingDue", requestMonth);
                }
            }

            const destination = moduleForText(row.taskName, row.description, row.taskType);
            const category = displayTaskType(row.taskType);
            tasks.push({
                actionId: row.sourceDashboardActionId ? String(row.sourceDashboardActionId) : `manual-${row._id}`,
                manual: true,
                workflowLocked: false,
                canReassign: !actionsLocked && (viewerCanReassign(viewer, assigneeId, row.assigneeEmpId) || viewerOwnsOriginal(viewer, row)),
                canReturn: viewerCanReturnTask(viewer, row),
                canDelete: !actionsLocked && canDeleteTask(viewer, {
                    taskCategory: category,
                    requestedByName: requesterName,
                    requestedByUserId: row.requestedByUserId,
                    closed: actionsLocked,
                }),
                taskNumber: "",
                requestDate: requestedAt,
                reassignedAt: latestReassignedAt(row),
                completionDate: row.completionDate || null,
                taskCategory: category,
                accessPath: accessPathFor(destination, "", ""),
                requestType: displayTaskType(row.taskType),
                taskName: row.taskName || "Task",
                taskSubject: "",
                description: row.description || "",
                requesterName,
                requesterBaseName: cleanRequester(requesterBase),
                requesterPhoto: photoForName(requesterBase),
                originalAssigneeName,
                originalAssigneeId,
                originalAssigneeEmpId: assigneeDisplay.originalAssigneeEmpId || String(row.closeRequest?.originalAssigneeEmpId || "").trim(),
                ...assigneeDisplay,
                assigneeId: assigneeDisplay.assigneeLockedToOriginal ? assigneeDisplay.listedAssigneeId : assigneeId,
                assigneeName: assigneeDisplay.assigneeLockedToOriginal ? assigneeDisplay.listedAssigneeName : assigneeName,
                assigneePhoto: assigneeDisplay.assigneeLockedToOriginal ? assigneeDisplay.listedAssigneePhoto : (assignee?.profilePicture || ""),
                assigneeEmpId: assigneeDisplay.assigneeLockedToOriginal
                    ? (assigneeDisplay.listedAssigneeEmpId || String(row.closeRequest?.originalAssigneeEmpId || "").trim())
                    : String(assignee?.employeeId || row.assigneeEmpId || "").trim(),
                priority: category === "System Task" ? "High" : (row.priority || "Medium"),
                module: destination.module,
                moduleLabel: destination.label,
                modulePath: destination.path,
                mine: taskMine(viewer, {
                    assigneeId,
                    assigneeEmpId: row.assigneeEmpId,
                    assigneeName,
                    row,
                    requesterName: requesterBase,
                    requestedByUserId: row.requestedByUserId,
                    closed: assigneeClosed,
                }),
                displayStatus: status,
                rawStatus: row.status || "Pending",
                id: String(row._id),
                type: displayTaskType(row.taskType),
                extra1: row.description || row.taskName || "",
                extra2: "",
                extra3: "",
                targetEmployeeId: row.assigneeEmpId || "",
                subjectName: assigneeDisplay.assigneeLockedToOriginal ? assigneeDisplay.listedAssigneeName : assigneeName,
                requestedBy: requesterName,
                requestedByName: requesterName,
                status: row.status || "Pending",
                requestedDate: requestedAt,
            });
        }

        assignTaskNumbers(tasks);

        const statusRank = {
            "Pending Due": 0,
            Pending: 1,
            "In Progress": 2,
            "On Hold": 3,
            Completed: 4,
            Cancelled: 5,
            Rejected: 6,
            Dismissed: 7,
        };
        const priorityRank = { High: 0, Medium: 1, Low: 2 };
        const signedPhotos = new Map();
        const signPhoto = (raw) => {
            const text = String(raw || "").trim().replace(/^\/+/, "");
            if (!text) return Promise.resolve("");
            const cached = signedPhotos.get(text);
            if (cached) return cached;
            const pending = (async () => {
                if (text.startsWith("http") && isPresignedUrlStillFresh(text)) return text;
                try {
                    const signed = await getSignedFileUrl(text);
                    return signed && String(signed).startsWith("http") ? signed : "";
                } catch {
                    return "";
                }
            })();
            signedPhotos.set(text, pending);
            return pending;
        };
        await Promise.all(tasks.map(async (task) => {
            task.requesterPhoto = await signPhoto(task.requesterPhoto);
            task.assigneePhoto = await signPhoto(task.assigneePhoto);
            task.mainAssigneePhoto = await signPhoto(task.mainAssigneePhoto);
            task.reassignedAssigneePhoto = await signPhoto(task.reassignedAssigneePhoto);
        }));

        tasks.sort((a, b) => {
            const priorityGap = (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
            if (priorityGap) return priorityGap;
            const statusGap = (statusRank[a.displayStatus] ?? 9) - (statusRank[b.displayStatus] ?? 9);
            if (statusGap) return statusGap;
            const aTime = new Date(a.requestDate || 0).getTime();
            const bTime = new Date(b.requestDate || 0).getTime();
            return bTime - aTime;
        });

        return res.status(200).json({
            canSeeAllTasks: true,
            summary: {
                ...summary,
                totalChange: percentChange(monthCounts.total.current, monthCounts.total.previous),
                pendingChange: percentChange(monthCounts.pending.current, monthCounts.pending.previous),
                pendingDueChange: percentChange(monthCounts.pendingDue.current, monthCounts.pendingDue.previous),
                completedChange: percentChange(monthCounts.completed.current, monthCounts.completed.previous),
            },
            tasks,
        });
    } catch (error) {
        console.error("Task Manager notifications error:", error);
        return res.status(500).json({ message: "Failed to load task manager notifications" });
    }
};

function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function personKey(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function holdsOriginal(row, { id = "", code = "", nameKey = "" } = {}) {
    if (!row?.closeRequest) return false;
    const originalId = String(row.closeRequest.originalAssigneeId || "");
    if (id && originalId && originalId === String(id)) return true;
    const originalCode = String(row.closeRequest.originalAssigneeEmpId || "").trim().toLowerCase();
    if (code && originalCode && originalCode === String(code).trim().toLowerCase()) return true;
    return Boolean(nameKey && personKey(row.closeRequest.originalAssigneeName) === nameKey);
}

function profileStatusLabel(status) {
    const value = String(status || "");
    if (value === "Completed") return "Completed";
    if (value === "Closed") return "Closed";
    if (value === "Reopened") return "Reopened";
    if (value === "Pending Due" || value === "Overdue") return "Overdue";
    if (value === "Cancelled" || value === "Rejected" || value === "Dismissed") return "Closed";
    return "Pending";
}

function formatProfileDay(value) {
    const key = dubaiDateKey(value);
    if (!key) return "";
    const [year, month, day] = key.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
    });
}

/**
 * Open tasks for this employee.
 * A leave task is included when they requested it and when they are the approver.
 * ownRequest is only the leave this employee asked for. Approval tasks stay on the task card.
 */
const PROFILE_LEAVE_TYPES = new Set(["Employee Leave Request", "Attendance Leave Request"]);
const PROFILE_ACTION_SELECT = "assignedTo assignedToEmpId requestId requestType status requestedDate requestedByName subjectEmployeeId subjectName extra1 extra2 extra3 createdAt";

function actionMeta(extra3) {
    try {
        const parsed = JSON.parse(String(extra3 || ""));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function dateKeyOrBlank(value) {
    const text = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function assigneeIdOf(value) {
    if (!value) return "";
    if (typeof value === "object") return String(value._id || "");
    return String(value);
}

function assigneeNameOf(value) {
    if (!value || typeof value !== "object") return "";
    return [value.firstName, value.lastName].filter(Boolean).join(" ").trim();
}

function leaveRequestedByEmployee(action, { id, code, nameKey }) {
    if (!PROFILE_LEAVE_TYPES.has(String(action?.requestType || ""))) return false;
    const subjectId = String(action.subjectEmployeeId || "").trim();
    if (code && subjectId && subjectId.toLowerCase() === code.toLowerCase()) return true;
    if (id && subjectId === id) return true;
    const meta = actionMeta(action.extra3);
    const mongoIds = [meta.employeeMongoId, meta.requesterMongoId].map((value) => String(value || "").trim());
    if (id && mongoIds.includes(id)) return true;
    if (nameKey && personKey(action.subjectName) === nameKey) return true;
    return false;
}

/** Salary preparation follows the employee the leave is for, not the person who filed it. */
function leaveSubjectIsProfileEmployee(action, { id, code, nameKey }) {
    if (!PROFILE_LEAVE_TYPES.has(String(action?.requestType || ""))) return false;
    const subjectId = String(action.subjectEmployeeId || "").trim();
    if (code && subjectId && subjectId.toLowerCase() === code.toLowerCase()) return true;
    if (id && subjectId === id) return true;
    const meta = actionMeta(action.extra3);
    const subjectMongo = String(meta.employeeMongoId || "").trim();
    if (id && subjectMongo && subjectMongo === id) return true;
    if (nameKey && personKey(action.subjectName) === nameKey) return true;
    return false;
}

function leaveSubjectMongoId(action, meta) {
    const mongo = String(meta?.employeeMongoId || meta?.requesterMongoId || "").trim();
    if (isObjectId(mongo)) return mongo;
    const subject = String(action?.subjectEmployeeId || "").trim();
    return isObjectId(subject) ? subject : "";
}

function leaveReviewHref(action) {
    const meta = actionMeta(action?.extra3);
    const from = dateKeyOrBlank(meta.from) || dateKeyOrBlank(meta.date) || dateKeyOrBlank(action?.extra1);
    const to = dateKeyOrBlank(meta.to) || from;
    const attendanceId = String(meta.attendanceId || "").trim();
    const employeeId = leaveSubjectMongoId(action, meta);
    const employeeName = String(action?.subjectName || action?.requestedByName || "").trim();
    if (String(action?.requestType || "") === "Attendance Leave Request" && !meta.leaveDashboard) {
        const params = new URLSearchParams();
        if (from) params.set("date", from);
        const group = String(meta.staffType || "office").trim().toLowerCase() || "office";
        params.set("staffType", group);
        params.set("group", group);
        if (employeeId) params.set("blinkEmployee", employeeId);
        const requestId = String(attendanceId || action?.requestId || "").trim();
        if (requestId) params.set("leaveAttendanceId", requestId);
        const query = params.toString();
        return query ? `/HRM/Attendance/mark?${query}` : "/HRM/Attendance/mark";
    }
    const params = new URLSearchParams();
    if (employeeId) params.set("employeeId", employeeId);
    if (employeeName) params.set("employeeName", employeeName);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("group", String(meta.staffType || "office").trim().toLowerCase() || "office");
    const approvalId = attendanceId || String(action?.requestId || "").trim();
    if (approvalId) params.set("approvalId", approvalId);
    const query = params.toString();
    return query ? `/HRM/Leave/annual-leave?${query}` : "/HRM/Leave/annual-leave";
}

function leaveCardFromAction(action, ownerName, { ownRequest = false, reassigned = false } = {}) {
    const meta = actionMeta(action?.extra3);
    const from = dateKeyOrBlank(meta.from) || dateKeyOrBlank(meta.date) || dateKeyOrBlank(action?.extra1);
    const to = dateKeyOrBlank(meta.to) || from;
    const requestedKey = dateKeyOrBlank(dubaiDateKey(action?.requestedDate || action?.createdAt));
    return {
        id: `leave-task-${action._id}`,
        requestId: String(action.requestId || ""),
        title: String(action.extra2 || "").trim() || "Leave request",
        subtitle: from && to && from !== to ? `${from} → ${to}` : from || "Awaiting approval",
        status: "Approval Pending",
        owner: String(ownerName || "").trim() || "Approver",
        fromDate: from,
        toDate: to,
        dateKey: requestedKey || from,
        dateLabel: formatProfileDay(action?.requestedDate || action?.createdAt),
        href: leaveReviewHref(action),
        spanAllMonths: true,
        ownRequest: Boolean(ownRequest) && !reassigned,
        reassigned: Boolean(reassigned),
    };
}

export async function listProfileEmployeeTasks({ employeeId, employeeCode, employeeName, limit = 10 } = {}) {
    try {
        const id = String(employeeId || "");
        const code = String(employeeCode || "").trim();
        const name = String(employeeName || "").trim();
        const nameKey = personKey(name);
        const manualOr = [];
        const actionOr = [];
        if (isObjectId(id)) {
            manualOr.push({ assignee: id });
            manualOr.push({ "closeRequest.originalAssigneeId": id });
            actionOr.push({ assignedTo: id });
        }
        if (code) {
            manualOr.push({ assigneeEmpId: code });
            manualOr.push({ "closeRequest.originalAssigneeEmpId": code });
            actionOr.push({ assignedToEmpId: code });
        }
        if (name) {
            const pattern = new RegExp(`^${name.split(/\s+/).map(escapeRegex).join("\\s+")}$`, "i");
            const wrapped = new RegExp(`(?:^|\\()${name.split(/\s+/).map(escapeRegex).join("\\s+")}(?:\\)|$)`, "i");
            manualOr.push({ assigneeName: pattern });
            manualOr.push({ "closeRequest.originalAssigneeName": pattern });
            manualOr.push({
                "closeRequest.originalAssigneeName": { $nin: ["", null] },
                requestedByName: wrapped,
            });
        }
        const leaveOr = [];
        if (isObjectId(id)) {
            leaveOr.push({ assignedTo: id });
            leaveOr.push({ subjectEmployeeId: id });
            leaveOr.push({ extra3: new RegExp(`"(?:employeeMongoId|requesterMongoId)":"${escapeRegex(id)}"`) });
        }
        if (code) {
            leaveOr.push({ assignedToEmpId: code });
            leaveOr.push({ subjectEmployeeId: code });
        }
        const hubOr = [];
        if (isObjectId(id)) hubOr.push({ requester: id }, { assignedTo: id });
        if (!manualOr.length && !actionOr.length && !leaveOr.length && !hubOr.length) {
            return { tasks: [], pendingCount: 0, leaveCards: [] };
        }

        const [manualRows, actionRows, leaveRows, hubRows] = await Promise.all([
            manualOr.length
                ? TaskManagerTask.find({
                    status: { $in: ["Pending", "In Progress"] },
                    $or: manualOr,
                })
                    .select("taskType assignee assigneeEmpId assigneeName completionDate requestedByName status createdAt sourceDashboardActionId closeRequest")
                    .sort({ createdAt: -1 })
                    .limit(80)
                    .lean()
                    .maxTimeMS(8000)
                : [],
            actionOr.length
                ? DashboardAction.find({
                    status: { $in: ["Pending", "On Hold"] },
                    requestType: { $ne: "Task Manager" },
                    $or: actionOr,
                })
                    .select("assignedTo assignedToEmpId requestId requestType status requestedDate requestedByName subjectEmployeeId subjectName extra1 extra2 extra3 createdAt")
                    .sort({ createdAt: -1 })
                    .limit(200)
                    .lean()
                    .maxTimeMS(8000)
                : [],
            leaveOr.length
                ? DashboardAction.find({
                    status: { $in: ["Pending", "On Hold"] },
                    requestType: { $in: [...PROFILE_LEAVE_TYPES] },
                    $or: leaveOr,
                })
                    .select(PROFILE_ACTION_SELECT)
                    .populate("assignedTo", "firstName lastName employeeId")
                    .sort({ createdAt: -1 })
                    .limit(100)
                    .lean()
                    .maxTimeMS(8000)
                : [],
            hubOr.length
                ? EmployeeHubRequest.find({
                    status: "Pending",
                    kind: "leave",
                    $or: hubOr,
                })
                    .select("description requester requesterName assignedTo createdAt")
                    .populate("assignedTo", "firstName lastName employeeId")
                    .populate("requester", "firstName lastName employeeId")
                    .sort({ createdAt: -1 })
                    .limit(50)
                    .lean()
                    .maxTimeMS(8000)
                : [],
        ]);

        const actionById = new Map((actionRows || []).map((row) => [String(row._id), row]));
        for (const row of leaveRows || []) actionById.set(String(row._id), row);
        const missingSourceIds = (manualRows || [])
            .map((row) => String(row.sourceDashboardActionId || ""))
            .filter((sourceId) => isObjectId(sourceId) && !actionById.has(sourceId));
        if (missingSourceIds.length) {
            const extra = await DashboardAction.find({ _id: { $in: missingSourceIds } })
                .select(PROFILE_ACTION_SELECT)
                .lean()
                .maxTimeMS(8000);
            for (const row of extra || []) actionById.set(String(row._id), row);
        }

        const overlayByAction = new Map();
        const createdRows = [];
        for (const row of manualRows || []) {
            if (row.sourceDashboardActionId) overlayByAction.set(String(row.sourceDashboardActionId), row);
            else createdRows.push(row);
        }
        const overlayIds = [...actionById.keys()].filter((actionId) => !overlayByAction.has(actionId));
        if (overlayIds.length) {
            const overlays = await TaskManagerTask.find({ sourceDashboardActionId: { $in: overlayIds } })
                .select("taskType assignee assigneeEmpId assigneeName completionDate requestedByName status createdAt sourceDashboardActionId closeRequest")
                .lean()
                .maxTimeMS(8000);
            for (const row of overlays || []) overlayByAction.set(String(row.sourceDashboardActionId), row);
        }

        const todayKey = dubaiDateKey(new Date());
        const assignedToEmployee = ({ assigneeId, assigneeEmpId, assigneeName }) => {
            if (id && assigneeId && String(assigneeId) === id) return true;
            if (code && assigneeEmpId && String(assigneeEmpId).trim().toLowerCase() === code.toLowerCase()) return true;
            if (nameKey && personKey(assigneeName) === nameKey) return true;
            return false;
        };

        const preparedProfile = await collapsePendingFineDashboardRows([...actionById.values()]);
        await alignOpenFineDashboardRows(preparedProfile.rows, overlayByAction);
        const collapsedProfile = await collapseDuplicateDashboardTasks(preparedProfile.rows);
        const profileOverlays = collapsedProfile.overlayByAction;
        const sourceRequesters = await sourceRequesterNameMap(collapsedProfile.rows);
        const rows = [];
        for (const action of dedupeOpenActions(collapsedProfile.rows)) {
            const overlay = profileOverlays.get(String(action._id));
            const requestedAt = action.requestedDate || action.createdAt || null;
            const requestedKey = dubaiDateKey(requestedAt);
            let status = displayStatus(action.status, action.requestType, requestedKey, todayKey);
            const closedReview = Boolean(overlay?.closeRequest?.closedAt) && !overlay?.closeRequest?.reviewPending;
            const profileCategory = taskCategory(action.requestType, action.extra2 || "");
            const life = generalLifecycleStatus(
                overlay?.taskType || (profileCategory === "General Task" ? "General Task" : ""),
                overlay?.closeRequest,
                overlay?.status,
            );
            if (overlay?.status === "Rejected") status = "Rejected";
            else if (overlay?.status === "Cancelled") status = "Cancelled";
            else if (life) status = life;
            else if (closedReview && overlay?.status !== "Completed") status = "Closed";
            else if (overlay?.status === "Completed") status = "Completed";
            else if (overlay?.status === "In Progress") status = "In Progress";
            else if (overlay?.status === "Pending" && overlay?.closeRequest?.reopenedAt) {
                status = "Open";
            }
            const requesterBase = displayRequesterName(
                preferRequesterName(overlay?.requestedByName, action.requestedByName),
                action,
                sourceRequesters,
            );
            const originalAssigneeName = String(overlay?.closeRequest?.originalAssigneeName || "").trim();
            const requesterName = requesterBase;
            const rawAssignee = action.assignedTo;
            const assigneeId = String(overlay?.assignee || assigneeIdOf(rawAssignee) || "");
            const assigneeEmpId = String(overlay?.assigneeEmpId || action.assignedToEmpId || rawAssignee?.employeeId || "").trim();
            const assigneeName = String(overlay?.assigneeName || assigneeNameOf(rawAssignee) || "").trim();
            const requesterMatch = leaveRequestedByEmployee(action, { id, code, nameKey });
            const originalHold = holdsOriginal(overlay, { id, code, nameKey });
            const reassignedRequester = Boolean(originalAssigneeName) && personKey(cleanRequester(requesterBase)) === nameKey;
            if (!assignedToEmployee({ assigneeId, assigneeEmpId, assigneeName }) && !requesterMatch && !originalHold && !reassignedRequester) continue;
            const leaveTask = PROFILE_LEAVE_TYPES.has(String(action.requestType || ""));
            const reassigned = Boolean(
                String(overlay?.closeRequest?.originalAssigneeId || "").trim()
                || String(overlay?.closeRequest?.originalAssigneeName || "").trim(),
            );
            rows.push({
                actionId: String(action._id),
                requestId: String(action.requestId || ""),
                taskType: taskCategory(action.requestType, action.extra2 || ""),
                requesterName: requesterName || "System",
                requestedAt,
                dueAt: overlay?.completionDate || (leaveTask ? dateKeyOrBlank(actionMeta(action.extra3).to) || null : null),
                status: profileStatusLabel(status),
                sortAt: new Date(requestedAt || 0).getTime(),
                href: leaveTask ? leaveReviewHref(action) : "",
                leaveCard: leaveTask
                    ? leaveCardFromAction(action, assigneeName, {
                        ownRequest: leaveSubjectIsProfileEmployee(action, { id, code, nameKey }),
                        reassigned,
                    })
                    : null,
            });
        }

        for (const row of createdRows) {
            const requestedAt = row.createdAt || null;
            const requestedKey = dubaiDateKey(requestedAt);
            const open = row.status !== "Completed" && row.status !== "Cancelled" && row.status !== "Rejected";
            const life = generalLifecycleStatus(row.taskType, row.closeRequest, row.status);
            const status = life
                ? life
                : row.status === "Completed"
                ? "Completed"
                : row.status === "Cancelled"
                    ? "Cancelled"
                    : row.status === "Rejected"
                        ? "Rejected"
                        : open && daysBetween(requestedKey, todayKey) >= 2
                            ? "Pending Due"
                            : "Pending";
            const requesterBase = String(row.requestedByName || "").trim() || "System";
            const originalAssigneeName = String(row.closeRequest?.originalAssigneeName || "").trim();
            const requesterName = requesterBase;
            const assigneeId = String(row.assignee || "");
            const assigneeEmpId = String(row.assigneeEmpId || "").trim();
            const assigneeName = String(row.assigneeName || "").trim();
            const originalHold = holdsOriginal(row, { id, code, nameKey });
            const reassignedRequester = Boolean(originalAssigneeName) && personKey(cleanRequester(requesterBase)) === nameKey;
            if (!assignedToEmployee({ assigneeId, assigneeEmpId, assigneeName }) && !originalHold && !reassignedRequester) continue;
            rows.push({
                actionId: `manual-${row._id}`,
                requestId: String(row._id),
                taskType: displayTaskType(row.taskType),
                requesterName,
                requestedAt,
                dueAt: row.completionDate || null,
                status: profileStatusLabel(status),
                sortAt: new Date(requestedAt || 0).getTime(),
                href: "",
                leaveCard: null,
            });
        }

        const seenRequestIds = new Set(rows.map((row) => String(row.requestId || "")).filter(Boolean));
        for (const hub of hubRows || []) {
            const requestId = String(hub._id || "");
            if (!requestId || seenRequestIds.has(requestId)) continue;
            const requesterId = assigneeIdOf(hub.requester);
            const receiverId = assigneeIdOf(hub.assignedTo);
            const involved = (id && (requesterId === id || receiverId === id));
            if (!involved) continue;
            const hubOwnRequest = Boolean(id && requesterId === id);
            const action = {
                _id: hub._id,
                requestId: hub._id,
                requestType: "Employee Leave Request",
                extra2: "Leave request",
                extra3: JSON.stringify({
                    leaveDashboard: true,
                    requesterMongoId: requesterId,
                    employeeMongoId: requesterId,
                }),
                requestedByName: hub.requesterName || assigneeNameOf(hub.requester) || "Employee",
                requestedDate: hub.createdAt,
                createdAt: hub.createdAt,
            };
            const requestedAt = hub.createdAt || null;
            rows.push({
                actionId: `hub-${requestId}`,
                requestId,
                taskType: "Workflow Task",
                requesterName: action.requestedByName,
                requestedAt,
                dueAt: null,
                status: "Pending",
                sortAt: new Date(requestedAt || 0).getTime(),
                href: leaveReviewHref(action),
                leaveCard: leaveCardFromAction(action, assigneeNameOf(hub.assignedTo), { ownRequest: hubOwnRequest }),
            });
        }

        const openRows = rows.filter((row) => row.status === "Pending" || row.status === "Overdue");
        const numbers = await taskNumbersByRecordId(openRows.flatMap((row) => [row.actionId, row.requestId]));
        const rank = { Overdue: 0, Pending: 1 };
        openRows.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.sortAt - a.sortAt);
        const tasks = openRows.slice(0, Math.max(1, Number(limit) || 10)).map((row) => ({
            actionId: row.actionId,
            taskNumber: numbers.get(row.actionId) || numbers.get(row.requestId) || "",
            taskType: row.taskType || "Workflow Task",
            requesterName: row.requesterName,
            requestedDate: formatProfileDay(row.requestedAt),
            dueDate: formatProfileDay(row.dueAt),
            status: row.status,
            href: row.href || "",
        }));
        const leaveCards = openRows.map((row) => row.leaveCard).filter(Boolean);
        return { tasks, pendingCount: openRows.length, leaveCards };
    } catch (error) {
        console.error("[listProfileEmployeeTasks]", error);
        return { tasks: [], pendingCount: 0, leaveCards: [] };
    }
}

/**
 * The same TSK-26-count shown in Task Manager, keyed by the request id and the action id.
 */
export async function taskNumbersByRecordId(recordIds) {
    const wanted = [...new Set((recordIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!wanted.length) return new Map();

    const [actions, manualRows] = await Promise.all([
        DashboardAction.find({})
            .select("requestId requestType status subjectName requestedByName assignedTo assignedToEmpId extra1 requestedDate createdAt")
            .lean()
            .maxTimeMS(12000),
        TaskManagerTask.find({})
            .select("sourceDashboardActionId createdAt")
            .lean()
            .maxTimeMS(8000),
    ]);

    const preparedNumbers = await collapsePendingFineDashboardRows(actions || []);
    const collapsedNumbers = await collapseDuplicateDashboardTasks(preparedNumbers.rows);
    const unique = dedupeOpenActions(collapsedNumbers.rows);
    const stubs = unique.map((action) => ({
        actionId: String(action._id),
        requestDate: action.requestedDate || action.createdAt || null,
        requestId: String(action.requestId || "").trim(),
    }));
    for (const row of manualRows || []) {
        if (row?.sourceDashboardActionId) continue;
        stubs.push({
            actionId: `manual-${row._id}`,
            requestDate: row.createdAt || null,
            requestId: String(row._id),
        });
    }

    assignTaskNumbers(stubs);
    const numberByActionId = new Map(stubs.map((task) => [task.actionId, task.taskNumber]));
    const winnerIdByKey = new Map();
    for (const action of unique) {
        const key = actionDuplicateKey(action);
        if (key) winnerIdByKey.set(key, String(action._id));
    }

    const byId = new Map();
    for (const task of stubs) {
        if (task.requestId) byId.set(task.requestId, task.taskNumber);
        if (task.actionId) byId.set(task.actionId, task.taskNumber);
    }
    for (const action of actions || []) {
        const requestId = String(action.requestId || "").trim();
        if (!requestId || byId.has(requestId)) continue;
        const winnerId = winnerIdByKey.get(actionDuplicateKey(action));
        const number = winnerId ? numberByActionId.get(winnerId) : "";
        if (number) byId.set(requestId, number);
    }

    const found = new Map();
    for (const id of wanted) {
        const number = byId.get(id);
        if (number) found.set(id, number);
    }
    return found;
}

const OPEN_MANUAL_STATUSES = new Set(["Pending", "In Progress"]);

/** Open tasks assigned to the logged-in user. This is the Task Manager sidebar badge. */
export async function countOpenTasksForAssignee(viewer) {
    const ids = [viewer?.employeeObjectId, viewer?.userId].map((value) => String(value || "")).filter(isObjectId);
    const code = String(viewer?.employeeId || "").trim();
    const assigneeOr = [];
    if (ids.length) assigneeOr.push({ assignedTo: { $in: ids } });
    if (code) assigneeOr.push({ assignedToEmpId: code });

    const actions = assigneeOr.length
        ? await DashboardAction.find({
            status: { $in: ["Pending", "On Hold"] },
            requestType: { $ne: "Task Manager" },
            $or: assigneeOr,
        })
            .select("requestId requestType status subjectName requestedByName assignedTo assignedToEmpId extra1 requestedDate createdAt")
            .lean()
            .maxTimeMS(8000)
        : [];

    const collapsedFines = await collapsePendingFineDashboardRows(actions);
    await alignOpenFineDashboardRows(collapsedFines.rows);
    const requestIds = [...new Set(collapsedFines.rows.map((action) => action.requestId).filter(Boolean))];
    const siblings = requestIds.length
        ? await DashboardAction.find({
            requestId: { $in: requestIds },
            status: { $in: ["Pending", "On Hold"] },
            requestType: { $ne: "Task Manager" },
        })
            .select("requestId requestType status subjectName requestedByName assignedTo assignedToEmpId extra1 extra2 requestedDate createdAt comment")
            .lean()
        : [];
    const collapsedOpen = await collapseDuplicateDashboardTasks(siblings.length ? siblings : collapsedFines.rows);
    const unique = dedupeOpenActions(collapsedOpen.rows);
    const actionIds = unique.map((row) => row._id).filter(Boolean);
    const overlayOr = [];
    if (actionIds.length) overlayOr.push({ sourceDashboardActionId: { $in: actionIds } });
    if (ids.length) overlayOr.push({ assignee: { $in: ids } });
    if (code) overlayOr.push({ assigneeEmpId: code });

    const overlays = overlayOr.length
        ? await TaskManagerTask.find({ $or: overlayOr })
            .select("assignee assigneeEmpId assigneeName sourceDashboardActionId status taskName description createdAt")
            .lean()
            .maxTimeMS(8000)
        : [];

    const pendingLive = unique
        .filter((action) => ["Pending", "On Hold"].includes(String(action.status || "")))
        .map((action) => ({
            ...action,
            day: dubaiDateKey(action.requestedDate || action.createdAt),
        }));
    const liveIds = new Set(unique.map((action) => String(action._id)));
    const liveKeys = new Set(pendingLive.map((action) => actionDuplicateKey(action)).filter(Boolean));
    const sourceById = new Map((collapsedOpen.rows || []).map((action) => [String(action._id), action]));
    const duplicateOverlayIds = [];
    for (const row of overlays) {
        const sourceId = String(row.sourceDashboardActionId || "");
        const source = sourceById.get(sourceId) || null;
        if (!duplicateOverlayShouldClose({
            overlay: { ...row, day: dubaiDateKey(row.createdAt) },
            source,
            liveActions: pendingLive,
            sourceIsLive: Boolean(sourceId && liveIds.has(sourceId)),
            sourceKey: source ? actionDuplicateKey(source) : "",
            liveKeys,
        })) continue;
        duplicateOverlayIds.push(row._id);
    }
    if (duplicateOverlayIds.length) {
        await TaskManagerTask.updateMany(
            { _id: { $in: duplicateOverlayIds }, status: { $nin: ["Completed", "Cancelled"] } },
            { $set: { status: "Cancelled" } },
        );
    }
    const closedOverlayIds = new Set(duplicateOverlayIds.map((id) => String(id)));

    const overlayByAction = new Map();
    let manualOpen = 0;
    const countedManual = new Set();
    for (const row of overlays) {
        if (closedOverlayIds.has(String(row._id))) continue;
        if (row.sourceDashboardActionId) {
            overlayByAction.set(String(row.sourceDashboardActionId), row);
            continue;
        }
        const key = String(row._id);
        if (countedManual.has(key)) continue;
        if (!OPEN_MANUAL_STATUSES.has(row.status || "Pending")) continue;
        if (!assigneeIsViewer(viewer, row.assignee, row.assigneeEmpId, row.assigneeName)) continue;
        countedManual.add(key);
        manualOpen += 1;
    }

    const countedActions = new Set(actionIds.map((id) => String(id)));
    let actionOpen = 0;
    for (const action of unique) {
        if (!PENDING_STATUSES.has(String(action.status || ""))) continue;
        const overlay = overlayByAction.get(String(action._id));
        if (overlay) {
            if (!OPEN_MANUAL_STATUSES.has(overlay.status || "Pending")) continue;
            if (!assigneeIsViewer(viewer, overlay.assignee, overlay.assigneeEmpId, overlay.assigneeName)) continue;
        } else if (!assigneeIsViewer(viewer, action.assignedTo, action.assignedToEmpId)) {
            continue;
        }
        actionOpen += 1;
    }

    const keptKeys = new Set(unique.map((action) => actionDuplicateKey(action)).filter(Boolean));
    for (const row of overlays) {
        if (closedOverlayIds.has(String(row._id))) continue;
        if (!row.sourceDashboardActionId) continue;
        if (collapsedOpen.hiddenOverlayIds.has(String(row._id))) continue;
        const sourceId = String(row.sourceDashboardActionId);
        if (countedActions.has(sourceId)) continue;
        const sourceKey = actionDuplicateKey(sourceById.get(sourceId) || {});
        if (sourceKey && keptKeys.has(sourceKey)) continue;
        if (!OPEN_MANUAL_STATUSES.has(row.status || "Pending")) continue;
        if (!assigneeIsViewer(viewer, row.assignee, row.assigneeEmpId, row.assigneeName)) continue;
        actionOpen += 1;
    }

    return actionOpen + manualOpen;
}

export const getTaskManagerAssigneeCount = async (req, res) => {
    try {
        const viewer = await resolveTaskViewer(req);
        const count = await countOpenTasksForAssignee(viewer);
        return res.status(200).json({ count });
    } catch (error) {
        console.error("Task manager assignee count error:", error);
        return res.status(500).json({ message: "Failed to count tasks", count: 0 });
    }
};
