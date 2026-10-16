import mongoose from "mongoose";
import nodemailer from "nodemailer";
import { rememberSentEmail } from "./emailDispatch.js";
import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import TaskManagerTask from "../models/TaskManagerTask.js";
import EmployeeContact from "../models/EmployeeContact.js";
import { emailFrontendUrl } from "./resolveFrontendBaseUrl.js";
import { resolveEmployeeEmailWithReporteeLoaded } from "./resolveEmployeeEmail.js";
import { isReqUserSystemSuperUser } from "./systemSuperUser.js";
import { buildEmployeeExpiryAccessPath, buildEmployeePathWithFocus } from "./notificationFocusNavigation.js";
import {
    buildAssetListSectionPath,
    buildAttendanceSectionPath,
    buildCompanySectionPath,
    buildEmployeeSectionPath,
    buildHubSectionPath,
    buildUtilitySectionPath,
} from "./taskSectionPath.js";
import { resolveVehicleExpiryFocusCard, resolveVehicleExpiryTab } from "./vehicleExpiryScanUtils.js";

const TASK_TYPE_LABELS = new Map([
    ["system", "System Task"],
    ["system task", "System Task"],
    ["workflow", "Workflow Task"],
    ["workflow task", "Workflow Task"],
    ["work flow task", "Workflow Task"],
    ["general", "General Task"],
    ["general task", "General Task"],
]);

export function canonicalTaskType(value) {
    const key = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    return TASK_TYPE_LABELS.get(key) || "";
}

/** UI label. Keeps an unknown stored value so older rows still display. */
export function displayTaskType(value) {
    return canonicalTaskType(value) || String(value || "").trim();
}

export function personName(record) {
    if (!record) return "";
    if (record.name) return String(record.name).trim();
    return [record.firstName, record.lastName].filter(Boolean).join(" ").trim();
}

export function isObjectId(value) {
    const text = String(value || "");
    return /^[a-fA-F0-9]{24}$/.test(text);
}

export function moduleForText(...parts) {
    const blob = parts.filter(Boolean).join(" ").toLowerCase();
    if (blob.includes("vehicle") || blob.includes("fleet") || blob.includes("plate")) {
        return { module: "vehicle", label: "Vehicle", path: "/HRM/Asset/Vehicle" };
    }
    if (blob.includes("fine")) return { module: "fine", label: "Fine", path: "/HRM/Fine" };
    if (blob.includes("leave")) return { module: "leave", label: "Leave", path: "/HRM/Leave/annual-leave" };
    if (blob.includes("attendance")) return { module: "attendance", label: "Attendance", path: "/HRM/Attendance" };
    if (blob.includes("loan") || blob.includes("advance")) {
        return { module: "loan", label: "Loan and Advance", path: "/HRM/LoanAndAdvance" };
    }
    if (blob.includes("reward")) return { module: "reward", label: "Reward", path: "/HRM/Reward" };
    if (blob.includes("salary") || blob.includes("payroll")) {
        return { module: "salary", label: "Salary", path: "/HRM/Salary" };
    }
    if (blob.includes("utility")) return { module: "utility", label: "Utility Bills", path: "/HRM/Asset/UtilityBills" };
    if (blob.includes("tool") || blob.includes("asset")) {
        return { module: "tools", label: "Tools Asset", path: "/HRM/Asset" };
    }
    if (blob.includes("payment")) return { module: "payment", label: "Payments", path: "/Accounts/Payments" };
    if (blob.includes("company")) return { module: "company", label: "Company", path: "/Company" };
    return { module: "general", label: "Task Manager", path: "/task-manager" };
}

export function moduleForRequestType(requestType, extraText = "") {
    const type = String(requestType || "");
    const low = type.toLowerCase();
    if (low.startsWith("vehicle") || low.includes("vehicle")) {
        return { module: "vehicle", label: "Vehicle", path: "/HRM/Asset/Vehicle" };
    }
    if (low.includes("fine")) return { module: "fine", label: "Fine", path: "/HRM/Fine" };
    if (low.includes("leave")) return { module: "leave", label: "Leave", path: "/HRM/Leave/annual-leave" };
    if (low.includes("attendance")) return { module: "attendance", label: "Attendance", path: "/HRM/Attendance" };
    if (low.includes("loan") || low.includes("advance")) {
        return { module: "loan", label: "Loan and Advance", path: "/HRM/LoanAndAdvance" };
    }
    if (low.includes("reward")) return { module: "reward", label: "Reward", path: "/HRM/Reward" };
    if (low.includes("salary")) return { module: "salary", label: "Salary", path: "/HRM/Salary" };
    if (low.includes("utility")) return { module: "utility", label: "Utility Bills", path: "/HRM/Asset/UtilityBills" };
    if (low.includes("payment")) return { module: "payment", label: "Payments", path: "/Accounts/Payments" };
    if (low.includes("company")) return { module: "company", label: "Company", path: "/Company" };
    if (low.includes("asset") || low.includes("tool")) {
        return { module: "tools", label: "Tools Asset", path: "/HRM/Asset" };
    }
    if (low.includes("profile") || low.includes("probation") || low.includes("employee") || low.includes("notice")) {
        return { module: "employees", label: "Employees", path: "/emp" };
    }
    return moduleForText(type, extraText);
}

