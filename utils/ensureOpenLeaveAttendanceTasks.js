import Attendance from "../models/Attendance.js";
import AttendanceChangeRequest from "../models/AttendanceChangeRequest.js";
import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import EmployeeHubRequest from "../models/EmployeeHubRequest.js";
import { OFF_DAY_WORK_REQUEST_TYPE } from "./offDayWorkNotice.js";
import { syncDashboardAction } from "./syncDashboard.js";
import { isModuleBarShare } from "./moduleBarShare.js";
import { attachMissingRequestTasks, completeOwnRequestTasks } from "./ensureRequestTask.js";
import {
    ATTENDANCE_CHANGE_OPEN_STAGES,
    approverIdForChange,
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
    displayedLeaveApprovalStage,
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
    const actionByRequest = new Map();
    for (const action of actions) {
        const key = String(action.requestId);
        if (!actionByRequest.has(key)) actionByRequest.set(key, action);
    }
    const missing = [...groups.entries()].filter(([id]) => {
        const existing = actionByRequest.get(id);
        return !existing;
    });
    const assigned = [...groups.entries()].filter(([id]) => actionByRequest.has(id));
    if (!missing.length && !assigned.length) return;

    const hr = await resolveFlowchartHrEmployee().catch(() => null);
    const hrEmployee = hr?.employee || null;
    const employeeIds = [...new Set(
        [...missing, ...assigned].map(([, row]) => String(row.employeeMongoId || "")).filter(Boolean),
    )];
    const people = employeeIds.length
        ? await EmployeeBasic.find({ _id: { $in: employeeIds } })
            .select("_id employeeId firstName lastName staffType primaryReportee")
            .populate("primaryReportee", "_id employeeId firstName lastName")
            .lean()
        : [];
    const byId = new Map((people || []).map((person) => [String(person._id), person]));

    const jobs = [];
    for (const [requestId, row] of [...missing, ...assigned]) {
        const employee = byId.get(String(row.employeeMongoId || ""));
        if (!employee) continue;
        const stage = inferLeaveApprovalStage(row, {
            reporteeId: employee.primaryReportee?._id || employee.primaryReportee,
            hrId: hrEmployee?._id,
        });
        const approver = stage === LEAVE_STAGE_HR ? hrEmployee : employee.primaryReportee;
        if (!approver?._id) continue;
        const existing = actionByRequest.get(requestId);
        if (existing && String(existing.assignedTo || "") === String(approver._id)) continue;
        jobs.push({ requestId, row, employee, approver, stage });
    }

    for (const batch of chunk(jobs, 8)) {
        await Promise.all(batch.map(async ({ requestId, row, employee, approver, stage }) => {
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

const CHANGE_TASK_TYPES = new Set([
    "Attendance Change Request",
    HOUR_TYPE,
    OT_TYPE,
]);

function isObjectId(value) {
    return /^[a-fA-F0-9]{24}$/.test(String(value || "").trim());
}

function readMeta(extra3) {
    if (!extra3) return {};
    if (typeof extra3 === "object") return extra3;
    try {
        const parsed = JSON.parse(String(extra3));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function personLabel(person) {
    return [person?.firstName, person?.lastName].filter(Boolean).join(" ").trim();
}

function rememberChange(map, key, change) {
    const id = String(key || "").trim();
    if (!id || map.has(id)) return;
    map.set(id, change);
}

/**
 * The employee who must act on this leave or attendance request right now.
 * An open attendance change wins, because that is the hand the attendance page shows.
 */
export function holderForLeaveAttendanceAction({
    requestType = "",
    change = null,
    leaveRow = null,
    reporteeId = "",
    hrId = "",
} = {}) {
    if (change) {
        const holder = String(approverIdForChange(change) || "").trim();
        if (holder) return holder;
    }
    if (!LEAVE_TYPES.includes(String(requestType || "")) || !leaveRow) return "";
    const stage = displayedLeaveApprovalStage(
        inferLeaveApprovalStage(leaveRow, { reporteeId, hrId }),
        change?.stage,
    );
    if (stage === LEAVE_STAGE_HR) return String(hrId || "").trim();
    return String(reporteeId || "").trim();
}

function clearHeldAssignee(overlay) {
    if (!overlay) return;
    const close = overlay.closeRequest?.toObject
        ? overlay.closeRequest.toObject()
        : { ...(overlay.closeRequest || {}) };
    overlay.closeRequest = {
        ...close,
        originalAssigneeId: null,
        originalAssigneeEmpId: "",
        originalAssigneeName: "",
        returnAssigneeId: null,
        returnAssigneeEmpId: "",
        returnAssigneeName: "",
        reassignmentReleased: false,
    };
}

/**
 * Leave and attendance tasks follow the employee who currently holds the request.
 * The previous assignee is written on the task history by the dashboard sync.
 */
export async function alignOpenLeaveAttendanceAssignees(actions = [], overlaysByAction = new Map()) {
    try {
        return await moveLeaveAttendanceAssignees(actions, overlaysByAction);
    } catch (error) {
        console.error("Align leave and attendance assignees:", error?.message || error);
        return 0;
    }
}

async function moveLeaveAttendanceAssignees(actions = [], overlaysByAction = new Map()) {
    const open = (actions || []).filter((action) => {
        const type = String(action?.requestType || "");
        return (CHANGE_TASK_TYPES.has(type) || LEAVE_TYPES.includes(type))
            && ["Pending", "On Hold"].includes(String(action?.status || ""))
            && !isModuleBarShare(action);
    });
    if (!open.length) return 0;

    const changeIds = [];
    const attendanceIds = [];
    const employeeIds = [];
    for (const action of open) {
        const type = String(action.requestType || "");
        if (CHANGE_TASK_TYPES.has(type) && isObjectId(action.requestId)) changeIds.push(action.requestId);
        const meta = readMeta(action.extra3);
        if (isObjectId(meta.attendanceId)) attendanceIds.push(String(meta.attendanceId));
        if (isObjectId(meta.employeeMongoId)) employeeIds.push(String(meta.employeeMongoId));
    }
    const clauses = [];
    if (changeIds.length) clauses.push({ _id: { $in: changeIds } });
    if (attendanceIds.length) clauses.push({ "proposed.attendanceId": { $in: attendanceIds } });
    if (employeeIds.length) clauses.push({ employeeMongoId: { $in: employeeIds } });
    const changes = clauses.length
        ? await AttendanceChangeRequest.find({
            stage: { $in: ATTENDANCE_CHANGE_OPEN_STAGES },
            $or: clauses,
        })
            .select("stage action date employeeMongoId reporteeId hrId requestedBy proposed.attendanceId proposed.statusKey proposed.hourAdjustKind")
            .lean()
        : [];
    const changeById = new Map();
    const changeByAttendance = new Map();
    const changeByCover = new Map();
    for (const change of changes) {
        rememberChange(changeById, change._id, change);
        rememberChange(changeByAttendance, change.proposed?.attendanceId, change);
        const statusKey = String(
            change.proposed?.statusKey
            || change.proposed?.hourAdjustKind
            || (change.action === "flexible_ot" ? "flexible_ot" : ""),
        ).trim();
        rememberChange(
            changeByCover,
            `${change.employeeMongoId}|${String(change.date || "").trim()}|${statusKey}`,
            change,
        );
    }

    const leaveActions = open.filter((action) => LEAVE_TYPES.includes(String(action.requestType || "")));
    const leaveIds = leaveActions.map((action) => String(action.requestId || "")).filter(Boolean);
    const leaveRows = leaveIds.length
        ? await Attendance.find({
            leaveRequestStatus: "pending",
            $or: [
                { _id: { $in: leaveIds.filter(isObjectId) } },
                { leaveRequestGroupId: { $in: leaveIds } },
            ],
        })
            .select("_id employeeMongoId leaveRequestGroupId leaveApprovalStage")
            .lean()
        : [];
    const leaveByKey = new Map();
    for (const row of leaveRows) {
        leaveByKey.set(String(row._id), row);
        if (row.leaveRequestGroupId) leaveByKey.set(String(row.leaveRequestGroupId), row);
    }
    const leaveEmployeeIds = [...new Set(leaveRows.map((row) => String(row.employeeMongoId || "")).filter(isObjectId))];
    const needsHr = leaveEmployeeIds.length > 0;
    const hr = needsHr ? await resolveFlowchartHrEmployee().catch(() => null) : null;
    const hrId = hr?.employee?._id ? String(hr.employee._id) : "";
    const reportees = leaveEmployeeIds.length
        ? await EmployeeBasic.find({ _id: { $in: leaveEmployeeIds } }).select("_id primaryReportee").lean()
        : [];
    const reporteeByEmployee = new Map(
        (reportees || []).map((person) => [String(person._id), String(person.primaryReportee || "")]),
    );

    const moves = [];
    for (const action of open) {
        const meta = readMeta(action.extra3);
        const requestType = String(action.requestType || "");
        let change = changeById.get(String(action.requestId || "")) || null;
        if (!change && meta.attendanceId) change = changeByAttendance.get(String(meta.attendanceId)) || null;
        if (!change && meta.employeeMongoId) {
            const statusKey = String(
                meta.requestedStatusKey || meta.statusKey || (meta.leaveRequestKind === "flexible_ot" ? "flexible_ot" : ""),
            ).trim();
            const date = String(meta.from || meta.date || action.extra1 || "").slice(0, 10);
            change = changeByCover.get(`${meta.employeeMongoId}|${date}|${statusKey}`) || null;
        }
        const leaveRow = leaveByKey.get(String(action.requestId || "")) || null;
        const reporteeId = leaveRow
            ? reporteeByEmployee.get(String(leaveRow.employeeMongoId || "")) || ""
            : "";
        const holder = holderForLeaveAttendanceAction({
            requestType,
            change,
            leaveRow,
            reporteeId,
            hrId,
        });
        if (!holder) continue;
        const overlay = overlaysByAction.get(String(action._id));
        const current = String(overlay?.assignee || action.assignedTo || "");
        if (current === holder && String(action.assignedTo || "") === holder) continue;
        moves.push({ action, overlay, holder });
    }
    if (!moves.length) return 0;

    const holders = await EmployeeBasic.find({
        _id: { $in: [...new Set(moves.map((move) => move.holder).filter(isObjectId))] },
    })
        .select("_id employeeId firstName lastName")
        .lean();
    const holderById = new Map((holders || []).map((person) => [String(person._id), person]));
    let moved = 0;
    for (const batch of chunk(moves, 8)) {
        const saved = await Promise.all(batch.map(async (move) => {
            const person = holderById.get(move.holder);
            if (!person?._id) return false;
            try {
                await syncDashboardAction({
                    requestId: move.action.requestId,
                    requestType: move.action.requestType,
                    assignedTo: person._id,
                    status: "Pending",
                    subjectEmployee: {
                        employeeId: move.action.subjectEmployeeId || "",
                        firstName: move.action.subjectName || "",
                    },
                    requestedByName: move.action.requestedByName || "",
                    extra1: move.action.extra1,
                    extra2: move.action.extra2,
                    extra3: move.action.extra3,
                });
            } catch (error) {
                console.error("Leave attendance assignee:", error?.message || error);
                return false;
            }
            move.action.assignedTo = person._id;
            move.action.assignedToEmpId = person.employeeId || "";
            if (move.overlay) {
                move.overlay.assignee = person._id;
                move.overlay.assigneeEmpId = person.employeeId || "";
                const name = personLabel(person);
                if (name) move.overlay.assigneeName = name;
                clearHeldAssignee(move.overlay);
            }
            return true;
        }));
        moved += saved.filter(Boolean).length;
    }
    return moved;
}
