import DashboardAction from "../models/DashboardAction.js";
import TaskManagerTask from "../models/TaskManagerTask.js";
import TaskNumberCounter from "../models/TaskNumberCounter.js";
import {
    applyStableTaskNumbers,
    formatTaskNumber,
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

async function readNumber(kind, id) {
    if (!isObjectId(id)) return "";
    const row = await modelFor(kind).findById(id).select("taskNumber").lean();
    const number = String(row?.taskNumber || "").trim();
    return parseTaskNumber(number) ? number : "";
}

async function writeIfEmpty(kind, id, taskNumber) {
    if (!isObjectId(id) || !parseTaskNumber(taskNumber)) return;
    await modelFor(kind).updateOne(
        { _id: id, taskNumber: { $in: [null, ""] } },
        { $set: { taskNumber } },
    );
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

async function refreshSavedNumbers(tasks) {
    const actionIds = [];
    const manualIds = [];
    for (const task of tasks) {
        const id = String(task?.numberOwner?.id || "");
        if (!isObjectId(id)) continue;
        if (task.numberOwner.kind === "manual") manualIds.push(id);
        else actionIds.push(id);
    }
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
        const number = found.get(ownerKey(task));
        if (!number) {
            task.numberSaved = false;
            continue;
        }
        task.taskNumber = number;
        task.numberSaved = true;
    }
}

async function persistUnsaved(tasks) {
    const actionOps = [];
    const manualOps = [];
    for (const task of tasks) {
        const number = String(task?.taskNumber || "").trim();
        const id = String(task?.numberOwner?.id || "");
        if (task?.numberSaved || !parseTaskNumber(number) || !isObjectId(id)) continue;
        const op = {
            updateOne: {
                filter: { _id: id, taskNumber: { $in: [null, ""] } },
                update: { $set: { taskNumber: number } },
            },
        };
        if (task.numberOwner.kind === "manual") manualOps.push(op);
        else actionOps.push(op);
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
        if (wrote) console.log(`Saved task numbers: ${wrote}`);
        return tasks;
    });
}

/** Give one task the next saved number. Returns "" until the list has saved its numbers once. */
export async function claimTaskNumber({ kind = "action", id, requestDate } = {}) {
    if (!isObjectId(id)) return "";
    return withTaskNumberLock(async () => {
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
        return (await readNumber(kind, id)) || number;
    });
}