function parseTaskMeta(context) {
    if (!context) return {};
    if (typeof context === "string") {
        try {
            const parsed = JSON.parse(context);
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
            return {};
        }
    }
    if (typeof context !== "object") return {};
    const raw = context.extra3;
    let meta = {};
    if (raw && typeof raw === "object") meta = { ...raw };
    else if (typeof raw === "string" && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") meta = parsed;
        } catch {
            meta = {};
        }
    } else if (!raw) {
        meta = { ...context };
    }
    if (context.requestType) meta.requestType = context.requestType;
    if (context.extra1) meta.extra1 = context.extra1;
    if (context.extra2) meta.extra2 = context.extra2;
    return meta;
}

function appPath(value) {
    let text = String(value || "").trim();
    if (!text) return "";
    if (/^https?:\/\//i.test(text)) {
        try {
            const url = new URL(text);
            text = `${url.pathname}${url.search}`;
        } catch {
            return "";
        }
    }
    if (!text.startsWith("/") || text.startsWith("//") || text.includes("..")) return "";
    return text;
}

function storedRecordPath(meta) {
    const review = appPath(meta?.reviewPath);
    if (review && /[?&](statusChangeId|batchId)=/.test(review)) return review;
    return ["detailsPath", "reviewPath", "linkPath", "href", "path"]
        .map((key) => appPath(meta?.[key]))
        .find(Boolean) || "";
}

function inferServiceType(...parts) {
    const blob = parts.filter(Boolean).join(" ").toLowerCase();
    if (blob.includes("oil service") || blob.includes("oil-service")) return "Oil Service";
    if (blob.includes("tire change") || blob.includes("tyre")) return "Tire Change";
    if (blob.includes("mechanical")) return "Mechanical Work";
    if (blob.includes("body work")) return "Body Work";
    if (blob.includes("accident")) return "Accident Repair";
    if (blob.includes("car wash")) return "Car Wash";
    return "";
}

/** Exact vehicle service page, not the vehicle profile. */
function vehicleServicePath(vehicleId, serviceId, serviceType, stored, focus) {
    const vehicle = String(vehicleId || "").trim();
    const service = String(serviceId || "").trim();
    if (!vehicle || !service) return "";
    const type = String(serviceType || "").trim().toLowerCase();
    const base = `/HRM/Asset/Vehicle/details/${vehicle}`;
    const segments = {
        "oil service": "oil-service",
        "tire change": "tire-change",
        "mechanical work": "mechanical-work",
        "body work": "body-work",
        "accident repair": "accident-repair",
    };
    const segment = segments[type];
    if (segment) {
        const built = `${base}/${segment}/${service}`;
        if (stored === built || stored.startsWith(`${built}?`)) return stored;
        const focusKey = String(focus || "").trim();
        return focusKey ? `${built}?focus=${encodeURIComponent(focusKey)}` : built;
    }
    if (type === "car wash") {
        return `${base}?tab=service&carWashServiceId=${encodeURIComponent(service)}`;
    }
    if (stored && stored.includes(`/service-requests/details/${vehicle}/${service}`)) return stored;
    if (type) return `/HRM/Asset/Vehicle/service-requests/details/${vehicle}/${service}`;
    return "";
}

