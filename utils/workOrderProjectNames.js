import WorkOrder from "../models/WorkOrder.js";

/** Project on the work order, or the project stored on its quotation. */
export function workOrderProjectLabel(order) {
    return String(order?.projectName || order?.quotationSnapshot?.projectName || "").replace(/\s+/g, " ").trim();
}

export async function projectNameForWorkOrder(workOrderNo) {
    const number = String(workOrderNo || "").trim();
    if (!number) return "";
    const row = await WorkOrder.findOne({ workOrderNo: number })
        .select("projectName quotationSnapshot.projectName")
        .lean();
    return workOrderProjectLabel(row);
}

function objectId(value) {
    return /^[a-f\d]{24}$/i.test(String(value || "").trim()) ? String(value).trim() : "";
}

/** Fill the work order number and project name so later pending steps group under the created task. */
export async function attachWorkOrderProjectNames(tasks = []) {
    const list = Array.isArray(tasks) ? tasks : [];
    const ids = [];
    const numbers = [];
    for (const task of list) {
        if (!/^Work Order\b/i.test(String(task?.requestType || "")) && !String(task?.workOrderNo || "").trim()) continue;
        const id = objectId(task?.requestId);
        if (id) ids.push(id);
        const number = String(task?.workOrderNo || "").trim();
        if (number) numbers.push(number);
    }
    if (!ids.length && !numbers.length) return tasks;
    const rows = await WorkOrder.find({
        $or: [
            ...(ids.length ? [{ _id: { $in: ids } }] : []),
            ...(numbers.length ? [{ workOrderNo: { $in: numbers } }] : []),
        ],
    }).select("workOrderNo projectName quotationSnapshot.projectName").lean();
    const byId = new Map(rows.map((row) => [String(row._id), row]));
    const byNo = new Map(rows.map((row) => [String(row.workOrderNo || "").trim(), row]));
    for (const task of list) {
        const row = byId.get(objectId(task?.requestId)) || byNo.get(String(task?.workOrderNo || "").trim());
        if (!row) continue;
        if (row.workOrderNo) task.workOrderNo = row.workOrderNo;
        task.projectName = workOrderProjectLabel(row);
    }
    return tasks;
}
