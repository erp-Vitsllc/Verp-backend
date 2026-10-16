import Attendance from "../models/Attendance.js";
import AttendanceChangeRequest from "../models/AttendanceChangeRequest.js";
import {
    factsFromAttendanceRows,
    factsFromChangeRequest,
    isAttendanceTaskType,
    parseTaskMeta,
} from "./attendanceTaskCopy.js";

const ATTENDANCE_FIELDS = [
    "employeeName",
    "employeeId",
    "date",
    "timeIn",
    "timeOut",
    "timeOutDate",
    "statusKey",
    "statusLabel",
    "reason",
    "leaveRequestKind",
    "requestedStatusKey",
    "requestedStatusLabel",
    "previousStatusKey",
    "previousStatusLabel",
    "leaveRequestReason",
    "leaveRequestFromDate",
    "leaveRequestToDate",
    "leaveRequestDayPart",
    "leaveRequestSession",
    "leaveRequestTimeIn",
    "leaveRequestTimeOut",
    "leaveRequestGroupId",
    "flexibleOtHours",
    "flexibleOtApprovedHours",
    "flexibleOtReason",
    "flexibleOtNextDayDate",
    "flexibleWorkedHours",
    "hourAdjustKind",
    "hoursApproved",
    "hoursTaken",
    "hourAdjustReason",
].join(" ");

function objectId(value) {
    const id = String(value || "").trim();
    return /^[a-fA-F0-9]{24}$/.test(id) ? id : "";
}

/** Live attendance rows behind these tasks, keyed by dashboard action id. */
export async function attendanceFactsByActionId(actions = []) {
    const map = new Map();
    const list = (actions || []).filter((action) => isAttendanceTaskType(action?.requestType));
    if (!list.length) return map;
    try {
        const changeIds = [];
        const attendanceIds = [];
        const groupIds = [];
        for (const action of list) {
            const type = String(action.requestType || "").trim().toLowerCase();
            const meta = parseTaskMeta(action.extra3);
            const requestId = objectId(action.requestId);
            if (type === "attendance change request") {
                const id = requestId || objectId(meta.attendanceId);
                if (id) changeIds.push(id);
                continue;
            }
            const attendanceId = objectId(meta.attendanceId) || requestId;
            if (attendanceId) attendanceIds.push(attendanceId);
            const groupId = String(meta.leaveRequestGroupId || "").trim();
            if (groupId) groupIds.push(groupId);
            if (requestId) groupIds.push(requestId);
        }
        const [changes, rows, grouped] = await Promise.all([
            changeIds.length
                ? AttendanceChangeRequest.find({ _id: { $in: [...new Set(changeIds)] } }).lean()
                : [],
            attendanceIds.length
                ? Attendance.find({ _id: { $in: [...new Set(attendanceIds)] } }).select(ATTENDANCE_FIELDS).lean()
                : [],
            groupIds.length
                ? Attendance.find({ leaveRequestGroupId: { $in: [...new Set(groupIds)] } })
                    .select(ATTENDANCE_FIELDS)
                    .sort({ date: 1 })
                    .lean()
                : [],
        ]);
        const changeById = new Map((changes || []).map((row) => [String(row._id), row]));
        const rowById = new Map((rows || []).map((row) => [String(row._id), row]));
        const rowsByGroup = new Map();
        for (const row of grouped || []) {
            const key = String(row.leaveRequestGroupId || "");
            if (!rowsByGroup.has(key)) rowsByGroup.set(key, []);
            rowsByGroup.get(key).push(row);
        }
        for (const action of list) {
            const type = String(action.requestType || "");
            const meta = parseTaskMeta(action.extra3);
            const requestId = String(action.requestId || "");
            let facts = null;
            if (type.toLowerCase() === "attendance change request") {
                const row = changeById.get(objectId(requestId) || objectId(meta.attendanceId));
                if (row) facts = factsFromChangeRequest(row);
            } else {
                const direct = rowById.get(objectId(meta.attendanceId)) || rowById.get(objectId(requestId));
                const group = rowsByGroup.get(String(meta.leaveRequestGroupId || "")) || rowsByGroup.get(requestId) || [];
                const bundle = direct
                    ? [direct, ...group.filter((row) => String(row._id) !== String(direct._id))]
                    : group;
                if (bundle.length) facts = factsFromAttendanceRows(bundle, type);
            }
            if (facts) map.set(String(action._id), facts);
        }
    } catch (error) {
        console.error("Attendance task facts:", error?.message || error);
    }
    return map;
}
