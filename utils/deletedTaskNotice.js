import DashboardAction from "../models/DashboardAction.js";
import DeletedTaskNotice from "../models/DeletedTaskNotice.js";
import TaskManagerTask from "../models/TaskManagerTask.js";

const OWNER_BODY = /\s[-\u2013\u2014]\s(Passport|Visa|Visit Visa|Employment Visa|Spouse Visa|Emirates ID|Medical Insurance|Driving License|Labour Card)\s*\(/i;

function collapse(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
}

function readMeta(extra3) {
    if (!extra3) return {};
    if (typeof extra3 === "object") return extra3;
    try {
        return JSON.parse(String(extra3));
    } catch {
        return {};
    }
}

function isExpiryNoticeType(type) {
    return /expiry/i.test(String(type || ""));
}

export function salaryEnrollmentEmployeeKey(employeeCode) {
    const code = String(employeeCode || "").trim().replace(/\s+/g, "").toUpperCase();
    return code ? `SAL|${code}|pending enrollment` : "";
}

/** Fine rows share one workflow whether the bell says Fine or Group Fine Request. */
function workflowNoticeType(type) {
    if (type === "Fine" || type === "Group Fine Request") return "Fine";
    if (type === "Employee Leave Request" || type === "Attendance Leave Request") return "Leave";
    return type;
}

/** Keys shared with the bell list so a deleted task notice is not built again. */
export function noticeKeysForRecord(record) {
    const type = String(record?.requestType || record?.type || "").trim();
    if (!type || type === "Task Manager") return [];
    const trimmed = String(record?.extra1 || "").trim();
    const raw = collapse(trimmed);
    const lower = raw.toLowerCase();
    const id = String(record?.id ?? record?.requestId ?? "").trim();
    const code = String(record?.targetEmployeeId ?? record?.subjectEmployeeId ?? "").trim();
    const meta = readMeta(record?.extra3);
    const keys = [];
    if (type === "Employee Document Expiry Reminder") {
        if (!raw) return [];
        if (code) keys.push(`EDE|${code}|${lower}`);
        if (id && id !== code) keys.push(`EDE|${id}|${lower}`);
    } else if (type === "Vehicle Document Expiry Reminder") {
        if (!raw) return [];
        if (id) keys.push(`VDE|${id}|${lower}`);
        if (code && code !== id) keys.push(`VDE|${code}|${lower}`);
    } else if (type === "Document Expiry Reminder") {
        if (!raw) return [];
        if (id) {
            keys.push(`Document Expiry Reminder|${id}|${trimmed || raw}`);
            if (raw !== trimmed) keys.push(`Document Expiry Reminder|${id}|${raw}`);
            keys.push(`CDE|${id}|${lower}`);
        }
        if (meta?.ownerExpiryDedupe === true || OWNER_BODY.test(raw)) {
            keys.push(`CDE|OWNER|${lower}`);
        }
    } else if (isExpiryNoticeType(type)) {
        if (id && raw) keys.push(`TASK|${type}|${id}|${lower}`);
        else if (id) keys.push(`TASK|${type}|${id}`);
    } else if (type === "Vehicle Service Request") {
        const serviceId = String(meta.serviceRecordId || "").trim();
        if (id && serviceId) keys.push(`TASK|${type}|${id}|${serviceId}`);
        else if (id) keys.push(`TASK|${type}|${id}`);
    } else if (!isExpiryNoticeType(type)) {
        const noticeType = workflowNoticeType(type);
        if (id) keys.push(`TASK|${noticeType}|${id}`);
        if (id && raw) keys.push(`TASK|${noticeType}|${id}|${lower}`);
        if (!id && code && raw) keys.push(`TASK|${noticeType}|${code}|${lower}`);
        if (type === "Salary Enrollment") {
            const employeeCode = String(code || meta.employeeId || "").trim().replace(/\s+/g, "").toUpperCase();
            const salaryKey = salaryEnrollmentEmployeeKey(employeeCode);
            if (employeeCode) keys.push(`TASK|Salary Enrollment|${employeeCode}`);
            if (salaryKey) keys.push(salaryKey);
        }
    }
    return [...new Set(keys)];
}

export async function rememberDeletedNotices(records = []) {
    const seen = new Set();
    const ops = [];
    for (const record of records || []) {
        if (!record) continue;
        for (const noticeKey of noticeKeysForRecord(record)) {
            if (seen.has(noticeKey)) continue;
            seen.add(noticeKey);
            ops.push({
                updateOne: {
                    filter: { noticeKey },
                    update: {
                        $setOnInsert: {
                            noticeKey,
                            requestType: String(record.requestType || record.type || ""),
                            extra1: String(record.extra1 || ""),
                        },
                    },
                    upsert: true,
                },
            });
        }
    }
    if (!ops.length) return;
    await DeletedTaskNotice.bulkWrite(ops, { ordered: false });
}

export async function listDeletedNoticeKeys() {
    const rows = await DeletedTaskNotice.find({}).select("noticeKey").lean();
    return rows.map((row) => String(row.noticeKey || "")).filter(Boolean);
}

export async function noticeAlreadyDeleted(record) {
    const keys = noticeKeysForRecord(record);
    if (!keys.length) return false;
    return Boolean(await DeletedTaskNotice.exists({ noticeKey: { $in: keys } }));
}

export async function expiryNoticeAlreadyDeleted(record) {
    return noticeAlreadyDeleted(record);
}

const EXPIRY_REQUEST_TYPES = [
    "Employee Document Expiry Reminder",
    "Document Expiry Reminder",
    "Vehicle Document Expiry Reminder",
];

function objectId(value) {
    const text = String(value || "").trim();
    return /^[a-fA-F0-9]{24}$/.test(text) ? text : "";
}

function noticeTypesFor(type) {
    const types = new Set();
    if (type) types.add(type);
    if (type === "Fine" || type === "Group Fine Request") {
        types.add("Fine");
        types.add("Group Fine Request");
    }
    if (type === "Employee Leave Request" || type === "Attendance Leave Request") {
        types.add("Employee Leave Request");
        types.add("Attendance Leave Request");
        types.add("Employee Request Resend");
    }
    return types;
}

/** Drop every still-open copy of a notice that was already deleted with its task. */
export async function purgePendingCopiesOf(records = []) {
    await rememberDeletedNotices(records);
    const keys = new Set();
    const requestIds = new Set();
    const types = new Set();
    const salaryCodes = new Set();
    for (const record of records || []) {
        for (const key of noticeKeysForRecord(record)) keys.add(key);
        const id = objectId(record?.requestId || record?.id);
        if (id) requestIds.add(id);
        const type = String(record?.requestType || record?.type || "").trim();
        for (const noticeType of noticeTypesFor(type)) types.add(noticeType);
        if (type === "Salary Enrollment") {
            const meta = readMeta(record?.extra3);
            const employeeCode = String(record?.subjectEmployeeId || record?.targetEmployeeId || meta.employeeId || "").trim();
            if (employeeCode) salaryCodes.add(employeeCode);
        }
    }
    if (!keys.size) return [];
    const or = [];
    const expiryTypes = [...types].filter((type) => isExpiryNoticeType(type) || EXPIRY_REQUEST_TYPES.includes(type));
    const otherTypes = [...types].filter((type) => !isExpiryNoticeType(type) && type !== "Task Manager");
    if (expiryTypes.length) {
        or.push({
            requestType: { $in: expiryTypes },
            status: { $in: ["Pending", "On Hold", "Rejected"] },
        });
    }
    if (otherTypes.length && requestIds.size) {
        or.push({
            requestType: { $in: otherTypes },
            requestId: { $in: [...requestIds] },
            status: { $in: ["Pending", "On Hold", "Rejected"] },
        });
    }
    if (salaryCodes.size) {
        const codeList = [...salaryCodes];
        or.push({
            requestType: "Salary Enrollment",
            status: { $in: ["Pending", "On Hold", "Rejected"] },
            $or: [
                { subjectEmployeeId: { $in: codeList } },
                ...codeList.map((code) => ({
                    extra3: new RegExp(`"employeeId"\\s*:\\s*"${String(code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i"),
                })),
            ],
        });
    }
    if (!or.length) return [];
    const pending = await DashboardAction.find({ $or: or })
        .select("_id requestType requestId subjectEmployeeId extra1 extra3")
        .lean();
    const ids = pending
        .filter((row) => noticeKeysForRecord(row).some((key) => keys.has(key)))
        .map((row) => row._id);
    if (!ids.length) return [];
    const tasks = await TaskManagerTask.find({ sourceDashboardActionId: { $in: ids } })
        .select("_id")
        .lean();
    const taskIds = tasks.map((task) => task._id);
    if (taskIds.length) {
        const bellOr = [{ requestId: { $in: taskIds } }];
        for (const taskId of taskIds) {
            const id = String(taskId);
            bellOr.push({ extra3: new RegExp(`"taskManagerId"\\s*:\\s*"${id}"`) });
            bellOr.push({ extra3: new RegExp(`"taskKey"\\s*:\\s*"(?:manual-)?${id}"`) });
        }
        await DashboardAction.deleteMany({ requestType: "Task Manager", $or: bellOr });
        await TaskManagerTask.deleteMany({ _id: { $in: taskIds } });
    }
    await DashboardAction.deleteMany({ _id: { $in: ids } });
    return ids.map((id) => String(id));
}