function exactRecordPath(meta, requestId, stored) {
    const requestType = String(meta.requestType || "");
    const vehicleId = meta.vehicleId || meta.vehicleMongoId || requestId;
    const serviceId = meta.serviceRecordId || "";
    const serviceType = meta.serviceType || inferServiceType(requestType, meta.extra1, meta.extra2, stored);
    const servicePath = vehicleServicePath(vehicleId, serviceId, serviceType, stored, meta.focus);
    if (servicePath) return servicePath;

    const historyId = String(meta.historyId || "").trim();
    if (historyId && vehicleId && (meta.vehicleMongoId || meta.vehicleId || /handover|assign|inspection/i.test(requestType))) {
        const built = `/HRM/Asset/Vehicle/details/${vehicleId}/assign/${historyId}`;
        if (stored === built || stored.startsWith(`${built}?`)) return stored;
        return built;
    }

    if (meta.leaveDashboard || /leave request/i.test(requestType)) {
        const params = new URLSearchParams();
        if (meta.from) params.set("from", String(meta.from));
        if (meta.to) params.set("to", String(meta.to));
        if (meta.attendanceId) params.set("approvalId", String(meta.attendanceId));
        const query = params.toString();
        if (query) return `/HRM/Leave/annual-leave?${query}`;
    }

    if (/utility/i.test(`${requestType} ${stored}`)) {
        if (/[?&](batchId|statusChangeId)=/.test(stored) && !/\/details\//.test(stored)) return stored;
        const entryId = String(meta.entryId || "").trim();
        if (entryId) {
            const built = `/HRM/Asset/UtilityBills/details/${encodeURIComponent(entryId)}`;
            if (stored.startsWith(built)) return stored;
            return built;
        }
    }

    return "";
}

function queryHas(path, key) {
    return new RegExp(`[?&]${key}=`).test(String(path || ""));
}

function appendQuery(path, key, value) {
    if (!path || value == null || value === "") return path;
    if (queryHas(path, key)) return path;
    const [base, hash = ""] = String(path).split("#");
    const sep = base.includes("?") ? "&" : "?";
    const withQuery = `${base}${sep}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
    return hash ? `${withQuery}#${hash}` : withQuery;
}

function pathWithoutQuery(path) {
    return String(path || "").split("?")[0].split("#")[0];
}

function hasSectionFocus(path) {
    return /[?&](focusCard|focus|focusCertificate|focusAsset|focusFine|approvalId|blinkEmployee|billId|paymentId)=/i.test(
        String(path || ""),
    );
}

const OWNER_DOC_FOCUS_BY_KEY = {
    passport: "ownerPassport",
    emiratesId: "ownerEmiratesId",
    visitVisa: "ownerVisitVisa",
    employmentVisa: "ownerEmploymentVisa",
    spouseVisa: "ownerSpouseVisa",
    labourCard: "ownerLabourCard",
    medical: "ownerMedical",
    drivingLicense: "ownerDrivingLicense",
    visa: "ownerVisitVisa",
};

function companyFocusFromLabel(label = "") {
    const text = String(label || "").replace(/^Expiry follow-up required:\s*/i, "").replace(/\s*\(Exp:\s*[^)]+\)\s*$/i, "").trim();
    const l = text.toLowerCase();
    if (!l) return "";
    if (l.includes("trade license")) return "tradeLicense";
    if (l.includes("establishment")) return "establishmentCard";
    if (l.includes("ejari")) return "ejari";
    if (l.includes("moa")) return "moa";
    if (l.includes("passport")) return "ownerPassport";
    if (l.includes("emirates")) return "ownerEmiratesId";
    if (l.includes("visit visa")) return "ownerVisitVisa";
    if (l.includes("employment visa")) return "ownerEmploymentVisa";
    if (l.includes("spouse visa")) return "ownerSpouseVisa";
    if (l.includes("labour")) return "ownerLabourCard";
    if (l.includes("medical")) return "ownerMedical";
    if (l.includes("driving")) return "ownerDrivingLicense";
    if (l.includes("visa")) return "ownerVisitVisa";
    if (l.includes("basic detail")) return "basicDetails";
    return "";
}

function companyTabForFocus(focusCard, label = "") {
    const card = String(focusCard || "");
    if (card === "moa") return "moa";
    if (card.startsWith("owner")) return "owner";
    if (["tradeLicense", "establishmentCard", "ejari", "basicDetails"].includes(card)) return "basic";
    const l = String(label || "").toLowerCase();
    if (l.includes("certificate") || l.includes("memo") || l.includes("document")) return "others";
    return card ? "others" : "";
}

function vehicleFocusFromMeta(meta) {
    if (meta.focusCard) return String(meta.focusCard);
    if (meta.vehicleDocType) return resolveVehicleExpiryFocusCard(meta.vehicleDocType);
    const l = `${meta.extra1 || ""} ${meta.requestType || ""}`.toLowerCase();
    if (l.includes("insurance")) return "vehicleInsurance";
    if (l.includes("mulkia") || l.includes("registration")) return "vehicleRegistration";
    if (l.includes("warranty")) return "vehicleWarranty";
    if (l.includes("permit")) return "vehiclePermit";
    if (l.includes("petrol")) return "vehiclePetrol";
    if (l.includes("toll")) return "vehicleToll";
    if (l.includes("mortgage")) return "vehicleMortgage";
    if (l.includes("gear oil") || l.includes("oil service") || l.includes("service due")) return "vehicleService";
    if (l.includes("profile") || l.includes("activation") || l.includes("inspection")) return "pendingApproval";
    return "";
}

function vehicleTabForFocus(meta, focusCard) {
    if (meta.vehicleTab) return String(meta.vehicleTab);
    if (meta.vehicleDocType) return resolveVehicleExpiryTab(meta.vehicleDocType);
    if (focusCard === "vehiclePermit") return "permit";
    if (focusCard === "vehicleService") return "service";
    if (["vehiclePetrol", "vehicleToll", "vehicleMortgage"].includes(focusCard)) return "document";
    if (focusCard) return "basic";
    return "";
}

function assetFocusFromMeta(meta) {
    if (meta.focusCard) return String(meta.focusCard);
    const type = `${meta.requestType || ""} ${meta.extra1 || ""}`.toLowerCase();
    if (type.includes("assignment")) return "pendingAssignment";
    if (type.includes("accessory")) return "accessoryPending";
    if (type.includes("overdue") || type.includes("on leave") || type.includes("operational")) return "operationalExpiry";
    if (type.includes("loss") || type.includes("damage") || type.includes("disposition")) return "pendingAction";
    if (type.includes("approval") || type.includes("activation")) return "pendingApproval";
    return "";
}

