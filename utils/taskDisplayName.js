/**
 * Task Manager name, listed as separate lines.
 * First line is the task. Following lines are the employee, vehicle, or record.
 * Vehicle service: service, then vehicle name and plate.
 * Document expiry: "{document} - Expiry", then the owner.
 * Not renew: "{document} - Not Renew", then the owner.
 * Attendance: "{date} {Late In | OT | Mispunch | Comp Off | …}", then the employee.
 * The long notification sentence stays in the description.
 */

import {
    attendanceTaskTitle,
    isAttendanceTaskType,
    resolveAttendanceFacts,
} from "./attendanceTaskCopy.js";

const SERVICE_TYPES = [
    "Oil Service",
    "Tire Change",
    "Mechanical Work",
    "Body Work",
    "Accident Repair",
    "Car Wash",
];

const MANUAL_TYPES = new Set([
    "system task",
    "workflow task",
    "general task",
    "task manager",
]);

const VEHICLE_LABELS = {
    "vehicle profile activation": "Profile Activation",
    "vehicle profile edit": "Profile Edit",
    "vehicle profile incomplete": "Profile Incomplete",
    "vehicle value missing": "Value Missing",
    "vehicle inspection": "Inspection",
    "vehicle assignment photo review": "Photo Review",
    "vehicle mortgage close": "Mortgage Close",
    "vehicle disposition request": "Disposition",
    "vehicle delete request": "Delete Request",
    "vehicle access fuel reminder": "Fuel Limit",
};

const ASSET_LABELS = {
    asset: "Asset",
    "asset approval": "Approval",
    "asset assignment": "Assignment",
    "asset reassign": "Reassign",
    "asset return": "Return",
    "asset transfer": "Transfer",
    "asset retention": "Retention",
    "asset loss damage": "Loss & Damage",
    "asset end of life": "End of Life",
    "asset overdue": "Overdue",
    "asset value missing": "Value Missing",
    "asset leave": "Leave",
    "asset owner on duty": "Owner On Duty",
    "asset on duty request": "On Duty",
    "asset bulk action": "Bulk Asset Action",
    "asset accessory": "Accessory",
    "asset accessory approval": "Accessory Approval",
    "asset accessory unattach": "Accessory Unattach",
};

const PERSON_LABELS = {
    "profile activation": "Profile Activation",
    "profile incomplete": "Profile Incomplete",
    "probation change": "Probation Change",
    "left user request": "Left User",
    "card deleted progress": "Card Deleted",
    "company activation": "Activation",
    "company activation incomplete": "Activation Incomplete",
    "salary enrollment": "Salary Enrollment",
    "salary dmf approval": "Payroll Approval",
    loan: "Loan",
    advance: "Advance",
    reward: "Reward",
    "employee loan request": "Loan Request",
    "employee advance request": "Advance Request",
    "attendance leave request": "Attendance Leave",
    "attendance change request": "Attendance Change",
    "hour approval request": "Hour Approval",
    "flexible ot request": "Flexible OT",
    "notice request": "Notice",
    "responsibility approval": "Responsibility Approval",
};

const HUB_LABELS = {
    "employee salary request": "Early Salary",
    "employee certificate request": "Salary Certificate",
    "employee fine request": "Fine Request",
    "employee vehicle request": "Vehicle Request",
    "employee utility request": "Utility Bill Request",
};

const EXPIRY_TYPES = new Set([
    "document expiry reminder",
    "employee document expiry reminder",
    "vehicle document expiry reminder",
]);

function text(value) {
    return String(value || "").trim();
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

function isObjectId(value) {
    return /^[a-fA-F0-9]{24}$/.test(text(value));
}

export function vehicleRecordId({ requestType, requestId, extra3 } = {}) {
    const meta = parseMeta(extra3);
    const fromMeta = text(meta.vehicleId || meta.vehicleMongoId);
    if (isObjectId(fromMeta)) return fromMeta;
    const type = text(requestType);
    if (/^(vehicle|asset)\b/i.test(type) && isObjectId(requestId)) return text(requestId);
    return "";
}

function shortName(value) {
    const cleaned = text(value).replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (!cleaned || cleaned.length > 80) return "";
    if (/^(system|unassigned)$/i.test(cleaned)) return "";
    if (/\bpending with\b|\byou have\b|\bplease\b|\brequest for\b|\bcurrent stage\b/i.test(cleaned)) return "";
    return cleaned;
}

function uniqueLines(title, values = []) {
    const lines = [];
    const seen = new Set();
    const push = (value) => {
        const line = text(value);
        if (!line) return;
        const key = line.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        lines.push(line);
    };
    push(title);
    values.forEach(push);
    const [first, ...rest] = lines;
    return { title: first || "Task", subject: rest.join("\n") };
}

function serviceTypeFrom(meta, body) {
    const stored = text(meta.serviceType || meta.serviceTypeLabel);
    if (stored) return stored;
    const source = text(body);
    const found = SERVICE_TYPES.find((name) => source.toLowerCase().includes(name.toLowerCase()));
    if (found) return found;
    const pending = source.match(/^(.+?)\s+pending with\b/i);
    return pending ? text(pending[1]) : "";
}

function docLabel(body, meta) {
    const fromMeta = text(meta.label || meta.docLabel);
    let value = text(body);
    value = value.replace(/^expiry follow-up required:\s*/i, "");
    value = value.replace(/^not renew (pending|rejected):\s*/i, "");
    value = value.replace(/\s+—\s+renew[\s\S]*$/i, "");
    value = value.replace(/\s*\(exp:\s*[^)]+\)\s*$/i, "");
    value = value.replace(/\s+expiry reminder$/i, "");
    return text(fromMeta || value);
}

