/**
 * Full task description for the details page.
 * One labeled line per fact: what to do, the record, who asked, and why.
 * Attendance lines include the request, times, duration, and OT or hour-approval hours.
 */

import {
    formatTaskDate,
    formatTaskDateRange,
    isAttendanceTaskType,
    resolveAttendanceFacts,
} from "./attendanceTaskCopy.js";

function text(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseMeta(extra3) {
    if (!extra3) return {};
    if (typeof extra3 === "object") return extra3;
    try {
        const parsed = JSON.parse(String(extra3));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function ownerFrom(value) {
    const raw = text(value);
    if (!raw || raw.length > 80) return { name: "", id: "" };
    if (/\bpending with\b|\byou have\b|\bplease\b|\brequest for\b|\bcurrent stage\b/i.test(raw)) {
        return { name: "", id: "" };
    }
    const id = raw.match(/\(([^)]+)\)\s*$/)?.[1]?.trim() || "";
    const name = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (!name || /^system$/i.test(name)) return { name: "", id: "" };
    return { name, id };
}

function documentFrom(extra1) {
    let value = text(extra1);
    const expiry = value.match(/\(Exp:\s*([^)]+)\)/i)?.[1]?.trim() || "";
    value = value.replace(/^expiry follow-up required:\s*/i, "");
    value = value.replace(/^not renew (pending|rejected):\s*/i, "");
    value = value.replace(/\s+—\s+renew[\s\S]*$/i, "");
    value = value.replace(/\s*\(Exp:\s*[^)]+\)\s*$/i, "");
    value = value.replace(/\s+expiry reminder$/i, "");
    return { document: text(value), expiry };
}

function utilityFrom(extra1, meta) {
    const parts = text(extra1)
        .split(/\s*[·•|]\s*|\s+-\s+|\s+—\s+/)
        .map((part) => text(part))
        .filter(Boolean);
    const account = text(meta.accountNo)
        || parts.find((part) => /\d{5,}/.test(part) && !/\b(19|20)\d{2}\b/.test(part))
        || "";
    const utility = text(meta.utilityType)
        || (parts[0] || "").replace(/\s+(january|february|march|april|may|june|july|august|september|october|november|december)(\s+\d{4})?$/i, "");
    const month = text(meta.billMonth || meta.yearMonth)
        || parts.find((part) => /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(part))
        || "";
    return { utility: text(utility), account, month };
}

function serviceFrom(extra1, meta) {
    const stored = text(meta.serviceType || meta.serviceTypeLabel);
    if (stored) return stored;
    const names = ["Oil Service", "Tire Change", "Mechanical Work", "Body Work", "Accident Repair", "Car Wash"];
    const source = text(extra1);
    return names.find((name) => source.toLowerCase().includes(name.toLowerCase())) || "";
}

function stageFrom(extra2, meta, sourceStage) {
    const stored = text(sourceStage || meta.stage);
    if (stored) return stored;
    const current = text(extra2).match(/Current stage:\s*([^.\n]+)/i);
    if (current?.[1]) return text(current[1]);
    const pending = text(extra2).match(/You have\s+(.+?)\s+pending/i);
    if (pending?.[1] && !/^complete service$/i.test(pending[1])) return text(pending[1]);
    return "";
}

function money(value) {
    const raw = text(value);
    if (!raw) return "";
    if (/^aed\b/i.test(raw)) return raw;
    const number = Number(String(value).replace(/,/g, ""));
    if (!Number.isFinite(number)) return raw;
    return `AED ${number.toLocaleString("en-US")}`;
}

function whatToDo(typeKey, facts) {
    if (isAttendanceTaskType(typeKey)) {
        const kind = facts.requestKind || "attendance";
        return facts.when
            ? `Review this ${kind} request for ${facts.when}.`
            : `Review this ${kind} request.`;
    }
    const doc = facts.document || "the document";
    const service = facts.service || "the service";
    const stage = facts.stage ? ` Current stage: ${facts.stage}.` : "";
    if (typeKey === "vehicle service request") return `Complete ${service}.${stage}`.trim();
    if (typeKey.includes("document expiry") || typeKey === "utility contract expiry") {
        return facts.expiry ? `Renew ${doc}. It expires on ${facts.expiry}.` : `Renew ${doc}.`;
    }
    if (typeKey.includes("not renew")) return `Review the not-renew request for ${doc}.`;
    if (typeKey === "utility bill payment reminder") return `Pay the ${facts.utility || "utility"} bill.`;
    if (typeKey === "utility bill payment") return `Review and pay the ${facts.utility || "utility"} bill.`;
    if (typeKey === "utility entry status change") return `Activate or deactivate the ${facts.utility || "utility"} account.`;
    if (typeKey === "fine" || typeKey === "group fine request" || typeKey === "employee fine request") return "Review this fine.";
    if (typeKey === "loan" || typeKey.includes("loan")) return "Review this loan request.";
    if (typeKey.includes("advance")) return "Review this advance request.";
    if (typeKey === "reward") return "Review this reward.";
    if (typeKey === "payment approval") return "Review this payment.";
    if (typeKey.includes("leave")) return "Approve this leave request.";
    if (typeKey.includes("attendance")) return "Review this attendance request.";
    if (typeKey === "asset assignment") return facts.vehicleNo ? "Complete the vehicle handover." : "Complete the asset assignment.";
    if (typeKey.startsWith("asset ")) return `Complete this asset ${typeKey.replace(/^asset\s+/, "")}.`;
    if (typeKey.startsWith("vehicle ")) return `Complete this vehicle ${typeKey.replace(/^vehicle\s+/, "")}.`;
    if (typeKey.includes("profile activation")) return "Review this profile activation.";
    if (typeKey.includes("salary")) return "Review this salary request.";
    if (typeKey.includes("certificate")) return "Prepare the salary certificate.";
    return facts.taskName || "Review this request.";
}