function ensureEmployeeTab(path, focusCard) {
    if (!path || queryHas(path, "tab") || !focusCard) return path;
    const card = String(focusCard);
    if (["passport", "visa", "emirates-id", "labour-card", "medical-insurance", "driving-license", "basic-details"].includes(card)) {
        return appendQuery(path, "tab", "basic");
    }
    if (card.startsWith("doc-")) {
        return appendQuery(appendQuery(path, "tab", "documents"), "docStatusTab", "live");
    }
    if (card === "bank-details" || card === "salary") return appendQuery(path, "tab", "salary");
    if (card === "work-details" || card === "digital-signature") return appendQuery(path, "tab", "work-details");
    if (["personal-details", "permanent-address", "current-address", "emergency-contact"].includes(card)) {
        return appendQuery(path, "tab", "personal");
    }
    return path;
}

function focusCardFromPath(path) {
    const match = String(path || "").match(/[?&]focusCard=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : "";
}

/** Add the card/row focus query so Open section can scroll and blink that box. */
function applySectionFocus(path, meta, destination, requestId) {
    let out = String(path || "");
    if (!out || out.startsWith("/task-manager")) return out;

    const bare = pathWithoutQuery(out);
    if (/\/(oil-service|tire-change|mechanical-work|body-work|accident-repair|assign)\//.test(bare)) {
        if (!queryHas(out, "focus")) {
            const blob = `${meta.focus || ""} ${meta.extra1 || ""} ${meta.oilStage || ""}`.toLowerCase();
            const focus = /payment|accounts_payment/.test(blob) ? "payment" : (meta.focus || "record");
            out = appendQuery(out, "focus", focus);
        }
        return out;
    }

    if (!queryHas(out, "focusCard") && meta.focusCard) out = appendQuery(out, "focusCard", meta.focusCard);
    if (!queryHas(out, "tab") && meta.vehicleTab) out = appendQuery(out, "tab", meta.vehicleTab);
    if (!queryHas(out, "tab") && meta.tab) out = appendQuery(out, "tab", meta.tab);
    if (!queryHas(out, "ownerTab") && meta.ownerTabIndex != null && meta.ownerTabIndex !== "") {
        out = appendQuery(out, "ownerTab", meta.ownerTabIndex);
    }
    if (!queryHas(out, "focusCertificate") && meta.certificateDocumentId) {
        out = appendQuery(out, "focusCertificate", meta.certificateDocumentId);
    }
    if (!queryHas(out, "certSection") && meta.certificateSectionId) {
        out = appendQuery(out, "certSection", meta.certificateSectionId);
    }
    if (!queryHas(out, "billId") && meta.billId) out = appendQuery(out, "billId", meta.billId);
    if (!queryHas(out, "focusAsset") && meta.focusAsset) out = appendQuery(out, "focusAsset", meta.focusAsset);

    const label = `${meta.extra1 || ""} ${meta.extra2 || ""}`;

    if (/^\/HRM\/Asset\/Vehicle\/details\/[^/]+$/.test(bare) && !queryHas(out, "focusCard")) {
        const card = vehicleFocusFromMeta(meta);
        const tab = vehicleTabForFocus(meta, card);
        if (tab) out = appendQuery(out, "tab", tab);
        if (card) out = appendQuery(out, "focusCard", card);
    }

    if (/^\/HRM\/Asset\/details\/[^/]+$/.test(bare) && !queryHas(out, "focusCard")) {
        const card = assetFocusFromMeta(meta);
        if (card) {
            out = appendQuery(out, "focusCard", card);
            if (card.startsWith("accessory")) out = appendQuery(out, "tab", "accessories");
            else if (card === "operationalExpiry") out = appendQuery(out, "tab", meta.tab || "document");
        }
    }
    if (/^\/HRM\/Asset\/details\/[^/]+$/.test(bare) && !queryHas(out, "authAction")) {
        const type = `${meta.requestType || ""} ${meta.extra1 || ""}`.toLowerCase();
        if (type.includes("loss") || type.includes("damage")) out = appendQuery(out, "authAction", "damage");
        else if (type.includes("end of life")) out = appendQuery(out, "authAction", "eol");
        else if (type.includes("accessory")) out = appendQuery(out, "authAction", "accessory");
    }

    if (bare.startsWith("/Company/") && !queryHas(out, "focusCard") && !queryHas(out, "focusCertificate")) {
        const field = String(meta.ownerDocField || "").trim();
        const card = OWNER_DOC_FOCUS_BY_KEY[field] || companyFocusFromLabel(label);
        const tab = companyTabForFocus(card, label);
        if (tab) out = appendQuery(out, "tab", tab);
        if (card && card.startsWith("owner") && meta.ownerTabIndex != null && meta.ownerTabIndex !== "") {
            out = appendQuery(out, "ownerTab", meta.ownerTabIndex);
        }
        if (card) out = appendQuery(out, "focusCard", card);
        if (/certificate/i.test(label)) out = appendQuery(out, "docStatusTab", "certificate");
        else if (/memo/i.test(label)) out = appendQuery(out, "docStatusTab", "memo");
    }

    if (/^\/emp\//.test(bare) && !queryHas(out, "focusCard")) {
        const focused = buildEmployeePathWithFocus(out, meta.extra1 || label);
        if (focused) out = ensureEmployeeTab(focused, focusCardFromPath(focused));
    }

    if (!hasSectionFocus(out) && /^\/HRM\/Fine\/[^/]+$/.test(bare)) {
        out = appendQuery(out, "focusCard", "pendingApproval");
    }
    if (!hasSectionFocus(out) && /^\/HRM\/LoanAndAdvance\/[^/]+$/.test(bare)) {
        out = appendQuery(out, "focusCard", "record");
    }
    if (!hasSectionFocus(out) && bare.startsWith("/HRM/Reward/")) {
        out = appendQuery(out, "focusCard", "record");
    }
    if (!queryHas(out, "paymentId") && /\/Accounts\/Payments$/.test(bare)) {
        const paymentId = meta.paymentId || requestId;
        if (paymentId) out = appendQuery(out, "paymentId", paymentId);
    }

    return out;
}

/** Opens the exact record behind a task. Falls back to the module page when there is no record id. */
export function accessPathFor(destination, requestId, subjectEmployeeId, context = null) {
    const meta = parseTaskMeta(context);
    const stored = storedRecordPath(meta);
    const requestType = String(meta.requestType || "");
    const section =
        buildAttendanceSectionPath({ meta, requestId, requestType, subjectEmployeeId }) ||
        buildHubSectionPath({ meta, requestId, requestType }) ||
        buildUtilitySectionPath({ meta, requestId, requestType, stored }) ||
        buildAssetListSectionPath({ meta, requestId, requestType });
    if (section) return applySectionFocus(section, meta, destination, requestId);

    const exact = exactRecordPath(meta, requestId, stored);
    let path = "";
    if (exact) path = exact;
    else if (stored && /[a-f0-9]{24}|approvalId=|carWashServiceId=|billId=|focus=/i.test(stored)) path = stored;
    else {
        const id = String(requestId || "").trim();
        const employeeCode = String(subjectEmployeeId || "").trim();
        const moduleName = destination?.module || "";
        const base = destination?.path || "/task-manager";
        if (moduleName === "fine" && id) path = `/HRM/Fine/${id}`;
        else if (moduleName === "loan" && id) path = `/HRM/LoanAndAdvance/${id}`;
        else if (moduleName === "reward" && id) path = `/HRM/Reward/${id}`;
        else if (moduleName === "vehicle" && id) path = `/HRM/Asset/Vehicle/details/${id}`;
        else if (moduleName === "tools" && id) path = `/HRM/Asset/details/${id}`;
        else {
            const followUp = String(meta.extra1 || "");
            const expiryTask = /expiry/i.test(String(meta.requestType || "")) || /^expiry follow-up required:/i.test(followUp);
            if (expiryTask && (moduleName === "employees" || /employee/i.test(String(meta.requestType || "")))) {
                const fromLabel = String(meta.extra2 || "").match(/\(([^)]+)\)\s*$/);
                const code = (/^[a-f0-9]{24}$/i.test(employeeCode) ? "" : employeeCode) || fromLabel?.[1] || employeeCode;
                const sectionPath = buildEmployeeExpiryAccessPath(code, followUp);
                if (sectionPath) path = sectionPath;
            }
            const requestType = String(meta.requestType || "");
            if (!path && /^document expiry reminder$/i.test(requestType) && id) path = `/Company/${id}`;
            if (!path && moduleName === "employees" && employeeCode) path = buildEmployeeSectionPath(employeeCode, requestType);
            else if (!path && moduleName === "company" && id) path = buildCompanySectionPath(id, requestType);
            else if (!path && /salary/i.test(requestType) && meta.employeeId) {
                path = `/HRM/Salary/enroll/${encodeURIComponent(String(meta.employeeId))}`;
            } else if (!path && /salary/i.test(requestType) && meta.monthKey) {
                path = `/HRM/Salary/${encodeURIComponent(String(meta.monthKey))}`;
            } else if (!path && stored) path = stored;
            else if (!path) path = base;
        }
    }
    return applySectionFocus(path, meta, destination, requestId);
}

