import AssetItem from "../models/AssetItem.js";
import AttendanceChangeRequest from "../models/AttendanceChangeRequest.js";
import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import Fine from "../models/Fine.js";
import Loan from "../models/Loan.js";
import Payment from "../models/Payment.js";
import Reward from "../models/Reward.js";
import UtilityBillPayment from "../models/UtilityBillPayment.js";
import {
    buildDocumentsArrayExpiryLabel,
    buildEmployeeManualDocumentExpiryLabel,
    collectCompanyExpiryDocuments,
    isArchivedOrStaleCompanyExpiryRow,
} from "./companyExpiryScanUtils.js";
import { buildEmployeeDocumentMap } from "./processDocumentExpiryReminders.js";
import {
    buildVehicleExpiryDocumentLabel,
    isVehicleDocumentArchived,
} from "./vehicleExpiryScanUtils.js";
import { loadCompaniesForExpiryScanByIds } from "../services/companyPartitionService.js";
import { accessPathFor, isObjectId, moduleForRequestType } from "./taskManagerModule.js";
import { documentTaskLabel } from "./taskDuplicateKey.js";
import {
    OLD_EXPIRY_STILL_SAME_MESSAGE,
    SOURCE_STILL_PENDING_MESSAGE,
    combineSourceStatus,
    expiryFollowUpState,
    isDocumentExpiryRequest,
    serviceStageState,
    sourceGateApplies,
} from "./sourceTaskCompletionRules.js";

const EMPTY = {
    applies: false,
    pending: false,
    status: "",
    link: "",
    message: "",
};

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

function reminderText(action, task) {
    return [action?.extra1, task?.taskName, task?.description]
        .map((value) => String(value || "").trim())
        .find((value) => value) || "";
}

function sourceLink(action, task) {
    if (!action) return "";
    const destination = moduleForRequestType(
        action.requestType,
        `${action.extra1 || ""} ${action.extra2 || ""} ${task?.taskName || ""}`,
    );
    return accessPathFor(destination, action.requestId, action.subjectEmployeeId, {
        extra1: action.extra1 || task?.taskName || "",
        extra2: action.extra2 || task?.description || "",
        extra3: action.extra3,
        requestType: action.requestType,
    }) || "";
}

async function resolveAction(target, explicit) {
    if (explicit && explicit.requestType && explicit.requestType !== "Task Manager") return explicit;
    if (target?.action && target.action.requestType !== "Task Manager") return target.action;
    const storedId = target?.task?.sourceDashboardActionId;
    if (!isObjectId(storedId)) return null;
    const found = await DashboardAction.findById(storedId).lean();
    if (!found || found.requestType === "Task Manager") return null;
    return found;
}

function notRenewedRow(row) {
    const text = `${row?.archiveReason || ""} ${row?.description || ""}`.toLowerCase();
    return text.includes("not renew");
}

