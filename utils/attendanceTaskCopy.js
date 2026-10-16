/**
 * Task Manager copy for attendance requests.
 * Title: employee, date, exact request (Late In, OT, Mispunch, Comp Off, …).
 * Description: times, duration, and the hours on OT and hour-approval requests.
 */

const ATTENDANCE_TYPES = new Set([
    "attendance leave request",
    "attendance change request",
    "hour approval request",
    "flexible ot request",
    "employee leave request",
]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const KIND_BY_KEY = {
    late_arrived: "Late In",
    future_late: "Late In",
    past_late: "Late In",
    early_go: "Early Out",
    future_early: "Early Out",
    mispunch: "Mispunch",
    flexible_ot: "OT",
    hour_adjust: "Hour Approval",
    compoff_leave: "Comp Off",
    sick_leave: "Sick Leave",
    on_leave: "Annual Leave",
    future_annual: "Annual Leave",
    authorized_leave: "Auth Leave",
    unauthorized_leave: "Unauthorized Leave",
    on_office: "Present",
    work_from_home: "Work From Home",
};

export function isAttendanceTaskType(requestType) {
    return ATTENDANCE_TYPES.has(String(requestType || "").trim().toLowerCase());
}

export function parseTaskMeta(extra3) {
    if (!extra3) return {};
    if (typeof extra3 === "object") return extra3;
    try {
        const parsed = JSON.parse(String(extra3));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function clean(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clockMinutes(value) {
    const match = clean(value).match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
    if (!match) return null;
    let hours = Number(match[1]);
    const mins = Number(match[2]);
    if (hours > 23 || mins > 59) return null;
    const suffix = String(match[3] || "").toLowerCase();
    if (suffix === "pm" && hours < 12) hours += 12;
    if (suffix === "am" && hours === 12) hours = 0;
    return hours * 60 + mins;
}

export function formatTaskDate(value) {
    const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return clean(value);
    const month = MONTHS[Number(match[2]) - 1];
    if (!month) return clean(value);
    return `${month} ${Number(match[3])}, ${match[1]}`;
}

export function formatTaskDateRange(from, to) {
    const start = formatTaskDate(from);
    const end = formatTaskDate(to);
    if (start && end && start !== end) return `${start} – ${end}`;
    return start || end || "";
}

export function formatHourAmount(value, { allowZero = false } = {}) {
    if (value == null || value === "") return "";
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours < 0) return "";
    if (hours === 0 && !allowZero) return "";
    const rounded = Math.round(hours * 100) / 100;
    return `${rounded} hr`;
}

export function durationBetween(timeIn, timeOut, timeOutDate = "", date = "") {
    const start = clockMinutes(timeIn);
    const end = clockMinutes(timeOut);
    if (start == null || end == null) return "";
    let mins = end - start;
    const outDay = clean(timeOutDate);
    const inDay = clean(date);
    if (outDay && inDay && outDay > inDay) mins += 24 * 60;
    else if (mins < 0) mins += 24 * 60;
    if (mins <= 0) return "";
    const hours = Math.floor(mins / 60);
    const minutes = mins % 60;
    if (hours && minutes) return `${hours}h ${minutes}m`;
    if (hours) return `${hours}h`;
    return `${minutes}m`;
}

function dayPartLabel(part, session) {
    const day = clean(part).toLowerCase();
    const half = clean(session).toLowerCase();
    if (day === "half") {
        if (half === "am") return "Half day, AM";
        if (half === "pm") return "Half day, PM";
        return "Half day";
    }
    if (day === "quarter") return "Quarter day";
    if (day === "full") return "Full day";
    return "";
}

function inclusiveDays(from, to) {
    const startKey = clean(from).slice(0, 10);
    const endKey = clean(to).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startKey) || !/^\d{4}-\d{2}-\d{2}$/.test(endKey) || endKey <= startKey) {
        return "";
    }
    const start = Date.parse(`${startKey}T00:00:00Z`);
    const end = Date.parse(`${endKey}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
    const days = Math.round((end - start) / 86400000) + 1;
    return days > 1 ? `${days} days` : "";
}

export function statusKind(value) {
    const raw = clean(value).replace(/\s*\(approved\)\s*/gi, "").trim();
    if (!raw) return "";
    const key = raw.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(KIND_BY_KEY, key)) return KIND_BY_KEY[key];
    if (/late\s*in|late\s*arriv/.test(key)) return "Late In";
    if (/early\s*(out|go)/.test(key)) return "Early Out";
    if (/mis\s*punch|missed\s*punch|misspunch/.test(key)) return "Mispunch";
    if (/comp\s*-?\s*off/.test(key)) return "Comp Off";
    if (/sick/.test(key)) return "Sick Leave";
    if (/annual|\bon leave\b/.test(key)) return "Annual Leave";
    if (/unauthor/.test(key)) return "Unauthorized Leave";
    if (/^auth\b|authori[sz]ed leave/.test(key)) return "Auth Leave";
    if (/\bot\b|overtime|apply ot/.test(key)) return "OT";
    if (/hour approval|hour request/.test(key)) return "Hour Approval";
    if (/^present\b/.test(key)) return "Present";
    if (/work from home/.test(key)) return "Work From Home";
    if (/^leave$/.test(key) || key === "future_leave" || key === "yellow") return "";
    if (/[a-z]/i.test(raw) && !/_/.test(raw) && raw.length <= 40 && !/request for|waiting for|pending/i.test(raw)) {
        return raw;
    }
    return "";
}

export function attendanceRequestKind({
    action = "",
    leaveRequestKind = "",
    statusKey = "",
    statusLabel = "",
    previousStatusKey = "",
    previousStatusLabel = "",
    hourAdjustKind = "",
} = {}) {
    const act = clean(action);
    if (act === "flexible_ot") return "OT";
    if (act === "map") return "Map Attendance";
    if (act === "clear") return "Clear Attendance";
    if (act === "hour_adjust") {
        const inner = statusKind(hourAdjustKind) || statusKind(statusKey) || statusKind(statusLabel);
        return inner && inner !== "Hour Approval" ? `Hour Approval, ${inner}` : "Hour Approval";
    }
    const kind = clean(leaveRequestKind);
    if (kind === "yellow") {
        return statusKind(previousStatusKey)
            || statusKind(statusKey)
            || statusKind(previousStatusLabel)
            || statusKind(statusLabel)
            || "Mispunch";
    }
    return statusKind(kind)
        || statusKind(statusKey)
        || statusKind(statusLabel)
        || statusKind(previousStatusKey)
        || statusKind(previousStatusLabel)
        || "";
}

function kindFromSummary(summary) {
    const text = clean(summary);
    if (!text) return "";
    if (/rejected ot|\bot request\b|apply ot|overtime/i.test(text)) return "OT";
    if (/hour request|hour approval/i.test(text)) return "Hour Approval";
    const arrow = text.match(/→\s*([^·(]+)/);
    if (arrow) return statusKind(arrow[1]);
    const requestFor = text.match(/^(.+?)\s+request for\b/i);
    if (requestFor) return statusKind(requestFor[1]);
    return "";
}

function blankFacts() {
    return {
        attendance: true,
        employeeName: "",
        employeeId: "",
        date: "",
        from: "",
        to: "",
        requestKind: "",
        timeIn: "",
        timeOut: "",
        duration: "",
        otRequestedFor: "",
        otHours: "",
        otApprovedHours: "",
        hoursApproved: "",
        hoursTaken: "",
        currentStatus: "",
        requestedStatus: "",
        reason: "",
    };
}

function codeOrBlank(value) {
    const code = clean(value);
    if (!code || /^[a-fA-F0-9]{24}$/.test(code)) return "";
    return code;
}

function isoDates(...values) {
    const found = [];
    for (const value of values) {
        const matches = clean(value).match(/\d{4}-\d{2}-\d{2}/g) || [];
        for (const day of matches) {
            if (!found.includes(day)) found.push(day);
        }
    }
    return found;
}

export function attendanceTaskTitle(facts = {}) {
    const when = formatTaskDateRange(facts.from || facts.date, facts.to || facts.from || facts.date);
    return [clean(facts.employeeName), when, clean(facts.requestKind)].filter(Boolean).join(", ");
}

export function attendanceFactsFromAction({
    requestType = "",
    extra1 = "",
    extra2 = "",
    extra3,
    subjectName = "",
    subjectEmployeeId = "",
} = {}) {
    const type = clean(requestType).toLowerCase();
    const meta = parseTaskMeta(extra3);
    const summary = clean(extra1);
    const secondary = clean(extra2);
    const requestFor = secondary.match(/^(.+?)\s+request for\b/i) || summary.match(/^(.+?)\s+request for\b/i);
    const days = isoDates(meta.date, meta.from, meta.to, meta.targetDate, summary, secondary);
    const from = clean(meta.from || meta.date || days[0] || "");
    const to = clean(meta.to || days[1] || from);
    const action = clean(meta.action)
        || (type === "flexible ot request" ? "flexible_ot" : "")
        || (type === "hour approval request" ? "hour_adjust" : "");
    let requestKind = attendanceRequestKind({
        action,
        leaveRequestKind: meta.leaveRequestKind || "",
        statusKey: meta.statusKey || meta.requestedStatusKey || "",
        statusLabel: meta.statusLabel || meta.requestedStatusLabel || requestFor?.[1] || "",
        previousStatusKey: meta.previousStatusKey || "",
        previousStatusLabel: meta.previousStatusLabel || "",
        hourAdjustKind: meta.hourAdjustKind || "",
    }) || kindFromSummary(summary) || kindFromSummary(secondary);
    if (!requestKind) requestKind = "Attendance";
    const times = summary.match(/\((\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})\)/);
    const timeIn = clean(meta.timeIn || times?.[1] || "");
    const timeOut = clean(meta.timeOut || times?.[2] || "");
    const ot = action === "flexible_ot" || requestKind === "OT";
    const hour = action === "hour_adjust" || type === "hour approval request";
    const facts = blankFacts();
    facts.employeeName = clean(subjectName || meta.employeeName);
    facts.employeeId = codeOrBlank(subjectEmployeeId) || codeOrBlank(meta.employeeId);
    facts.date = clean(meta.date || from);
    facts.from = from;
    facts.to = to || from;
    facts.requestKind = requestKind;
    facts.timeIn = timeIn;
    facts.timeOut = timeOut;
    facts.duration = durationBetween(timeIn, timeOut, meta.timeOutDate, facts.date);
    facts.otRequestedFor = ot ? clean(meta.targetDate || facts.date) : "";
    facts.otHours = ot ? formatHourAmount(meta.flexibleOtHours) : "";
    facts.otApprovedHours = ot
        ? formatHourAmount(meta.flexibleOtApprovedHours, { allowZero: meta.flexibleOtApprovedHours != null && meta.flexibleOtApprovedHours !== "" })
        : "";
    facts.hoursApproved = hour ? formatHourAmount(meta.hoursApproved, { allowZero: meta.hoursApproved != null && meta.hoursApproved !== "" }) : "";
    facts.hoursTaken = hour ? formatHourAmount(meta.hoursTaken) : "";
    facts.currentStatus = clean(meta.previousStatusLabel);
    facts.requestedStatus = clean(meta.statusLabel || meta.requestedStatusLabel);
    facts.reason = clean(meta.reason);
    return facts;
}

function fill(base, extra) {
    const next = { ...base };
    for (const [key, value] of Object.entries(extra || {})) {
        if (value == null || value === "") continue;
        next[key] = value;
    }
    next.attendance = true;
    return next;
}

export function resolveAttendanceFacts(input = {}) {
    const fallback = attendanceFactsFromAction(input);
    const source = input.source && typeof input.source === "object" ? input.source : {};
    if (!source.attendance && !source.requestKind) return fallback;
    return fill(fallback, source);
}

export function factsFromChangeRequest(row = {}) {
    const proposed = row.proposed || {};
    const previous = row.previous || {};
    const action = clean(row.action || "mark");
    const date = clean(row.date);
    const timeIn = clean(proposed.timeIn);
    const timeOut = clean(proposed.timeOut);
    const facts = blankFacts();
    facts.employeeName = clean(row.employeeName);
    facts.employeeId = codeOrBlank(row.employeeId);
    facts.date = date;
    facts.from = date;
    facts.to = date;
    facts.timeIn = timeIn;
    facts.timeOut = timeOut;
    facts.duration = durationBetween(timeIn, timeOut, proposed.timeOutDate, date);
    facts.currentStatus = clean(previous.statusLabel);
    facts.requestedStatus = clean(proposed.statusLabel);
    facts.reason = clean(proposed.reason || row.rejectReason);
    facts.requestKind = attendanceRequestKind({
        action,
        statusKey: proposed.statusKey,
        statusLabel: proposed.statusLabel,
        previousStatusKey: previous.statusKey,
        previousStatusLabel: previous.statusLabel,
        hourAdjustKind: proposed.hourAdjustKind,
    }) || "Attendance";
    if (action === "flexible_ot") {
        facts.requestKind = "OT";
        facts.otRequestedFor = proposed.confirmNextDay && proposed.targetDate ? clean(proposed.targetDate) : date;
        facts.otHours = formatHourAmount(proposed.flexibleOtHours);
        facts.otApprovedHours = formatHourAmount(proposed.flexibleOtApprovedHours, { allowZero: true });
    }
    if (action === "hour_adjust") {
        facts.hoursApproved = formatHourAmount(proposed.hoursApproved, { allowZero: true });
        facts.hoursTaken = formatHourAmount(proposed.hoursTaken);
    }
    return facts;
}

export function factsFromAttendanceRows(rows = [], requestType = "") {
    const sorted = [...rows].filter(Boolean).sort((a, b) => clean(a.date).localeCompare(clean(b.date)));
    const first = sorted[0] || {};
    const last = sorted[sorted.length - 1] || first;
    const type = clean(requestType).toLowerCase();
    const facts = blankFacts();
    facts.employeeName = clean(first.employeeName);
    facts.employeeId = codeOrBlank(first.employeeId);
    facts.date = clean(first.date);
    facts.reason = clean(first.leaveRequestReason || first.reason || first.flexibleOtReason || first.hourAdjustReason);
    if (type === "flexible ot request") {
        const timeIn = clean(first.timeIn);
        const timeOut = clean(first.timeOut);
        facts.from = facts.date;
        facts.to = facts.date;
        facts.requestKind = "OT";
        facts.timeIn = timeIn;
        facts.timeOut = timeOut;
        facts.duration = durationBetween(timeIn, timeOut, first.timeOutDate, first.date)
            || formatHourAmount(first.flexibleWorkedHours);
        facts.otRequestedFor = clean(first.flexibleOtNextDayDate || first.date);
        facts.otHours = formatHourAmount(first.flexibleOtHours);
        facts.otApprovedHours = formatHourAmount(first.flexibleOtApprovedHours, { allowZero: true });
        facts.requestedStatus = "OT";
        return facts;
    }
    if (type === "hour approval request") {
        const timeIn = clean(first.timeIn);
        const timeOut = clean(first.timeOut);
        facts.from = facts.date;
        facts.to = facts.date;
        facts.timeIn = timeIn;
        facts.timeOut = timeOut;
        facts.duration = durationBetween(timeIn, timeOut, first.timeOutDate, first.date);
        facts.requestKind = attendanceRequestKind({
            action: "hour_adjust",
            hourAdjustKind: first.hourAdjustKind,
            statusKey: first.statusKey,
            statusLabel: first.statusLabel,
        }) || "Hour Approval";
        facts.hoursApproved = formatHourAmount(first.hoursApproved, { allowZero: true });
        facts.hoursTaken = formatHourAmount(first.hoursTaken);
        facts.currentStatus = clean(first.statusLabel);
        facts.reason = clean(first.hourAdjustReason || facts.reason);
        return facts;
    }
    const timeIn = clean(first.leaveRequestTimeIn || first.timeIn);
    const timeOut = clean(first.leaveRequestTimeOut || first.timeOut);
    const from = clean(first.leaveRequestFromDate || first.date);
    const to = clean(first.leaveRequestToDate || last.date || from);
    facts.date = clean(first.date || from);
    facts.from = from;
    facts.to = to;
    facts.timeIn = timeIn;
    facts.timeOut = timeOut;
    facts.duration = durationBetween(timeIn, timeOut, first.timeOutDate, first.date)
        || dayPartLabel(first.leaveRequestDayPart, first.leaveRequestSession)
        || inclusiveDays(from, to);
    facts.requestKind = attendanceRequestKind({
        leaveRequestKind: first.leaveRequestKind,
        statusKey: first.requestedStatusKey,
        statusLabel: first.requestedStatusLabel,
        previousStatusKey: first.previousStatusKey || first.statusKey,
        previousStatusLabel: first.previousStatusLabel || first.statusLabel,
    }) || "Attendance";
    facts.currentStatus = clean(first.previousStatusLabel || first.statusLabel);
    facts.requestedStatus = clean(first.requestedStatusLabel);
    return facts;
}