export async function resolveTaskViewer(req) {
    const superUser = await isReqUserSystemSuperUser(req.user);
    let employeeObjectId = req.user?.employeeObjectId ? String(req.user.employeeObjectId) : "";
    if (!employeeObjectId && req.user?.actor === "employee" && isObjectId(req.user.id)) {
        employeeObjectId = String(req.user.id);
    }
    if (!employeeObjectId && req.user?.employeeId) {
        const emp = await EmployeeBasic.findOne({ employeeId: req.user.employeeId }).select("_id").lean();
        if (emp?._id) employeeObjectId = String(emp._id);
    }
    return {
        superUser,
        name: String(req.user?.name || "").trim() || "User",
        employeeId: String(req.user?.employeeId || "").trim(),
        employeeObjectId,
        userId: String(req.user?.id || ""),
    };
}

export function viewerCanReassign(viewer, assigneeId, assigneeEmpId) {
    if (viewer?.superUser) return true;
    const assignee = String(assigneeId || "");
    if (assignee && viewer?.employeeObjectId && viewer.employeeObjectId === assignee) return true;
    if (assignee && viewer?.userId && viewer.userId === assignee) return true;
    if (
        assigneeEmpId &&
        viewer?.employeeId &&
        String(viewer.employeeId) === String(assigneeEmpId)
    ) {
        return true;
    }
    return false;
}

