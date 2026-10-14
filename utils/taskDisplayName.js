/**
 * Short Task Manager name.
 * Vehicle service: "{vehicle no}, {service type}".
 * Document expiry: "{doc name} Expiry Reminder — {employee / vehicle / company}".
 * The long notification sentence stays in the description.
 */

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

function joinName(left, right) {
    const a = text(left);
    const b = text(right);
    if (a && b) return `${a}, ${b}`;
    return a || b;
}

function withOwner(title, owner) {
    const head = text(title);
    const who = text(owner);
    if (!head) return who;
    if (!who || head.toLowerCase().includes(who.toLowerCase())) return head;
    return `${head} — ${who}`;
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

function isCustomName(stored, body, requestType, secondary = "") {
    if (!stored) return false;
    if (stored.toLowerCase() === text(requestType).toLowerCase()) return false;
    if (stored === text(body)) return false;
    if (/\bpending with\b/i.test(stored)) return false;
    if (/^expiry follow-up required:/i.test(stored)) return false;
    if (/^not renew (pending|rejected):/i.test(stored)) return false;
    const ownerLine = text(secondary);
    if (ownerLine && stored.toLowerCase() === ownerLine.toLowerCase()) return false;
    return true;
}

function assetTitle(typeKey, { body, vehicleNo, assetLabel, hasPlate }) {
    const action = ASSET_LABELS[typeKey];
    if (!action) return "";
    if (hasPlate && vehicleNo) {
        const vehicleAction = typeKey === "asset assignment" ? "Handover" : action;
        return joinName(vehicleNo, vehicleAction);
    }
    const identity = text(assetLabel) || text(body).replace(/\s+/g, " ");
    if (identity && identity.length <= 80 && !/\bpending with\b/i.test(identity)) {
        if (identity.toLowerCase().includes(action.toLowerCase())) return identity;
        return `${identity.replace(/[,\s]+$/, "")}, ${action}`;
    }
    return action;
}

/**
 * @returns {string} Task Name shown in the list and on the task details page.
 */
export function formatTaskDisplayName({
    requestType,
    extra1,
    extra2,
    extra3,
    subjectName,
    taskName,
    vehicleNo,
    assetLabel,
    hasPlate,
    manual,
} = {}) {
    const type = text(requestType);
    const typeKey = type.toLowerCase();
    const body = text(extra1);
    const secondary = text(extra2);
    const stored = text(taskName);
    const meta = parseMeta(extra3);

    if (manual || MANUAL_TYPES.has(typeKey)) return stored || body || "Task";
    if (isCustomName(stored, body, type, secondary)) return stored;

    if (typeKey === "vehicle service request") {
        const service = serviceTypeFrom(meta, body) || "Service";
        return joinName(vehicleNo, service);
    }

    if (EXPIRY_TYPES.has(typeKey)) {
        const doc = docLabel(body, meta) || "Document";
        const owner = shortName(secondary) || shortName(subjectName);
        return withOwner(`${doc} Expiry Reminder`, owner);
    }

    if (typeKey === "utility contract expiry") {
        const { type: utilityType, account } = utilityParts(body, meta);
        const provider = text(body).split(/\s*[·•]\s*/)[1] || account;
        return withOwner(`${utilityType} Contract Expiry Reminder`, shortName(provider));
    }

    if (typeKey === "company document not renew" || typeKey === "employee document not renew") {
        const doc = docLabel(body, meta) || "Document";
        return withOwner(`${doc} Not Renew`, shortName(subjectName));
    }

    if (
        typeKey === "utility bill payment reminder"
        || typeKey === "utility bill payment"
        || typeKey === "utility entry status change"
    ) {
        const { type: utilityType, account } = utilityParts(body, meta);
        return joinName(utilityType, account);
    }

    if (typeKey === "fine" || typeKey === "employee fine request") {
        return typeKey === "employee fine request" ? "Fine Request" : (shortName(body) || "Fine");
    }
    if (typeKey === "group fine request") {
        const fineType = shortName(body);
        return fineType && !/^group fine/i.test(fineType) ? `Group Fine, ${fineType}` : "Group Fine";
    }

    if (typeKey === "payment approval") {
        const paymentType = shortName(body);
        return paymentType && !/^payment/i.test(paymentType) ? `Payment, ${paymentType}` : "Payment Approval";
    }

    if (typeKey === "employee leave request") {
        const match = secondary.match(/^(.+?)\s+request for\b/i) || body.match(/^(.+?)\s+request for\b/i);
        return joinName(match ? text(match[1]) : "Leave", shortName(subjectName));
    }

    if (Object.prototype.hasOwnProperty.call(HUB_LABELS, typeKey)) return HUB_LABELS[typeKey];

    if (typeKey === "employee asset request") {
        const area = secondary.replace(/^assets\s*[·•-]?\s*/i, "").trim();
        return area && !/^assets$/i.test(secondary) ? `Assets, ${area}` : "Assets";
    }

    if (Object.prototype.hasOwnProperty.call(VEHICLE_LABELS, typeKey)) {
        return joinName(vehicleNo, VEHICLE_LABELS[typeKey]);
    }

    if (Object.prototype.hasOwnProperty.call(ASSET_LABELS, typeKey)) {
        return assetTitle(typeKey, { body, vehicleNo, assetLabel, hasPlate });
    }

    if (Object.prototype.hasOwnProperty.call(PERSON_LABELS, typeKey)) {
        return joinName(shortName(subjectName) || shortName(secondary), PERSON_LABELS[typeKey]);
    }

    if (body && body.length <= 80 && !/\bpending with\b/i.test(body) && !/^expiry follow-up required:/i.test(body)) {
        return body;
    }
    return type || stored || "Task";
}