function push(lines, seen, label, value, { allowRepeat = false } = {}) {
    const clean = text(value);
    if (!clean || clean === "—" || /^system$/i.test(clean) && label !== "Requested by") return;
    const key = `${label}:${clean.toLowerCase()}`;
    if (seen.has(key)) return;
    if (!allowRepeat && seen.has(clean.toLowerCase())) return;
    seen.add(key);
    if (!allowRepeat) seen.add(clean.toLowerCase());
    lines.push(`${label}: ${clean}`);
}

/**
 * @returns {string} Blank when this task should keep its typed description.
 */
export function composeTaskDescription({
    requestType,
    extra1 = "",
    extra2 = "",
    extra3,
    subjectName = "",
    subjectEmployeeId = "",
    comment = "",
    taskName = "",
    requestedBy = "",
    assetNo = "",
    assetName = "",
    vehicleNo = "",
    manual = false,
    source = {},
} = {}) {
    if (manual) return "";
    const typeKey = text(requestType).toLowerCase();
    const meta = parseMeta(extra3);
    const owner = ownerFrom(extra2);
    const doc = documentFrom(extra1);
    const utility = utilityFrom(extra1, meta);
    const employeeTask = /employee|profile|probation|left user|salary|card deleted|loan|advance|fine|reward|leave|attendance|notice/.test(typeKey)
        && !typeKey.startsWith("vehicle")
        && typeKey !== "document expiry reminder"
        && typeKey !== "company document not renew"
        && typeKey !== "company activation";
    const companyTask = typeKey === "document expiry reminder"
        || typeKey.startsWith("company");
    const vehicleDoc = typeKey === "vehicle document expiry reminder";

    const facts = {
        taskName: text(taskName),
        assetNo: text(source.assetNo || assetNo),
        assetName: text(source.assetName || assetName || (vehicleDoc ? owner.name : "")),
        vehicleNo: text(source.vehicleNo || vehicleNo),
        serviceNo: text(source.serviceNo),
        service: text(source.serviceType || serviceFrom(extra1, meta)),
        stage: stageFrom(extra2, meta, source.stage),
        currentKm: source.currentKm != null && source.currentKm !== "" ? String(source.currentKm) : "",
        employee: text(source.employeeName || (employeeTask ? (subjectName || owner.name) : "")),
        employeeId: text(source.employeeId || (employeeTask ? (subjectEmployeeId || owner.id) : "")),
        department: text(source.department),
        designation: text(source.designation),
        company: text(source.companyName || (companyTask ? (subjectName || owner.name) : "")),
        companyId: text(source.companyId || (companyTask ? (subjectEmployeeId || owner.id) : "")),
        document: text(source.document || ((/expiry|not renew/.test(typeKey)) ? doc.document : "")),
        expiry: text(source.expiry || doc.expiry),
        fineType: text(source.fineType || (typeKey.includes("fine") ? extra1 : "")),
        rewardType: text(source.rewardType),
        paymentType: text(source.paymentType || (typeKey === "payment approval" ? extra1 : "")),
        loanType: text(source.loanType),
        amount: money(source.amount || meta.amount || (typeKey === "fine" || typeKey === "loan" ? extra2 : "")),
        account: text(source.accountNo || utility.account),
        utility: text(utility.utility && /utility/.test(typeKey) ? utility.utility : ""),
        month: text(utility.month && /utility/.test(typeKey) ? utility.month : ""),
        bills: text(meta.billCount),
        from: text(source.from || meta.from),
        to: text(source.to || meta.to),
        duration: text(source.duration),
        starts: text(source.monthStart),
        reference: text(source.reference),
        requestedBy: text(requestedBy),
        reason: text(source.reason || comment),
        status: text(source.status),
    };

    if (facts.vehicleNo && (facts.vehicleNo === facts.assetNo || facts.vehicleNo === facts.assetName)) {
        facts.vehicleNo = "";
    }
    if (typeKey.includes("not renew") && !facts.reason) facts.reason = text(extra2);
    if (/^employee /.test(typeKey) && !facts.reason) facts.reason = text(extra1);
    if ((typeKey === "loan" || typeKey.includes("advance")) && /^aed\b/i.test(text(extra1)) && !facts.amount) {
        facts.amount = money(extra1);
    }

    const attendanceTask = isAttendanceTaskType(typeKey);
    const attendance = attendanceTask
        ? resolveAttendanceFacts({
            requestType,
            extra1,
            extra2,
            extra3,
            subjectName,
            subjectEmployeeId,
            source,
        })
        : {};
    if (attendanceTask) {
        facts.requestKind = attendance.requestKind || "Attendance";
        facts.when = formatTaskDateRange(attendance.from || attendance.date, attendance.to || attendance.from || attendance.date);
        facts.employee = attendance.employeeName || facts.employee;
        facts.employeeId = attendance.employeeId || facts.employeeId;
        facts.timeIn = attendance.timeIn || "";
        facts.timeOut = attendance.timeOut || "";
        facts.duration = attendance.duration || facts.duration;
        facts.otFor = formatTaskDate(attendance.otRequestedFor);
        facts.otHours = attendance.otHours || "";
        facts.approvedHours = attendance.otApprovedHours || attendance.hoursApproved || "";
        facts.hoursTaken = attendance.hoursTaken || "";
        facts.currentStatus = attendance.currentStatus || "";
        facts.requestedStatus = attendance.requestedStatus || "";
        if (attendance.reason) facts.reason = attendance.reason;
        else if (/^\d{4}-\d{2}-\d{2}$/.test(facts.reason) || /request for/i.test(facts.reason)) facts.reason = "";
        facts.from = "";
        facts.to = "";
    }

    const lines = [];
    const seen = new Set();
    const add = (label, value, options) => push(lines, seen, label, value, options);
    add("What to do", whatToDo(typeKey, facts));
    if (attendanceTask) {
        add("Request", facts.requestKind);
        add("Date", facts.when);
        add("Employee", facts.employee);
        add("Employee ID", facts.employeeId);
        add("Time in", facts.timeIn);
        add("Time out", facts.timeOut);
        add("Duration", facts.duration);
        add("OT requested for", facts.otFor, { allowRepeat: true });
        add("OT hours", facts.otHours);
        add("Approved hours", facts.approvedHours);
        add("Hours taken", facts.hoursTaken);
        add("Current", facts.currentStatus);
        add("Requested", facts.requestedStatus);
    }
    add("Asset No", facts.assetNo);
    add("Asset Name", facts.assetName);
    add("Vehicle No", facts.vehicleNo);
    add("Service No", facts.serviceNo);
    add("Service", facts.service);
    add("Stage", facts.stage);
    add("Current KM", facts.currentKm);
    add("Employee", facts.employee);
    add("Employee ID", facts.employeeId);
    add("Department", facts.department);
    add("Designation", facts.designation);
    add("Company", facts.company);
    add("Company ID", facts.companyId);
    add("Document", facts.document);
    add("Expiry", facts.expiry);
    add("Fine Type", facts.fineType);
    add("Reward", facts.rewardType);
    add("Payment", facts.paymentType);
    add("Loan / Advance", facts.loanType);
    add("Amount", facts.amount);
    add("Utility", facts.utility);
    add("Account No", facts.account);
    add("Bill Month", facts.month);
    add("Bills", facts.bills);
    add("From", facts.from);
    add("To", facts.to);
    add("Duration", facts.duration);
    add("Repayment starts", facts.starts);
    add("Reference", facts.reference);
    add("Status", facts.status);
    add("Requested by", facts.requestedBy);
    add("Reason", facts.reason);

    const leftover = attendanceTask ? "" : [extra2, extra1, source.note].map(text).find((value) => {
        if (!value || value.length < 12) return false;
        if (seen.has(value.toLowerCase())) return false;
        if (owner.name && value.replace(/\s*\([^)]*\)\s*$/, "").trim() === owner.name) return false;
        if (facts.document && /expiry follow-up|not renew/i.test(value) && value.toLowerCase().includes(facts.document.toLowerCase())) return false;
        if (facts.assetNo && value.includes(facts.assetNo) && value.length < 80 && !/\bplease\b|\byou have\b/i.test(value)) return false;
        return !lines.some((line) => line.toLowerCase().includes(value.toLowerCase()));
    });
    add("Details", leftover);

    return lines.join("\n");
}
