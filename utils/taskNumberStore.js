import DashboardAction from "../models/DashboardAction.js";
import TaskManagerTask from "../models/TaskManagerTask.js";
import TaskNumberCounter from "../models/TaskNumberCounter.js";
import {
    applyStableTaskNumbers,
    formatTaskNumber,
    listedNumberAfterRefresh,
    parseTaskNumber,
    taskNumberYear,
} from "./taskNumber.js";

const NUMBER_PATTERN = /^TSK-\d{2}-\d+$/;

let chain = Promise.resolve();

function withTaskNumberLock(work) {
    const run = chain.then(() => work());
    chain = run.then(() => undefined, () => undefined);
    return run;
}

function isObjectId(value) {
    return /^[a-fA-F0-9]{24}$/.test(String(value || ""));
}

function modelFor(kind) {
    return kind === "manual" ? TaskManagerTask : DashboardAction;
}

function ownerKey(task) {
    const kind = task?.numberOwner?.kind === "manual" ? "manual" : "action";
    return `${kind}:${String(task?.numberOwner?.id || "")}`;
}

function alsoKey(task) {
    if (!task?.alsoOwner?.id) return "";
    const kind = task.alsoOwner.kind === "manual" ? "manual" : "action";
    return `${kind}:${String(task.alsoOwner.id)}`;
}

async function readNumber(kind, id) {
    if (!isObjectId(id)) return "";
    const row = await modelFor(kind).findById(id).select("taskNumber").lean();
    const number = String(row?.taskNumber || "").trim();
    return parseTaskNumber(number) ? number : "";
}

async function writeIfEmpty(kind, id, taskNumber) {
    if (!isObjectId(id) || !parseTaskNumber(taskNumber)) return;
    await modelFor(kind).updateOne(emptyNumberFilter(id), { $set: { taskNumber } });
}

function emptyNumberFilter(id) {
    return {
        _id: id,
        $or: [
            { taskNumber: { $exists: false } },
            { taskNumber: null },
            { taskNumber: "" },
        ],
    };
}

async function storedMaxByYear() {
    const [actions, manuals, counters] = await Promise.all([
        DashboardAction.find({ taskNumber: NUMBER_PATTERN }).select("taskNumber").lean(),
        TaskManagerTask.find({ taskNumber: NUMBER_PATTERN }).select("taskNumber").lean(),
        TaskNumberCounter.find().lean(),
    ]);
    const maxByYear = new Map();
    for (const row of [...actions, ...manuals]) {
        const parsed = parseTaskNumber(row.taskNumber);
        if (!parsed) continue;
        maxByYear.set(parsed.year, Math.max(maxByYear.get(parsed.year) || 0, parsed.count));
    }
    for (const counter of counters) {
        if (!/^\d{2}$/.test(String(counter?._id || ""))) continue;
        const year = String(counter._id);
        maxByYear.set(year, Math.max(maxByYear.get(year) || 0, Number(counter.seq) || 0));
    }
    return maxByYear;
}

async function raiseCounters(maxByYear) {
    const writes = [];
    for (const [year, count] of maxByYear || []) {
        if (!/^\d{2}$/.test(String(year)) || !Number(count)) continue;
        writes.push(TaskNumberCounter.updateOne(
            { _id: String(year) },
            { $max: { seq: Number(count) } },
            { upsert: true },
        ));
    }
    if (writes.length) await Promise.all(writes);
}

function rememberOwnerId(task, actionIds, manualIds) {
    const owners = [task?.numberOwner, task?.alsoOwner];
    for (const owner of owners) {
        const id = String(owner?.id || "");
        if (!isObjectId(id)) continue;
        if (owner.kind === "manual") manualIds.push(id);
        else actionIds.push(id);
    }
}

async function refreshSavedNumbers(tasks) {
    const actionIds = [];
    const manualIds = [];
    for (const task of tasks) rememberOwnerId(task, actionIds, manualIds);
    const [actions, manuals] = await Promise.all([
        actionIds.length
            ? DashboardAction.find({ _id: { $in: actionIds } }).select("taskNumber").lean()
            : [],
        manualIds.length
            ? TaskManagerTask.find({ _id: { $in: manualIds } }).select("taskNumber").lean()
            : [],
    ]);
    const found = new Map();
    for (const row of actions) {
        const number = String(row.taskNumber || "").trim();
        if (parseTaskNumber(number)) found.set(`action:${row._id}`, number);
    }
    for (const row of manuals) {
        const number = String(row.taskNumber || "").trim();
        if (parseTaskNumber(number)) found.set(`manual:${row._id}`, number);
    }
    for (const task of tasks) {
        const copyKey = alsoKey(task);
        const next = listedNumberAfterRefresh(
            task.taskNumber,
            found.get(ownerKey(task)) || "",
            copyKey ? (found.get(copyKey) || "") : "",
        );
        task.taskNumber = next.taskNumber;
        task.numberSaved = next.numberSaved;
        task.copySaved = copyKey ? next.copySaved : true;
        task.storedOnTask = next.storedOnTask;
    }
}

