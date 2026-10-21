/**
 * Exact page + section for a task's "Open this section" link.
 * Attendance opens the mark-day row and its request modal.
 * Utility, asset, employee, and company links open the record, row, or review modal.
 */

const HUB_REQUEST_TYPES = new Set([
    "Employee Advance Request",
    "Employee Loan Request",
    "Employee Salary Request",
    "Employee Certificate Request",
    "Employee Asset Request",
    "Employee Fine Request",
    "Employee Vehicle Request",
    "Employee Utility Request",
]);

function clean(value) {
    return String(value || "").trim();
}

function dateKey(value) {
    const match = clean(value).match(/\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : "";
}

function mongoId(value) {
    const text = clean(value);
    return /^[a-f0-9]{24}$/i.test(text) ? text : "";
}

function requestTypeOf(meta, requestType) {
    return clean(requestType || meta?.requestType);
}

export function buildAttendanceSectionPath({ meta = {}, requestId = "", requestType = "", subjectEmployeeId = "" } = {}) {
    const type = requestTypeOf(meta, requestType).toLowerCase();
    const sickLeave =
        clean(meta.requestedStatusKey) === "sick_leave" ||
        /sick leave/i.test(`${type} ${clean(meta.requestedStatusLabel)}`);
    const markTask =
        type === "attendance leave request" ||
        type === "attendance change request" ||
        type === "hour approval request" ||
        type === "flexible ot request" ||
        (type === "employee leave request" && sickLeave) ||
        meta.attendanceChange === true;
    if (!markTask) return "";

    const params = new URLSearchParams();
    const day = dateKey(meta.date) || dateKey(meta.from) || dateKey(meta.extra1);
    if (day) params.set("date", day);
    params.set("staffType", clean(meta.staffType) || "office");

    const employee = mongoId(meta.employeeMongoId) || mongoId(subjectEmployeeId);
    if (employee) params.set("blinkEmployee", employee);

    const id = clean(requestId) || clean(meta.attendanceId);
    if (type === "attendance change request" || meta.attendanceChange === true) {
        if (id) params.set("changeRequestId", id);
    } else if (type === "hour approval request") {
        if (id) params.set("hourAttendanceId", id);
    } else if (type === "flexible ot request") {
        if (id) params.set("otAttendanceId", id);
    } else if (id) {
        params.set("leaveAttendanceId", id);
    }

    const query = params.toString();
    return query ? `/HRM/Attendance/mark?${query}` : "/HRM/Attendance/mark";
}

export function buildHubSectionPath({ meta = {}, requestId = "", requestType = "" } = {}) {
    const type = requestTypeOf(meta, requestType);
    const hub = meta.hubRequest === true || HUB_REQUEST_TYPES.has(type);
    const leaveHub = type === "Employee Leave Request" || (meta.hubRequest === true && meta.kind === "leave");
    if (leaveHub) {
        if (dateKey(meta.from) || dateKey(meta.to) || clean(meta.attendanceId)) return "";
        return "/HRM/Leave/annual-leave";
    }
    if (!hub) return "";
    const id = clean(requestId);
    if (!id) return "";
    const params = new URLSearchParams({ hubRequestId: id });
    const employee = mongoId(meta.requesterMongoId);
    if (employee) params.set("viewEmployee", employee);
    return `/dashboard?${params.toString()}`;
}

export function buildUtilitySectionPath({ meta = {}, requestId = "", requestType = "", stored = "" } = {}) {
    const type = requestTypeOf(meta, requestType).toLowerCase();
    const utility = type.includes("utility") || /utility/i.test(stored);
    if (!utility) return "";

    const statusId = clean(meta.statusChangeId);
    if (type.includes("status") || statusId) {
        const id = statusId || clean(requestId);
        if (id) return `/HRM/Asset/UtilityBills?statusChangeId=${encodeURIComponent(id)}&review=1`;
    }

    const paymentApproval =
        type.includes("utility bill payment") && !type.includes("reminder") && !type.includes("contract");
    if (paymentApproval) {
        const batchId = clean(meta.batchId) || clean(requestId);
        if (batchId) return `/HRM/Asset/UtilityBills?batchId=${encodeURIComponent(batchId)}`;
    }

    const reminder = type.includes("reminder") || /addBill=1/.test(stored);
    if (reminder) {
        if (stored && /addBill=1/.test(stored)) return stored;
        const entryId = clean(meta.entryId);
        if (entryId) {
            const params = new URLSearchParams({ addBill: "1" });
            const month = clean(meta.billMonth) || clean(meta.yearMonth);
            if (month) params.set("billMonth", month);
            return `/HRM/Asset/UtilityBills/details/${encodeURIComponent(entryId)}?${params.toString()}`;
        }
    }

    if (stored && /\/UtilityBills\/details\//.test(stored)) return stored;
    const entryId = clean(meta.entryId);
    if (entryId) {
        const params = new URLSearchParams();
        if (clean(meta.billId)) params.set("billId", clean(meta.billId));
        const query = params.toString();
        return `/HRM/Asset/UtilityBills/details/${encodeURIComponent(entryId)}${query ? `?${query}` : ""}`;
    }
    if (/[?&](batchId|statusChangeId)=/.test(stored)) return stored;
    return "";
}

export function buildAssetListSectionPath({ meta = {}, requestId = "", requestType = "" } = {}) {
    const type = requestTypeOf(meta, requestType).toLowerCase();
    if (type.includes("owner on duty")) {
        const id = clean(requestId);
        return id ? `/HRM/Asset?ownerOnDutyReview=${encodeURIComponent(id)}` : "/HRM/Asset";
    }
    if (meta.isBulkAssignment && clean(meta.bulkAssignmentGroupId)) {
        const params = new URLSearchParams({ bulkAssignmentGroup: clean(meta.bulkAssignmentGroupId) });
        const assetId = clean(meta.focusAsset) || clean(requestId);
        if (assetId) params.set("focusAsset", assetId);
        return `/HRM/Asset?${params.toString()}`;
    }
    return "";
}

export function buildEmployeeSectionPath(employeeCode, requestType = "") {
    const code = clean(employeeCode);
    if (!code) return "";
    const type = clean(requestType).toLowerCase();
    const base = `/emp/${encodeURIComponent(code)}`;
    if (type.includes("probation") || type.includes("notice") || type.includes("left user")) {
        return `${base}?tab=work-details`;
    }
    if (type.includes("profile")) return `${base}?tab=basic&focusCard=basic-details`;
    return base;
}

export function buildCompanySectionPath(companyId, requestType = "") {
    const id = clean(companyId);
    if (!id) return "";
    const type = clean(requestType).toLowerCase();
    const base = `/Company/${encodeURIComponent(id)}`;
    if (type.includes("company activation") && !type.includes("incomplete")) {
        return `${base}?tab=basic&focusCard=basicDetails&activationReview=1`;
    }
    return base;
}
