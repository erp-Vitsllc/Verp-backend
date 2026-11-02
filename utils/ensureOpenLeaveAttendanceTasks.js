import AttendanceChangeRequest from "../models/AttendanceChangeRequest.js";
import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import EmployeeHubRequest from "../models/EmployeeHubRequest.js";
import { OFF_DAY_WORK_REQUEST_TYPE } from "./offDayWorkNotice.js";
import { syncDashboardAction } from "./syncDashboard.js";
import { attachMissingRequestTasks, completeOwnRequestTasks } from "./ensureRequestTask.js";
import {
    ATTENDANCE_CHANGE_OPEN_STAGES,
    attendanceChangeSummary,
    ensureOpenChangeDashboards,
    findOpenChangeRequestsForViewer,
} from "./attendanceChangeApproval.js";
import {
    LEAVE_DASHBOARD_REQUEST_TYPE,
    leaveDashboardRequestObjectId,
} from "./notifyLeaveDashboardRequest.js";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import {
    inferLeaveApprovalStage,
    LEAVE_STAGE_HR,
} from "./leaveRequestApproval.js";
import { normalizeStaffTypeKey } from "./workLocationHelpers.js";
import { hubRequestDisplayLabel } from "./employeeHubRequestTypes.js";

const OPEN_DASHBOARD = ["Pending", "On Hold"];
const LEAVE_TYPES = [LEAVE_DASHBOARD_REQUEST_TYPE, "Attendance Leave Request"];
const HOUR_TYPE = "Hour Approval Request";
const OT_TYPE = "Flexible OT Request";

function requestKey(row) {
    return String(leaveDashboardRequestObjectId(row?.leaveRequestGroupId, row?._id));
}

function chunk(list, size) {
    const groups = [];
    for (let index = 0; index < list.length; index += size) {
        groups.push(list.slice(index, index + size));
    }
    return groups;
}

async function ensurePendingLeaveRows(rows = []) {
    const groups = new Map();
    for (const row of rows || []) {
        if (String(row?.leaveRequestStatus || "") !== "pending") continue;
        const id = requestKey(row);
        if (!id || groups.has(id)) continue;
        groups.set(id, row);
    }
    if (!groups.size) return;

    const ids = [...groups.keys()];
    const actions = await DashboardAction.find({
        requestId: { $in: ids },
        requestType: { $in: LEAVE_TYPES },
        status: { $in: OPEN_DASHBOARD },
    }).lean();
    await attachMissingRequestTasks(actions);
    const covered = new Set(actions.map((action) => String(action.requestId)));
    const missing = [...groups.entries()].filter(([id]) => !covered.has(id));
    if (!missing.length) return;

    const hr = await resolveFlowchartHrEmployee().catch(() => null);
    const hrEmployee = hr?.employee || null;
    const people = await EmployeeBasic.find({
        _id: { $in: [...new Set(missing.map(([, row]) => String(row.employeeMongoId || "")).filter(Boolean))] },
    })
        .select("_id employeeId firstName lastName staffType primaryReportee")
        .populate("primaryReportee", "_id employeeId firstName lastName")
        .lean();
    const byId = new Map((people || []).map((person) => [String(person._id), person]));

    for (const batch of chunk(missing, 8)) {
        await Promise.all(batch.map(async ([requestId, row]) => {
            const employee = byId.get(String(row.employeeMongoId || ""));
            if (!employee) return;
            const stage = inferLeaveApprovalStage(row, {
                reporteeId: employee.primaryReportee?._id || employee.primaryReportee,
                hrId: hrEmployee?._id,
            });
            const approver = stage === LEAVE_STAGE_HR ? hrEmployee : employee.primaryReportee;
            if (!approver?._id) return;
            const from = String(row.leaveRequestFromDate || row.date || "").trim();
            const to = String(row.leaveRequestToDate || row.date || from).trim();
            const label = String(row.requestedStatusLabel || row.statusLabel || "Leave").trim() || "Leave";
            const range = from && to && from !== to ? `${from} → ${to}` : from || to;
            await syncDashboardAction({
                requestId,
                requestType: LEAVE_DASHBOARD_REQUEST_TYPE,
                assignedTo: approver._id,
                status: "Pending",
                subjectEmployee: employee,
                requestedByName: [employee.firstName, employee.lastName].filter(Boolean).join(" ").trim(),
                extra1: from,
                extra2: `${label} request for ${range}`,
                extra3: JSON.stringify({
                    attendanceId: String(row._id || ""),
                    employeeMongoId: String(employee._id),
                    from,
                    to,
                    requestedStatusKey: row.requestedStatusKey || "",
                    staffType: normalizeStaffTypeKey(employee.staffType) || "office",
                    leaveRequestKind: row.leaveRequestKind || "",
                    leaveRequestGroupId: String(row.leaveRequestGroupId || ""),
                    leaveDashboard: true,
                    approvalStage: stage,
                }),
            });
        }));
    }
}