function pushNumberWrite(actionOps, manualOps, kind, id, taskNumber) {
    if (!isObjectId(id) || !parseTaskNumber(taskNumber)) return false;
    const op = {
        updateOne: {
            filter: emptyNumberFilter(id),
            update: { $set: { taskNumber } },
        },
    };
    if (kind === "manual") manualOps.push(op);
    else actionOps.push(op);
    return true;
}

async function persistUnsaved(tasks) {
    const actionOps = [];
    const manualOps = [];
    for (const task of tasks) {
        const number = String(task?.taskNumber || "").trim();
        if (!parseTaskNumber(number)) continue;
        if (!task?.numberSaved) {
            pushNumberWrite(
                actionOps,
                manualOps,
                task?.numberOwner?.kind === "manual" ? "manual" : "action",
                task?.numberOwner?.id,
                number,
            );
        }
        if (task?.alsoOwner && !task.copySaved) {
            pushNumberWrite(
                actionOps,
                manualOps,
                task.alsoOwner.kind === "manual" ? "manual" : "action",
                task.alsoOwner.id,
                number,
            );
        }
    }
    if (actionOps.length) await DashboardAction.bulkWrite(actionOps, { ordered: false });
    if (manualOps.length) await TaskManagerTask.bulkWrite(manualOps, { ordered: false });
    return actionOps.length + manualOps.length;
}

/**
 * Save the list's task numbers.
 * The first save keeps the numbers the list already shows. Later saves do not move them.
 */
export async function saveListedTaskNumbers(tasks) {
    const list = (tasks || []).filter((task) => task?.numberOwner?.id);
    if (!list.length) return tasks;
    return withTaskNumberLock(async () => {
        await refreshSavedNumbers(list);
        const storedMax = await storedMaxByYear();
        const { maxByYear } = applyStableTaskNumbers(list, {
            nextCountByYear: storedMax.size ? storedMax : null,
        });
        const wrote = await persistUnsaved(list);
        const after = await storedMaxByYear();
        for (const [year, count] of maxByYear) {
            after.set(year, Math.max(after.get(year) || 0, count));
        }
        await raiseCounters(after);
        await refreshSavedNumbers(list);
        for (const task of list) {
            if (!task.storedOnTask) task.taskNumber = "";
        }
        if (wrote) console.log(`Saved task numbers: ${wrote}`);
        return tasks;
    });
}

/**
 * The saved number for this task. A number already stored is returned unchanged.
 * A task with no number yet gets the next unused number, saved only into the empty field.
 */
export async function oneTaskNumber({ actionId = "", manualId = "", requestDate } = {}) {
    const actionKey = isObjectId(actionId) ? String(actionId) : "";
    const manualKey = isObjectId(manualId) ? String(manualId) : "";
    if (!actionKey && !manualKey) return "";
    return withTaskNumberLock(async () => {
        const actionNumber = actionKey ? await readNumber("action", actionKey) : "";
        if (actionNumber) return actionNumber;
        const manualNumber = manualKey ? await readNumber("manual", manualKey) : "";
        if (manualNumber) {
            if (actionKey) await writeIfEmpty("action", actionKey, manualNumber);
            return (actionKey ? await readNumber("action", actionKey) : "") || manualNumber;
        }
        return claimUnlocked({
            kind: actionKey ? "action" : "manual",
            id: actionKey || manualKey,
            requestDate,
        });
    });
}

async function claimUnlocked({ kind = "action", id, requestDate } = {}) {
    if (!isObjectId(id)) return "";
    const current = await readNumber(kind, id);
    if (current) return current;
    const storedMax = await storedMaxByYear();
    if (!storedMax.size) return "";
    const year = taskNumberYear(requestDate || new Date());
    const base = storedMax.get(year) || 0;
    await TaskNumberCounter.updateOne(
        { _id: year },
        { $max: { seq: base } },
        { upsert: true },
    );
    const doc = await TaskNumberCounter.findOneAndUpdate(
        { _id: year },
        { $inc: { seq: 1 } },
        { new: true, upsert: true },
    );
    const number = formatTaskNumber(year, doc?.seq || base + 1);
    await writeIfEmpty(kind, id, number);
    return (await readNumber(kind, id)) || "";
}

/** Give one task the next saved number. Returns "" until the list has saved its numbers once. */
export async function claimTaskNumber({ kind = "action", id, requestDate } = {}) {
    if (!isObjectId(id)) return "";
    return withTaskNumberLock(() => claimUnlocked({ kind, id, requestDate }));
}