function utilityParts(body, meta) {
    const parts = text(body)
        .split(/\s*[·•|]\s*|\s+-\s+|\s+—\s+/)
        .map((part) => text(part))
        .filter(Boolean);
    const accountFromParts = parts.find((part) => /\d{5,}/.test(part) && !/\b(19|20)\d{2}\b/.test(part) && !/bill/i.test(part)) || "";
    const rawType = text(meta.utilityType) || parts[0] || "Utility";
    const typeName = rawType
        .replace(/\s+(january|february|march|april|may|june|july|august|september|october|november|december)(\s+\d{4})?$/i, "")
        .replace(/\s+\d{4}-\d{2}$/, "")
        .trim();
    return {
        type: typeName || "Utility",
        account: text(meta.accountNo) || accountFromParts,
    };
}

function isGeneratedTitle(stored) {
    const value = text(stored);
    if (!value) return false;
    if (/^(employee |company |vehicle )?document expiry( reminder)?$/i.test(value)) return true;
    if (/^.+ expiry reminder — .+$/i.test(value)) return true;
    if (/^.+ not renew — .+$/i.test(value)) return true;
    if (/,\s*(attendance leave|attendance change|hour approval|flexible ot)$/i.test(value)) return true;
    return false;
}

function isCustomName(stored, body, requestType, secondary = "") {
    if (!stored) return false;
    if (isGeneratedTitle(stored)) return false;
    if (stored.toLowerCase() === text(requestType).toLowerCase()) return false;
    if (stored === text(body)) return false;
    if (/\bpending with\b/i.test(stored)) return false;
    if (/^expiry follow-up required:/i.test(stored)) return false;
    if (/^not renew (pending|rejected):/i.test(stored)) return false;
    const ownerLine = text(secondary);
    if (ownerLine && stored.toLowerCase() === ownerLine.toLowerCase()) return false;
    return true;
}

function parenCode(value) {
    const id = text(value).match(/\(([^)]+)\)\s*$/)?.[1] || "";
    if (!id || id.length > 40 || isObjectId(id)) return "";
    return id;
}

function recordCode(value) {
    const code = text(value);
    if (!code || isObjectId(code)) return "";
    return code;
}

function vehicleServiceName(assetName) {
    const name = text(assetName);
    if (!name || /^vehicle$/i.test(name)) return "";
    return name;
}

function personLines({ subjectName, subjectEmployeeId, extra2, source }) {
    const name = shortName(source?.employeeName)
        || shortName(source?.companyName)
        || shortName(subjectName)
        || shortName(extra2);
    const code = recordCode(source?.employeeId)
        || recordCode(source?.companyId)
        || recordCode(subjectEmployeeId)
        || parenCode(extra2);
    return [name, code];
}

function vehicleLines({ vehicleNo, assetNo, assetName, subjectEmployeeId, extra2, source }) {
    const name = vehicleServiceName(source?.assetName || assetName) || shortName(extra2);
    const plate = text(source?.vehicleNo) || text(vehicleNo);
    const code = text(source?.assetNo) || text(assetNo) || recordCode(subjectEmployeeId) || parenCode(extra2);
    if (plate) return [name, plate];
    return [name, code];
}

function assetParts(typeKey, { body, vehicleNo, assetLabel, hasPlate }) {
    const action = ASSET_LABELS[typeKey];
    if (!action) return null;
    if (hasPlate && vehicleNo) {
        const vehicleAction = typeKey === "asset assignment" ? "Handover" : action;
        return uniqueLines(vehicleAction, [vehicleNo]);
    }
    const identity = text(assetLabel) || text(body).replace(/\s+/g, " ");
    if (identity && identity.length <= 80 && !/\bpending with\b/i.test(identity)) {
        if (identity.toLowerCase().includes(action.toLowerCase())) return uniqueLines(identity);
        return uniqueLines(action, [identity.replace(/[,\s]+$/, "")]);
    }
    return uniqueLines(action);
}