export async function loadPeopleDetails(ids = [], codes = []) {
    const objectIds = [...new Set(ids.map((id) => String(id || "")).filter(isObjectId))];
    const empCodes = [...new Set(codes.map((code) => String(code || "").trim()).filter(Boolean))];
    const or = [];
    if (objectIds.length) or.push({ _id: { $in: objectIds } });
    if (empCodes.length) or.push({ employeeId: { $in: empCodes } });
    const employees = or.length
        ? await EmployeeBasic.find({ $or: or })
              .select("firstName lastName employeeId designation department companyEmail workEmail profilePicture")
              .lean()
        : [];
    const contactKeys = [
        ...employees.map((emp) => String(emp._id)),
        ...employees.map((emp) => String(emp.employeeId || "")).filter(Boolean),
    ];
    const contacts = contactKeys.length
        ? await EmployeeContact.find({ employeeId: { $in: contactKeys } }).select("employeeId contactNumber").lean()
        : [];
    const phoneByKey = new Map(contacts.map((row) => [String(row.employeeId), row.contactNumber || ""]));
    return employees.map((emp) => ({
        ...emp,
        phone: phoneByKey.get(String(emp._id)) || phoneByKey.get(String(emp.employeeId || "")) || "",
    }));
}

export function peopleIndex(employees = []) {
    const byId = new Map();
    const byCode = new Map();
    for (const emp of employees) {
        byId.set(String(emp._id), emp);
        if (emp.employeeId) byCode.set(String(emp.employeeId), emp);
    }
    return { byId, byCode };
}

export function contactCard(emp) {
    if (!emp) {
        return { name: "", role: "", email: "", phone: "", photo: "", employeeId: "", id: "" };
    }
    return {
        id: String(emp._id || ""),
        name: personName(emp),
        role: emp.designation || "",
        email: emp.companyEmail || emp.workEmail || "",
        phone: emp.phone || "",
        photo: emp.profilePicture || "",
        employeeId: emp.employeeId || "",
    };
}

function mailTransport() {
    const emailUser = process.env.EMAIL_USER || process.env.VERP_EMAIL || process.env.GMAIL_USER;
    const emailPass = process.env.EMAIL_PASS || process.env.VERP_PASS || process.env.GMAIL_PASS;
    if (!emailUser || !emailPass) return null;
    const host =
        emailUser.includes("@gmail.com") || process.env.GMAIL_USER ? "smtp.gmail.com" : "smtp.office365.com";
    return {
        from: emailUser,
        transporter: nodemailer.createTransport({
            host,
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        }),
    };
}

export function reassignedRequesterLabel(requesterName, originalAssigneeName) {
    const strip = (value) => String(value || "").trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
    const requester = strip(requesterName);
    const original = strip(originalAssigneeName);
    if (!original) return requester;
    if (!requester || requester.toLowerCase() === original.toLowerCase()) return original;
    return `${original} (${requester})`;
}

export function taskOpenPath(taskKey) {
    const key = String(taskKey || "").trim();
    if (!key) return "/task-manager";
    return `/task-manager/${encodeURIComponent(key)}`;
}

function plainCloseRequest(task) {
    if (!task?.closeRequest) return {};
    return task.closeRequest.toObject ? task.closeRequest.toObject() : { ...task.closeRequest };
}

