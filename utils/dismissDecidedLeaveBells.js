import DashboardAction from "../models/DashboardAction.js";
import EmployeeHubRequest from "../models/EmployeeHubRequest.js";
import { leaveRangeOf } from "./leaveBellVisibility.js";

function objectId(value) {
    const text = String(value || "").trim();
    return /^[a-f0-9]{24}$/i.test(text) ? text : "";
}

function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Take a finished leave off the bell: task-notification copies, and the employee
 * hub request for the same dates. outcome is Approved, Rejected, or Dismissed.
 */
export async function dismissDecidedLeaveBells({
    employeeMongoId = "",
    from = "",
    to = "",
    attendanceIds = [],
    groupId = "",
    outcome = "Approved",
} = {}) {
    const ids = [...new Set([groupId, ...attendanceIds].map(objectId).filter(Boolean))];
    if (ids.length) {
        const or = [];
        for (const id of ids) {
            const escaped = escapeRegex(id);
            or.push({ requestId: id });
            or.push({ extra3: new RegExp(`"attendanceId":"${escaped}"`) });
            or.push({ extra3: new RegExp(`"leaveRequestGroupId":"${escaped}"`) });
        }
        const status = outcome === "Rejected" ? "Rejected" : outcome === "Dismissed" ? "Dismissed" : "Approved";
        await DashboardAction.updateMany(
            { status: "Pending", requestType: "Task Manager", $or: or },
            { $set: { status, actionedDate: new Date() } },
        );
    }

    const requester = objectId(employeeMongoId);
    const start = String(from || "").slice(0, 10);
    const end = String(to || start).slice(0, 10);
    if (!requester || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return;

    const hubs = await EmployeeHubRequest.find({
        kind: "leave",
        status: "Pending",
        requester,
    })
        .select("description createdAt")
        .limit(100)
        .lean();

    const matched = [];
    for (const hub of hubs) {
        const range = leaveRangeOf({
            extra1: hub.description,
            requestedDate: hub.createdAt,
        });
        if (!range.start || !range.end) continue;
        if (range.start <= end && start <= range.end) matched.push(hub._id);
    }
    if (!matched.length) return;

    if (outcome === "Dismissed") {
        await EmployeeHubRequest.deleteMany({ _id: { $in: matched } });
        await DashboardAction.deleteMany({ requestId: { $in: matched } });
        return;
    }

    await EmployeeHubRequest.updateMany(
        { _id: { $in: matched } },
        {
            $set: {
                status: outcome === "Rejected" ? "Rejected" : "Approved",
                decidedAt: new Date(),
            },
        },
    );
}