function vehicleDescriptionMeta(doc) {
    if (!doc?.description) return {};
    try {
        const parsed = JSON.parse(doc.description);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function splitVehicleExpiryDocs(asset) {
    const live = [];
    const old = [];
    for (const doc of asset?.documents || []) {
        if (!doc?.expiryDate) continue;
        const label = buildVehicleExpiryDocumentLabel(doc);
        if (!label) continue;
        const meta = vehicleDescriptionMeta(doc);
        const row = {
            label,
            expiryDate: doc.expiryDate,
            notRenewed: Boolean(meta.notRenewed) || notRenewedRow(meta),
        };
        if (isVehicleDocumentArchived(doc)) old.push(row);
        else live.push(row);
    }
    return { live, old };
}

function companyOldExpiryDocs(company) {
    const old = [];
    const push = (row, label) => {
        if (!row?.expiryDate || !label) return;
        old.push({
            label,
            expiryDate: row.expiryDate,
            notRenewed: notRenewedRow(row),
        });
    };
    for (const row of company?.oldDocuments || []) {
        push(row, row.type || row.documentName || "");
    }
    for (const row of company?.documents || []) {
        if (!isArchivedOrStaleCompanyExpiryRow(row)) continue;
        push(row, buildDocumentsArrayExpiryLabel(row));
    }
    for (const row of company?.ejari || []) {
        if (!isArchivedOrStaleCompanyExpiryRow(row)) continue;
        push(row, row?.type ? `Ejari — ${row.type}` : "Ejari");
    }
    for (const row of company?.insurance || []) {
        if (!isArchivedOrStaleCompanyExpiryRow(row)) continue;
        push(row, row?.type ? `Insurance — ${row.type}` : "Insurance");
    }
    return old;
}

async function employeeExpiryDocs(employee) {
    const code = String(employee?.employeeId || "").trim();
    const mapped = code ? await buildEmployeeDocumentMap([code]) : new Map();
    const live = [...(mapped.get(code) || [])];
    for (const row of employee?.documents || []) {
        if (!row?.expiryDate || isArchivedOrStaleCompanyExpiryRow(row)) continue;
        live.push({
            label: buildEmployeeManualDocumentExpiryLabel(row),
            expiryDate: row.expiryDate,
        });
    }
    if (employee?.contractExpiryDate) {
        live.push({ label: "Contract Expiry", expiryDate: employee.contractExpiryDate });
    }
    const old = [];
    for (const row of employee?.oldDocuments || []) {
        if (!row?.expiryDate) continue;
        old.push({
            label: row.documentName && row.type ? `${row.type} — ${row.documentName}` : (row.type || row.documentName || ""),
            expiryDate: row.expiryDate,
            notRenewed: notRenewedRow(row),
        });
    }
    return { live, old };
}

async function loadExpiryDocs(action) {
    const type = String(action?.requestType || "");
    const id = String(action?.requestId || "").trim();
    if (!isObjectId(id)) return null;
    if (/vehicle/i.test(type)) {
        const asset = await AssetItem.findById(id)
            .select("documents")
            .lean();
        if (!asset) return null;
        return splitVehicleExpiryDocs(asset);
    }
    if (/^document expiry reminder$/i.test(type) || /company document expiry/i.test(type)) {
        const rows = await loadCompaniesForExpiryScanByIds([id]);
        if (!rows.length) return null;
        return {
            live: collectCompanyExpiryDocuments(rows[0]),
            old: companyOldExpiryDocs(rows[0]),
        };
    }
    const employee = await EmployeeBasic.findById(id)
        .select("employeeId documents contractExpiryDate oldDocuments")
        .lean();
    if (!employee) return null;
    return employeeExpiryDocs(employee);
}

async function loadServiceState(action) {
    const id = String(action?.requestId || "").trim();
    if (!isObjectId(id)) return "Pending";
    const asset = await AssetItem.findById(id)
        .select("services._id services.workflowSnapshot.stage activeServiceWorkflow.stage")
        .lean();
    if (!asset) return "Pending";
    const meta = readMeta(action.extra3);
    const serviceId = String(meta.serviceRecordId || "").trim();
    const service = (asset.services || []).find((row) => String(row?._id || "") === serviceId);
    const stage = service?.workflowSnapshot?.stage || asset.activeServiceWorkflow?.stage || "";
    if (serviceId && !service) return "Pending";
    return serviceStageState(stage);
}

async function notRenewStatus(action) {
    const id = String(action?.requestId || "").trim();
    if (!isObjectId(id)) return "";
    const employee = await EmployeeBasic.findById(id).select("pendingNotRenewRequests").lean();
    if (!employee) return "";
    const meta = readMeta(action.extra3);
    const label = documentTaskLabel(action.extra1 || meta.label || "");
    const rows = employee.pendingNotRenewRequests || [];
    const match = rows.find((row) => {
        if (meta.requestId && String(row.requestId || "") === String(meta.requestId)) return true;
        if (!label) return false;
        return documentTaskLabel(row.label) === label;
    });
    return match?.status || "";
}

async function attendanceStage(action) {
    const id = String(action?.requestId || "").trim();
    if (!isObjectId(id)) return "";
    const direct = await AttendanceChangeRequest.findById(id).select("stage").lean();
    if (direct?.stage) return direct.stage;
    const related = await AttendanceChangeRequest.findOne({
        "proposed.attendanceId": id,
        stage: { $ne: "superseded" },
    }).sort({ updatedAt: -1 }).select("stage").lean();
    return related?.stage || "";
}

async function loadRecordStatus(action) {
    const type = String(action?.requestType || "");
    const id = String(action?.requestId || "").trim();
    if (/not renew/i.test(type)) return notRenewStatus(action);
    if (/attendance change/i.test(type)) return attendanceStage(action);
    if (!isObjectId(id) && type !== "Utility Bill Payment" && type !== "Utility Bill Payment Reminder") {
        return "";
    }
    if (type === "Fine" || type === "Group Fine Request") {
        const fine = await Fine.findById(id).select("fineStatus").lean();
        return fine?.fineStatus || "";
    }
    if (type === "Loan" || type === "Employee Loan Request" || type === "Employee Advance Request" || type === "Advance") {
        const loan = await Loan.findById(id).select("status").lean();
        return loan?.status || "";
    }
    if (type === "Reward") {
        const reward = await Reward.findById(id).select("rewardStatus").lean();
        return reward?.rewardStatus || "";
    }
    if (type === "Payment Approval") {
        const payment = await Payment.findById(id).select("status").lean();
        return payment?.status || "";
    }
    if (type === "Utility Bill Payment" || type === "Utility Bill Payment Reminder") {
        const bill = id ? await UtilityBillPayment.findById(id).select("status").lean() : null;
        return bill?.status || "";
    }
    return "";
}

async function resolveStatus(action, task) {
    const type = String(action?.requestType || "");
    const reminder = reminderText(action, task);
    if (isDocumentExpiryRequest(type, reminder)) {
        const docs = await loadExpiryDocs(action);
        if (!docs) return "Pending";
        return expiryFollowUpState({
            reminderText: reminder,
            liveDocs: docs.live,
            oldDocs: docs.old,
        });
    }
    if (type === "Vehicle Service Request") return loadServiceState(action);
    const recordStatus = await loadRecordStatus(action);
    return combineSourceStatus(recordStatus, action?.status);
}

export async function evaluateSourceTaskCompletion(target, { category = "", action = null } = {}) {
    try {
        const task = target?.task || null;
        const source = await resolveAction(target, action);
        if (!sourceGateApplies(task, source, category)) return { ...EMPTY };
        const link = sourceLink(source, task);
        const status = await resolveStatus(source, task);
        const pending = status === "Pending";
        const documentExpiry = isDocumentExpiryRequest(source.requestType, reminderText(source, task));
        return {
            applies: true,
            pending,
            status,
            link,
            message: pending
                ? (documentExpiry ? OLD_EXPIRY_STILL_SAME_MESSAGE : SOURCE_STILL_PENDING_MESSAGE)
                : "",
        };
    } catch (error) {
        console.error("Source task check:", error?.message || error);
        const task = target?.task || null;
        const source = action || target?.action || null;
        const documentExpiry = isDocumentExpiryRequest(source?.requestType, reminderText(source, task));
        return {
            applies: true,
            pending: true,
            status: "Pending",
            link: source ? sourceLink(source, task) : "",
            message: documentExpiry ? OLD_EXPIRY_STILL_SAME_MESSAGE : SOURCE_STILL_PENDING_MESSAGE,
        };
    }
}