export async function publishReassignmentNotices(task, {
    watchers = [],
    reassigneeName,
    newAssigneeId,
    taskName,
    moduleName,
    taskKey,
    noticeText = "",
} = {}) {
    if (!task) return;
    const saved = plainCloseRequest(task);
    const notices = new Map();
    for (const row of saved.reassignmentNotices || []) {
        const id = String(row?.employeeId || "");
        if (!isObjectId(id)) continue;
        notices.set(id, {
            employeeId: row.employeeId,
            empId: row.empId || "",
            requestId: row.requestId,
        });
    }
    for (const person of watchers) {
        const id = String(person?.employeeId || "");
        if (!isObjectId(id) || id === String(newAssigneeId || "")) continue;
        const existing = notices.get(id);
        if (!existing) {
            notices.set(id, {
                employeeId: person.employeeId,
                empId: person.empId || "",
                requestId: new mongoose.Types.ObjectId(),
            });
        } else if (person.empId && !existing.empId) {
            existing.empId = person.empId;
        }
    }

    const path = taskOpenPath(taskKey);
    const messageName = String(reassigneeName || "").trim() || "another employee";
    const label = String(noticeText || "").trim();
    const extra3 = JSON.stringify({
        taskManager: true,
        reassignedNotice: true,
        module: String(moduleName || "general"),
        path,
        taskPath: path,
        taskKey: String(taskKey || ""),
        taskManagerId: String(task._id || ""),
        reassignedToName: label ? "" : messageName,
    });
    const nextNotices = [];
    for (const [id, row] of notices) {
        if (!isObjectId(row.requestId)) row.requestId = new mongoose.Types.ObjectId();
        if (id === String(newAssigneeId || "")) {
            await DashboardAction.updateMany(
                { requestId: row.requestId, requestType: "Task Manager" },
                { status: "Dismissed", actionedDate: new Date() },
            );
            continue;
        }
        await DashboardAction.findOneAndUpdate(
            { requestId: row.requestId, requestType: "Task Manager" },
            {
                assignedTo: row.employeeId,
                assignedToEmpId: row.empId || "",
                requestId: row.requestId,
                requestType: "Task Manager",
                status: "Pending",
                subjectEmployeeId: row.empId || "",
                subjectName: "",
                requestedByName: "Task Manager",
                requestedDate: new Date(),
                extra1: taskName || "Task",
                extra2: label || `Reassigned to: ${messageName}`,
                extra3,
                actionedDate: null,
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        nextNotices.push({
            employeeId: row.employeeId,
            empId: row.empId || "",
            requestId: row.requestId,
        });
    }

    task.closeRequest = {
        ...saved,
        reassignmentNotices: nextNotices,
    };
    task.markModified("closeRequest");
    await task.save();
}

export async function upsertTaskNotice(task, {
    employeeId,
    empId = "",
    taskName,
    moduleName,
    taskKey,
    noticeText,
} = {}) {
    if (!task || !isObjectId(employeeId)) return;
    const saved = plainCloseRequest(task);
    const notices = (saved.reassignmentNotices || []).map((row) => ({
        employeeId: row.employeeId,
        empId: row.empId || "",
        requestId: row.requestId,
    }));
    let row = notices.find((item) => String(item.employeeId || "") === String(employeeId));
    if (!row) {
        row = {
            employeeId,
            empId: empId || "",
            requestId: new mongoose.Types.ObjectId(),
        };
        notices.push(row);
    } else if (empId && !row.empId) {
        row.empId = empId;
    }
    if (!isObjectId(row.requestId)) row.requestId = new mongoose.Types.ObjectId();
    const path = taskOpenPath(taskKey);
    await DashboardAction.findOneAndUpdate(
        { requestId: row.requestId, requestType: "Task Manager" },
        {
            assignedTo: employeeId,
            assignedToEmpId: row.empId || "",
            requestId: row.requestId,
            requestType: "Task Manager",
            status: "Pending",
            subjectEmployeeId: row.empId || "",
            subjectName: "",
            requestedByName: "Task Manager",
            requestedDate: new Date(),
            extra1: taskName || "Task",
            extra2: String(noticeText || "").trim() || "Task update",
            extra3: JSON.stringify({
                taskManager: true,
                reassignedNotice: true,
                module: String(moduleName || "general"),
                path,
                taskPath: path,
                taskKey: String(taskKey || ""),
                taskManagerId: String(task._id || ""),
                reassignedToName: "",
            }),
            actionedDate: null,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    task.closeRequest = {
        ...saved,
        reassignmentNotices: notices,
    };
    task.markModified("closeRequest");
    await task.save();
}

export async function promoteDueTaskCompletions() {
    const due = await TaskManagerTask.find({
        status: { $nin: ["Completed", "Cancelled"] },
        "closeRequest.completesAt": { $lte: new Date() },
    }).limit(100);
    for (const task of due) {
        const when = task.closeRequest?.completesAt ? new Date(task.closeRequest.completesAt) : null;
        if (!when || Number.isNaN(when.getTime()) || when.getTime() > Date.now()) continue;
        task.status = "Completed";
        task.history = task.history || [];
        task.history.push({
            event: "Completed",
            detail: "Two days passed after the assignee closed this task. The status is Completed and Reopen Request is disabled.",
            actorName: "Task Manager",
            createdAt: new Date(),
        });
        task.updates = task.updates || [];
        task.updates.push({
            authorName: "Task Manager",
            authorRole: "",
            kind: "Completed",
            badge: "Completed",
            text: "Two days passed after the close. The status is Completed and Reopen Request is disabled.",
            emailSent: false,
            assigneeNotified: false,
            requesterNotified: false,
            assigneeName: "",
            requesterName: "",
            createdAt: new Date(),
        });
        await task.save();
        await closeReassignmentNotices(task);
        if (!task.sourceDashboardActionId) await syncManualTaskNotification(task);
    }
}

export async function closeReassignmentNotices(task) {
    const ids = (plainCloseRequest(task).reassignmentNotices || [])
        .map((row) => row?.requestId)
        .filter((id) => isObjectId(id));
    if (!ids.length) return;
    await DashboardAction.updateMany(
        { requestId: { $in: ids }, requestType: "Task Manager", status: "Pending" },
        { status: "Dismissed", actionedDate: new Date() },
    );
}

export async function deleteReassignmentNotices(task) {
    const ids = (plainCloseRequest(task).reassignmentNotices || [])
        .map((row) => row?.requestId)
        .filter((id) => isObjectId(id));
    if (!ids.length) return;
    await DashboardAction.deleteMany({ requestId: { $in: ids }, requestType: "Task Manager" });
}

export async function sendTaskReassignedEmail({ toEmp, taskName, taskNumber, reason, modulePath, taskPath = "", requesterName, recordId = "" }) {
    const mail = mailTransport();
    const resolved = await resolveEmployeeEmailWithReporteeLoaded(toEmp);
    const to = resolved?.email;
    if (!mail || !to) return { sent: false };
    const base = emailFrontendUrl();
    const path = taskPath || modulePath || "/task-manager";
    const link = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? path : `/${path}`}`;
    const escapeHtml = (value) =>
        String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    const who = escapeHtml(personName(toEmp) || "there");
    const subject = `Task reassigned to you: ${taskName || taskNumber || "Task"}`;
    const html = `
            <p>Hello ${who},</p>
            <p>This task has been reassigned to you.</p>
            <p><strong>${escapeHtml(taskNumber || "Task")}</strong> — ${escapeHtml(taskName || "Task")}</p>
            ${reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ""}
            ${requesterName ? `<p><strong>Requested by:</strong> ${escapeHtml(requesterName)}</p>` : ""}
            <p><a href="${escapeHtml(link)}">Open Task</a></p>
        `;
    await mail.transporter.sendMail({
        from: mail.from,
        to,
        subject,
        html,
    });
    if (recordId) {
        await rememberSentEmail({
            from: mail.from,
            to: [to],
            subject,
            html,
            recordId,
            module: "Task Manager",
            emailType: "Task reassigned",
        });
    }
    return { sent: true, to };
}

export async function sendTaskActivityEmail({ to = [], subject, html, recordId = "", emailType = "Task update" }) {
    const mail = mailTransport();
    const recipients = [...new Set(to.map((item) => String(item || "").trim()).filter(Boolean))];
    if (!mail || !recipients.length) return { sent: false, to: [] };
    const mailSubject = subject || "Task update";
    await mail.transporter.sendMail({
        from: mail.from,
        to: recipients.join(", "),
        subject: mailSubject,
        html,
    });
    if (recordId) {
        await rememberSentEmail({
            from: mail.from,
            to: recipients,
            subject: mailSubject,
            html,
            recordId,
            module: "Task Manager",
            emailType,
        });
    }
    return { sent: true, to: recipients };
}

export async function loadTaskManagerInboxItems(assigneeClauses, moduleName) {
    const moduleKey = String(moduleName || "").trim();
    if (!Array.isArray(assigneeClauses) || !assigneeClauses.length || !moduleKey) return [];
    const rows = await DashboardAction.find({
        status: "Pending",
        requestType: "Task Manager",
        extra3: new RegExp(`"module":"${moduleKey}"`),
        $or: assigneeClauses,
    })
        .sort({ requestedDate: -1 })
        .limit(50)
        .lean();
    return rows.map((da) => ({
        dashboardActionId: da._id,
        requestType: da.requestType,
        requestedDate: da.requestedDate,
        requestedByName: da.requestedByName,
        subjectName: da.subjectName,
        extra1: da.extra1,
        extra2: da.extra2,
        extra3: da.extra3,
        requestObjectId: da.requestId,
        primaryAssetId: "",
        asset: null,
    }));
}

export async function syncManualTaskNotification(task) {
    if (!task?._id || !task.assignee) return null;
    const destination = moduleForText(task.taskName, task.description, task.taskType, task.requestType);
    const closed = task.status === "Completed" || task.status === "Cancelled";
    const extra3 = JSON.stringify({
        taskManager: true,
        module: destination.module,
        path: destination.path,
        taskManagerId: String(task._id),
    });
    return DashboardAction.findOneAndUpdate(
        { requestId: task._id, requestType: "Task Manager" },
        {
            assignedTo: task.assignee,
            assignedToEmpId: task.assigneeEmpId || "",
            requestId: task._id,
            requestType: "Task Manager",
            status: closed ? (task.status === "Cancelled" ? "Dismissed" : "Approved") : "Pending",
            subjectEmployeeId: task.assigneeEmpId || "",
            subjectName: task.assigneeName || "",
            requestedByName: task.requestedByName || "",
            requestedDate: task.createdAt || new Date(),
            extra1: task.taskName || "Task",
            extra2: task.description || "",
            extra3,
            actionedDate: closed ? new Date() : null,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}