/**
 * @returns {{ title: string, subject: string }} First line is the task. Subject lines are separated by newlines.
 */
export function formatTaskDisplayParts({
    requestType,
    extra1,
    extra2,
    extra3,
    subjectName,
    subjectEmployeeId,
    taskName,
    vehicleNo,
    assetNo,
    assetName,
    assetLabel,
    hasPlate,
    manual,
    source,
} = {}) {
    const type = text(requestType);
    const typeKey = type.toLowerCase();
    const body = text(extra1);
    const secondary = text(extra2);
    const stored = text(taskName);
    const meta = parseMeta(extra3);
    const owners = { subjectName, subjectEmployeeId, extra2: secondary, source, vehicleNo, assetNo, assetName };

    if (manual || MANUAL_TYPES.has(typeKey)) return uniqueLines(stored || body || "Task");

    if (isAttendanceTaskType(type)) {
        const facts = resolveAttendanceFacts({
            requestType: type,
            extra1: body,
            extra2: secondary,
            extra3: meta,
            subjectName,
            subjectEmployeeId,
            source,
        });
        return uniqueLines(attendanceTaskTitle(facts), [facts.employeeName || facts.employeeId]);
    }

    if (typeKey === "vehicle service request") {
        const service = serviceTypeFrom(meta, body) || text(source?.serviceType) || "Service";
        return uniqueLines(service, vehicleLines(owners));
    }

    if (EXPIRY_TYPES.has(typeKey) || typeKey === "company document not renew" || typeKey === "employee document not renew") {
        const doc = docLabel(body, meta) || "Document";
        const action = typeKey.includes("not renew") ? "Not Renew" : "Expiry";
        const lines = typeKey.includes("vehicle") ? vehicleLines(owners) : personLines(owners);
        return uniqueLines(`${doc} - ${action}`, lines);
    }

    if (typeKey === "utility contract expiry") {
        const { type: utilityType, account } = utilityParts(body, meta);
        const provider = text(body).split(/\s*[·•]\s*/)[1] || account;
        return uniqueLines(`${utilityType} Contract Expiry`, [shortName(provider)]);
    }

    if (
        typeKey === "utility bill payment reminder"
        || typeKey === "utility bill payment"
        || typeKey === "utility entry status change"
    ) {
        const { type: utilityType, account } = utilityParts(body, meta);
        return uniqueLines(utilityType, [account]);
    }

    if (typeKey === "fine" || typeKey === "employee fine request") {
        const title = typeKey === "employee fine request" ? "Fine Request" : (shortName(body) || "Fine");
        return uniqueLines(title, personLines(owners));
    }
    if (typeKey === "group fine request") {
        const fineType = shortName(body);
        return uniqueLines(fineType && !/^group fine/i.test(fineType) ? `Group Fine, ${fineType}` : "Group Fine");
    }

    if (typeKey === "payment approval") {
        const paymentType = shortName(body);
        return uniqueLines(paymentType && !/^payment/i.test(paymentType) ? `Payment, ${paymentType}` : "Payment Approval");
    }

    if (Object.prototype.hasOwnProperty.call(HUB_LABELS, typeKey)) {
        return uniqueLines(HUB_LABELS[typeKey], personLines(owners));
    }

    if (typeKey === "employee asset request") {
        const area = secondary.replace(/^assets\s*[·•-]?\s*/i, "").trim();
        const title = area && !/^assets$/i.test(secondary) ? `Assets, ${area}` : "Assets";
        return uniqueLines(title, personLines(owners));
    }

    if (Object.prototype.hasOwnProperty.call(VEHICLE_LABELS, typeKey)) {
        return uniqueLines(VEHICLE_LABELS[typeKey], vehicleLines(owners));
    }

    if (Object.prototype.hasOwnProperty.call(ASSET_LABELS, typeKey)) {
        return assetParts(typeKey, { body, vehicleNo, assetLabel, hasPlate });
    }

    if (Object.prototype.hasOwnProperty.call(PERSON_LABELS, typeKey)) {
        return uniqueLines(PERSON_LABELS[typeKey], personLines(owners));
    }

    if (isCustomName(stored, body, type, secondary)) return uniqueLines(stored, personLines(owners));

    if (body && body.length <= 80 && !/\bpending with\b/i.test(body) && !/^expiry follow-up required:/i.test(body)) {
        return uniqueLines(body, personLines(owners));
    }
    return uniqueLines(type || stored || "Task", personLines(owners));
}

/**
 * @returns {string} First line of the task name.
 */
export function formatTaskDisplayName(input = {}) {
    return formatTaskDisplayParts(input).title;
}