function coveredByChange(changes, action) {
    const keys = new Set();
    for (const change of changes || []) {
        if (change.action !== action) continue;
        keys.add(`${change.employeeMongoId}|${change.date}`);
        const attendanceId = String(change.proposed?.attendanceId || "").trim();
        if (attendanceId) keys.add(attendanceId);
    }
    return keys;
}

async function ensureLegacyHourAndOt(hourItems = [], otItems = []) {
    const hours = hourItems || [];
    const ots = otItems || [];
    if (!hours.length && !ots.length) return;
    const hr = await resolveFlowchartHrEmployee().catch(() => null);
    const hrEmployee = hr?.employee || null;
    if (!hrEmployee?._id) return;

    const attendanceIds = [...hours, ...ots].map((item) => String(item.id || item._id || "")).filter(Boolean);
    const changes = attendanceIds.length
        ? await AttendanceChangeRequest.find({
            stage: { $in: ATTENDANCE_CHANGE_OPEN_STAGES },
            action: { $in: ["hour_adjust", "flexible_ot"] },
            $or: [
                { "proposed.attendanceId": { $in: attendanceIds } },
                {
                    date: { $in: [...new Set([...hours, ...ots].map((item) => item.date).filter(Boolean))] },
                    employeeMongoId: {
                        $in: [...new Set([...hours, ...ots].map((item) => String(item.employeeMongoId || "")).filter(Boolean))],
                    },
                },
            ],
        }).select("action date employeeMongoId proposed.attendanceId").lean()
        : [];
    const hourCovered = coveredByChange(changes, "hour_adjust");
    const otCovered = coveredByChange(changes, "flexible_ot");
    const actions = await DashboardAction.find({
        requestId: { $in: attendanceIds },
        requestType: { $in: [HOUR_TYPE, OT_TYPE] },
        status: { $in: OPEN_DASHBOARD },
    }).lean();
    await attachMissingRequestTasks(actions);
    const have = new Set(actions.map((action) => `${action.requestType}|${action.requestId}`));

    const syncItem = async (item, requestType) => {
        const requestId = String(item.id || item._id || "");
        if (!requestId || have.has(`${requestType}|${requestId}`)) return;
        const covered = requestType === HOUR_TYPE ? hourCovered : otCovered;
        if (covered.has(requestId) || covered.has(`${item.employeeMongoId}|${item.date}`)) return;
        await syncDashboardAction({
            requestId,
            requestType,
            assignedTo: hrEmployee._id,
            status: "Pending",
            subjectEmployee: {
                _id: item.employeeMongoId,
                employeeId: item.employeeId || "",
                firstName: item.subjectName || item.employeeName || "",
            },
            requestedByName: item.subjectName || item.employeeName || "",
            extra1: item.extra1 || item.date || "",
            extra2: item.extra2 || item.message || requestType,
            extra3: JSON.stringify({
                attendanceId: requestId,
                employeeMongoId: String(item.employeeMongoId || ""),
                employeeId: item.employeeId || "",
                employeeName: item.subjectName || item.employeeName || "",
                date: item.date || "",
                staffType: item.staffType || "office",
                leaveRequestKind: requestType === HOUR_TYPE ? "hour_adjust" : "flexible_ot",
                timeIn: item.timeIn || "",
                timeOut: item.timeOut || "",
                reason: item.reason || "",
                hoursApproved: item.hoursApproved || 0,
                flexibleOtApprovedHours: item.flexibleOtApprovedHours || 0,
                flexibleOtHours: item.flexibleOtHours || 0,
            }),
        });
    };

    for (const batch of chunk(hours, 8)) {
        await Promise.all(batch.map((item) => syncItem(item, HOUR_TYPE)));
    }
    for (const batch of chunk(ots, 8)) {
        await Promise.all(batch.map((item) => syncItem(item, OT_TYPE)));
    }
}

async function ensureViewerChanges({ viewerId, viewerIsHr, reporteeIds }) {
    const requests = await findOpenChangeRequestsForViewer({ viewerId, viewerIsHr, reporteeIds });
    await ensureOpenChangeDashboards(requests);
}

/**
 * Off-day work is a real request: one dashboard row and one task for the primary reportee.
 * A day that has been given OT or comp off is taken off both.
 */
export async function syncOffDayWorkTasks({ items = [], assigneeId = "", dismissSettled = true } = {}) {
    const assignee = String(assigneeId || "").trim();
    if (!assignee) return;
    const live = new Set();
    const missing = [];
    const pending = await DashboardAction.find({
        assignedTo: assignee,
        requestType: OFF_DAY_WORK_REQUEST_TYPE,
        status: { $in: OPEN_DASHBOARD },
    }).lean();
    await attachMissingRequestTasks(pending);
    const have = new Set(pending.map((action) => String(action.requestId)));

    for (const item of items || []) {
        const requestId = String(item?.requestObjectId || item?.id || "").trim();
        if (!requestId) continue;
        live.add(requestId);
        if (!have.has(requestId)) missing.push({ ...item, requestId });
    }

    for (const batch of chunk(missing, 8)) {
        await Promise.all(batch.map((item) => syncDashboardAction({
            requestId: item.requestId,
            requestType: OFF_DAY_WORK_REQUEST_TYPE,
            assignedTo: assignee,
            status: "Pending",
            subjectEmployee: {
                _id: item.employeeMongoId,
                employeeId: item.employeeId || "",
                firstName: item.subjectName || "",
            },
            requestedByName: item.subjectName || "",
            extra1: item.extra1 || "Give OT or Comp Off",
            extra2: item.extra2 || item.message || "",
            extra3: JSON.stringify({
                attendanceId: item.requestId,
                employeeMongoId: String(item.employeeMongoId || ""),
                employeeId: item.employeeId || "",
                employeeName: item.subjectName || "",
                date: item.date || "",
                staffType: item.staffType || "office",
                leaveRequestKind: "off_day_work",
                offDayKind: item.offDayKind || "",
            }),
        })));
    }

    const stale = dismissSettled ? pending.filter((action) => !live.has(String(action.requestId))) : [];
    if (!stale.length) return;
    await DashboardAction.updateMany(
        { _id: { $in: stale.map((action) => action._id) }, status: { $in: OPEN_DASHBOARD } },
        { $set: { status: "Approved", actionedDate: new Date(), comment: "Off-day work was settled" } },
    );
    await completeOwnRequestTasks(stale.map((action) => action._id), "Approved");
}

export async function ensureHubLeaveTasks(hubItems = []) {
    const ids = [...new Set((hubItems || []).map((item) => String(item?.requestObjectId || item?.dashboardActionId || "")).filter(Boolean))];
    if (!ids.length) return;
    const actions = await DashboardAction.find({
        requestId: { $in: ids },
        requestType: LEAVE_DASHBOARD_REQUEST_TYPE,
        status: { $in: OPEN_DASHBOARD },
    }).lean();
    await attachMissingRequestTasks(actions);
    const covered = new Set(actions.map((action) => String(action.requestId)));
    const missingIds = ids.filter((id) => !covered.has(id));
    if (!missingIds.length) return;
    const hubs = await EmployeeHubRequest.find({ _id: { $in: missingIds }, status: "Pending", kind: "leave" }).lean();
    for (const batch of chunk(hubs, 8)) {
        await Promise.all(batch.map(async (hub) => {
            if (!hub?.assignedTo) return;
            await syncDashboardAction({
                requestId: hub._id,
                requestType: LEAVE_DASHBOARD_REQUEST_TYPE,
                assignedTo: hub.assignedTo,
                status: "Pending",
                subjectEmployee: {
                    _id: hub.requester,
                    employeeId: hub.requesterEmpId || "",
                    firstName: hub.requesterName || "",
                },
                requestedByName: hub.requesterName || "",
                extra1: String(hub.description || "").slice(0, 180),
                extra2: hubRequestDisplayLabel("leave"),
                extra3: JSON.stringify({
                    hubRequest: true,
                    kind: "leave",
                    requesterMongoId: String(hub.requester || ""),
                    leaveDashboard: true,
                }),
            });
        }));
    }
}

/** Open attendance requests: leave, change, hour, overtime, and off-day work. */
export async function ensureAttendanceRequestTasks({
    leaveRows = [],
    hourItems = [],
    otItems = [],
    offDayItems = [],
    offDayDismissSettled = true,
    assigneeId = "",
    viewerId = "",
    viewerIsHr = false,
    reporteeIds = [],
} = {}) {
    await Promise.all([
        ensurePendingLeaveRows(leaveRows),
        ensureLegacyHourAndOt(hourItems, otItems),
        ensureViewerChanges({ viewerId, viewerIsHr, reporteeIds }),
        syncOffDayWorkTasks({
            items: offDayItems,
            assigneeId,
            dismissSettled: offDayDismissSettled,
        }),
    ]);
}

/** Open leave requests, including a leave request sent from the dashboard. */
export async function ensureLeaveRequestTasks({ leaveRows = [], hubItems = [] } = {}) {
    await Promise.all([
        ensurePendingLeaveRows(leaveRows),
        ensureHubLeaveTasks(hubItems),
    ]);
}
