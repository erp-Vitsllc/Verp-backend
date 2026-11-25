import mongoose from 'mongoose';
import WorkOrder from '../models/WorkOrder.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Flowchart from '../models/Flowchart.js';
import CrmCustomer from '../models/crm/CrmCustomer.js';
import InventoryVendor from '../models/inventory/InventoryVendor.js';
import { dubaiDateKey, formatWorkOrderNo, nextSequenceForYear, workOrderYear } from '../utils/workOrderNumber.js';
import {
    coordinatorFollowUpNotice,
    lpoAttachmentNotice,
    lpoNotFilledNotice,
    salespersonFollowUpNotice,
    sendWorkOrderAttachmentRequestEmail,
    sendWorkOrderFollowUpEmail,
    sendWorkOrderLpoNotFilledEmail,
} from '../utils/sendWorkOrderLpoEmail.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import DashboardAction from '../models/DashboardAction.js';
import TaskManagerTask from '../models/TaskManagerTask.js';
import { finishEmployeeWorkflowTasks } from '../utils/employeeWorkflowTask.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';
import { fetchZohoEstimateByNumber, fetchZohoEstimatePdf } from '../services/zohoService.js';
import {
    applyQuotationSnapshot,
    quotationChanges,
    savedQuotation,
    snapshotFromEstimate,
} from '../utils/workOrderQuotationSync.js';
import { buildActualBoq } from '../utils/workOrderActualBoq.js';
import { findPurchaseOfficer } from './inventory/stockApproval.js';

const TYPES = new Set(['Standalone', 'Main WO', 'Variation']);
const STATUSES = new Set(['Draft', 'Not Started', 'Awaiting LPO', 'LPO Pending', 'Created', 'In Progress', 'Fully Invoiced', 'Completed']);
const LPO_MODES = new Set(['required', 'not_required', 'received']);
const ATTACHMENT_EXT = /\.(pdf|png|jpe?g|webp|gif|docx?|xlsx?|txt|csv)$/i;
const ATTACHMENT_MIME = new Set([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
]);

function cleanText(value, max) {
    return String(value ?? '')
        .replace(/<[^>]*>/g, '')
        .trim()
        .slice(0, max);
}

function samePartyName(left, right) {
    const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const a = normalize(left);
    const b = normalize(right);
    return Boolean(a) && a === b;
}

async function resolveCrmCustomer(customerId, customerName) {
    const id = cleanText(customerId, 40);
    if (mongoose.isValidObjectId(id)) {
        const byId = await CrmCustomer.findById(id).select('name').lean();
        if (byId?.name) return { id: String(byId._id), name: cleanText(byId.name, 160) };
    }
    const name = cleanText(customerName, 160);
    if (!name) return null;
    const rows = await CrmCustomer.find().select('name').lean();
    const match = rows.find((row) => samePartyName(row.name, name));
    if (!match?.name) return null;
    return { id: String(match._id), name: cleanText(match.name, 160) };
}

async function resolveInventoryVendor(vendorId) {
    const id = cleanText(vendorId, 40);
    if (!id) return { id: '', name: '' };
    if (!mongoose.isValidObjectId(id)) return null;
    const vendor = await InventoryVendor.findById(id).select('name').lean();
    if (!vendor?.name) return null;
    return { id: String(vendor._id), name: cleanText(vendor.name, 160) };
}

function cleanMoney(value) {
    if (value === '' || value === null || value === undefined) return 0;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) return null;
    return Math.round(amount * 100) / 100;
}

function readAttachment(file, { required = false } = {}) {
    if (!file || typeof file !== 'object') {
        return required ? { error: 'Attachment is required' } : null;
    }
    const name = cleanText(file.name, 180).replace(/[/\\]/g, '');
    const mime = cleanText(file.mime, 120) || 'application/octet-stream';
    const raw = String(file.data || '');
    const payload = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1).replace(/\s/g, '') : raw.replace(/\s/g, '');
    if (!name || !payload) {
        return required ? { error: 'Attachment is required' } : null;
    }
    if (!ATTACHMENT_EXT.test(name) && !ATTACHMENT_MIME.has(mime)) {
        return { error: 'Attach a PDF, image, Word, or Excel file' };
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(payload)) {
        return { error: 'Attachment could not be read' };
    }
    const buffer = Buffer.from(payload, 'base64');
    if (!buffer.length || buffer.length > 4 * 1024 * 1024) {
        return { error: 'Attachment must be 4 MB or smaller' };
    }
    return { name, mime, data: payload, bytes: buffer.length, buffer };
}

async function closeLpoNotFilledNotice(order) {
    if (!order?._id) return;
    try {
        await DashboardAction.updateMany(
            { requestId: order._id, requestType: 'Work Order LPO', status: 'Pending' },
            { $set: { status: 'Dismissed', actionedDate: new Date(), comment: 'LPO notice closed' } },
        );
    } catch (error) {
        console.error('Could not close the LPO notification:', error);
    }
}

const ATTACHMENT_REQUEST = 'Work Order LPO Attachment';
const ACTUAL_BOQ_REQUEST = 'Work Order Actual BOQ';
const MATERIAL_REQUEST = 'Work Order MR';

function actorKeys(req) {
    return [
        req.user?.id,
        req.user?._id,
        req.user?.employeeId,
        req.user?.employeeObjectId,
    ].filter(Boolean).map(String);
}

function actorMatches(req, ids) {
    const keys = new Set(actorKeys(req));
    return (ids || []).some((id) => keys.has(String(id)));
}

async function isProjectCoordinator(req) {
    const coordinator = await findProjectCoordinator();
    if (!coordinator) return false;
    return actorMatches(req, [coordinator._id, coordinator.employeeId]);
}

async function loadQuotationEstimate(number) {
    return fetchZohoEstimateByNumber(number, { allowClosed: true });
}

async function captureQuotationFile({ estimateId = '', number = '' } = {}) {
    const quoteNumber = String(number || '').trim();
    const quoteId = String(estimateId || '').trim();
    if (!quoteNumber && !quoteId) return null;
    const { buffer, filename } = await fetchZohoEstimatePdf({ estimateId: quoteId, number: quoteNumber });
    if (!buffer?.length || buffer.length > 12 * 1024 * 1024) return null;
    return {
        name: filename || `Quotation-${quoteNumber || quoteId}.pdf`,
        mime: 'application/pdf',
        data: buffer.toString('base64'),
        bytes: buffer.length,
    };
}

const WORK_ORDER_FLOWCHART_ROLES = [
    { category: 'projectcoordinator', label: 'Project Coordinator' },
    { category: 'projectmanager', label: 'Project Manager' },
    { category: 'logisticcontroller', label: 'Logistic Controller' },
];

function flowchartRoleMessage(labels) {
    const names = labels.filter(Boolean);
    const list = names.length <= 1
        ? (names[0] || 'the required roles')
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `Assign an active ${list} on the flowchart before creating a work order.`;
}

async function missingWorkOrderFlowchartRoles() {
    const rows = await Flowchart.find({
        category: { $in: WORK_ORDER_FLOWCHART_ROLES.map((role) => role.category) },
    }).select('category status').lean();
    const statusByCategory = new Map();
    for (const row of rows) {
        if (row.status === 'Active' || !statusByCategory.has(row.category)) {
            statusByCategory.set(row.category, row.status);
        }
    }
    return WORK_ORDER_FLOWCHART_ROLES
        .filter((role) => statusByCategory.get(role.category) !== 'Active')
        .map((role) => ({
            ...role,
            label: statusByCategory.get(role.category) === 'Pending'
                ? `${role.label} (pending approval)`
                : role.label,
        }));
}

async function findProjectCoordinator() {
    const row = await Flowchart.findOne({ category: 'projectcoordinator', status: 'Active' })
        .sort({ updatedAt: -1 })
        .select('empObjectId employeeId employeeName companyEmail')
        .lean();
    if (!row) return null;
    let employee = null;
    if (row.empObjectId && mongoose.Types.ObjectId.isValid(String(row.empObjectId))) {
        employee = await EmployeeBasic.findById(row.empObjectId)
            .select('firstName lastName companyEmail workEmail status profileStatus employeeId primaryReportee')
            .populate('primaryReportee', 'companyEmail workEmail status profileStatus')
            .lean();
    }
    if (!employee && row.employeeId) {
        employee = await EmployeeBasic.findOne({ employeeId: row.employeeId })
            .select('firstName lastName companyEmail workEmail status profileStatus employeeId primaryReportee')
            .populate('primaryReportee', 'companyEmail workEmail status profileStatus')
            .lean();
    }
    return employee;
}

async function projectCoordinatorName() {
    const row = await Flowchart.findOne({ category: 'projectcoordinator', status: 'Active' })
        .sort({ updatedAt: -1 })
        .select('employeeName')
        .lean();
    const fromChart = String(row?.employeeName || '').trim();
    if (fromChart) return fromChart;
    const coordinator = await findProjectCoordinator();
    return [coordinator?.firstName, coordinator?.lastName].filter(Boolean).join(' ').trim();
}

async function findProjectManager() {
    const row = await Flowchart.findOne({ category: 'projectmanager', status: 'Active' })
        .sort({ updatedAt: -1 })
        .select('empObjectId employeeId employeeName')
        .lean();
    if (!row) return null;
    let employee = null;
    if (row.empObjectId && mongoose.Types.ObjectId.isValid(String(row.empObjectId))) {
        employee = await EmployeeBasic.findById(row.empObjectId)
            .select('firstName lastName companyEmail workEmail status profileStatus employeeId primaryReportee')
            .populate('primaryReportee', 'companyEmail workEmail status profileStatus')
            .lean();
    }
    if (!employee && row.employeeId) {
        employee = await EmployeeBasic.findOne({ employeeId: row.employeeId })
            .select('firstName lastName companyEmail workEmail status profileStatus employeeId primaryReportee')
            .populate('primaryReportee', 'companyEmail workEmail status profileStatus')
            .lean();
    }
    return employee;
}

async function projectManagerName() {
    const row = await Flowchart.findOne({ category: 'projectmanager', status: 'Active' })
        .sort({ updatedAt: -1 })
        .select('employeeName')
        .lean();
    const fromChart = String(row?.employeeName || '').trim();
    if (fromChart) return fromChart;
    const manager = await findProjectManager();
    return [manager?.firstName, manager?.lastName].filter(Boolean).join(' ').trim();
}

async function isProjectManager(req) {
    const manager = await findProjectManager();
    if (!manager) return false;
    return actorMatches(req, [manager._id, manager.employeeId]);
}

async function closeAttachmentRequest(order, actorName) {
    if (!order?._id) return;
    try {
        await DashboardAction.updateMany(
            { requestId: order._id, requestType: ATTACHMENT_REQUEST, status: 'Pending' },
            { $set: { status: 'Dismissed', actionedDate: new Date(), comment: 'Attachment uploaded' } },
        );
        await finishEmployeeWorkflowTasks(order._id, ATTACHMENT_REQUEST, {
            detail: 'Attachment uploaded.',
            actorName: actorName || 'Employee',
        });
    } catch (error) {
        console.error('Could not close the attachment request:', error);
    }
}

async function openAttachmentRequest(order, senderName) {
    const copy = lpoAttachmentNotice(order.workOrderNo);
    const coordinator = await findProjectCoordinator();
    order.attachmentPending = true;
    order.lpoAlert = {
        active: true,
        kind: 'attachment',
        message: copy.message,
        sentAt: new Date(),
        sentByName: senderName || '',
        sentById: '',
        attachmentName: '',
        attachmentMime: '',
        attachmentData: '',
        attachmentBytes: 0,
        emailed: false,
        emailTo: '',
        forEmployeeIds: coordinator
            ? [String(coordinator._id), String(coordinator.employeeId || '')].filter(Boolean)
            : [],
    };
    let emailed = false;
    let email = '';
    let message = coordinator
        ? copy.message
        : 'Work order created. No active Project Coordinator is set on the flowchart, so the upload notice was not sent.';
    if (coordinator?._id) {
        await syncDashboardAction({
            requestId: order._id,
            requestType: ATTACHMENT_REQUEST,
            assignedTo: coordinator._id,
            status: 'Pending',
            subjectName: order.customer || '',
            requestedByName: senderName || '',
            extra1: copy.extra1,
            extra2: copy.extra2,
            extra3: JSON.stringify({
                path: `/production/work-order?workOrder=${order._id}&section=lpo`,
            }),
        });
        try {
            const notice = await sendWorkOrderAttachmentRequestEmail({
                employee: coordinator,
                workOrderNo: order.workOrderNo,
                workOrderId: String(order._id),
            });
            emailed = Boolean(notice.emailed);
            email = notice.email || '';
            message = notice.message || copy.message;
        } catch (error) {
            console.error('Work order attachment email failed:', error);
            message = 'Email could not be sent. The notification was still saved.';
        }
    }
    order.lpoAlert.emailed = emailed;
    order.lpoAlert.emailTo = email;
    order.markModified('lpoAlert');
    await order.save();
    return { emailed, email, message };
}

async function loadFollowUpEmployee(id) {
    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
    return EmployeeBasic.findById(id)
        .select('firstName lastName companyEmail workEmail status profileStatus employeeId primaryReportee')
        .populate('primaryReportee', 'companyEmail workEmail status profileStatus')
        .lean();
}

async function closeLpoFollowUps(order, actorName, detail) {
    if (!order?._id) return;
    try {
        await DashboardAction.updateMany(
            {
                requestId: order._id,
                requestType: { $in: ['Work Order LPO', ATTACHMENT_REQUEST] },
                status: 'Pending',
            },
            { $set: { status: 'Approved', actionedDate: new Date(), comment: detail || 'LPO follow-up completed' } },
        );
        await finishEmployeeWorkflowTasks(order._id, 'Work Order LPO', {
            detail: detail || 'LPO follow-up completed.',
            actorName: actorName || 'Employee',
        });
        await finishEmployeeWorkflowTasks(order._id, ATTACHMENT_REQUEST, {
            detail: detail || 'LPO follow-up completed.',
            actorName: actorName || 'Employee',
        });
    } catch (error) {
        console.error('Could not close the LPO follow-up:', error);
    }
}

async function openSalespersonFollowUp(order, senderName) {
    const notice = salespersonFollowUpNotice(order.workOrderNo);
    const employee = await loadFollowUpEmployee(order.salespersonId);
    const forEmployeeIds = [order.salespersonId, order.salespersonEmployeeId, employee?._id, employee?.employeeId]
        .filter(Boolean)
        .map(String);
    order.lpoFollowUp = 'salesperson';
    order.status = 'LPO Pending';
    order.lpoAlert = {
        active: true,
        kind: 'salesperson',
        message: notice.message,
        sentAt: new Date(),
        sentByName: senderName || '',
        sentById: '',
        attachmentName: order.supportingDocument?.name || '',
        attachmentMime: '',
        attachmentData: '',
        attachmentBytes: order.supportingDocument?.bytes || 0,
        emailed: false,
        emailTo: '',
        forEmployeeIds,
    };
    let emailed = false;
    let email = '';
    let message = employee
        ? notice.message
        : 'Work order created. The salesperson could not be notified.';
    if (employee?._id) {
        await syncDashboardAction({
            requestId: order._id,
            requestType: 'Work Order LPO',
            assignedTo: employee._id,
            status: 'Pending',
            subjectName: order.customer || '',
            requestedByName: senderName || '',
            extra1: notice.extra1,
            extra2: notice.extra2,
            extra3: JSON.stringify({
                path: `/production/work-order?workOrder=${order._id}&section=lpo`,
            }),
        });
        try {
            const sent = await sendWorkOrderFollowUpEmail({
                employee,
                notice,
                workOrderId: String(order._id),
            });
            emailed = Boolean(sent.emailed);
            email = sent.email || '';
            message = sent.message || notice.message;
        } catch (error) {
            console.error('Work order salesperson email failed:', error);
            message = 'Email could not be sent. The notification was still saved.';
        }
    }
    order.lpoAlert.emailed = emailed;
    order.lpoAlert.emailTo = email;
    order.markModified('lpoAlert');
    await order.save();
    return { emailed, email, message };
}

async function openCoordinatorFollowUp(order, senderName) {
    const notice = coordinatorFollowUpNotice(order.workOrderNo);
    const coordinator = await findProjectCoordinator();
    const forEmployeeIds = coordinator
        ? [String(coordinator._id), String(coordinator.employeeId || '')].filter(Boolean)
        : [];
    order.lpoFollowUp = 'coordinator';
    order.status = 'LPO Pending';
    order.attachmentPending = false;
    order.lpoAlert = {
        active: true,
        kind: 'coordinator',
        message: notice.message,
        sentAt: new Date(),
        sentByName: senderName || '',
        sentById: '',
        attachmentName: '',
        attachmentMime: '',
        attachmentData: '',
        attachmentBytes: 0,
        emailed: false,
        emailTo: '',
        forEmployeeIds,
    };
    let emailed = false;
    let email = '';
    let message = coordinator
        ? notice.message
        : 'Work order created. No active Project Coordinator is set on the flowchart, so the notice was not sent.';
    if (coordinator?._id) {
        await syncDashboardAction({
            requestId: order._id,
            requestType: ATTACHMENT_REQUEST,
            assignedTo: coordinator._id,
            status: 'Pending',
            subjectName: order.customer || '',
            requestedByName: senderName || '',
            extra1: notice.extra1,
            extra2: notice.extra2,
            extra3: JSON.stringify({
                path: `/production/work-order?workOrder=${order._id}&section=lpo`,
            }),
        });
        try {
            const sent = await sendWorkOrderFollowUpEmail({
                employee: coordinator,
                notice,
                workOrderId: String(order._id),
            });
            emailed = Boolean(sent.emailed);
            email = sent.email || '';
            message = sent.message || notice.message;
        } catch (error) {
            console.error('Work order coordinator email failed:', error);
            message = 'Email could not be sent. The notification was still saved.';
        }
    }
    order.lpoAlert.emailed = emailed;
    order.lpoAlert.emailTo = email;
    order.markModified('lpoAlert');
    await order.save();
    return { emailed, email, message };
}

async function canCompleteLpoFollowUp(req, order) {
    if (isJwtSystemSuperUser(req.user)) return true;
    const ids = [
        ...(order.lpoAlert?.forEmployeeIds || []),
        order.salespersonId,
        order.salespersonEmployeeId,
    ];
    if (order.lpoFollowUp === 'salesperson') return actorMatches(req, ids);
    if (order.lpoFollowUp === 'coordinator') {
        if (actorMatches(req, order.lpoAlert?.forEmployeeIds || [])) return true;
        return isProjectCoordinator(req);
    }
    return false;
}

async function openLpoNotFilledNotice(order, senderName) {
    const notice = lpoNotFilledNotice({
        senderName,
        workOrderNo: order.workOrderNo,
        customer: order.customer,
    });
    if (mongoose.Types.ObjectId.isValid(String(order.salespersonId || ''))) {
        await syncDashboardAction({
            requestId: order._id,
            requestType: 'Work Order LPO',
            assignedTo: order.salespersonId,
            status: 'Pending',
            subjectName: order.customer || '',
            requestedByName: senderName || '',
            extra1: notice.extra1,
            extra2: notice.extra2,
            extra3: JSON.stringify({ path: `/production/work-order?workOrder=${order._id}` }),
        });
    }
    return notice;
}

function presentWorkOrder(order, { includeFiles = false } = {}) {
    const row = order?.toObject ? order.toObject() : { ...order };
    if (Array.isArray(row.lpos)) {
        row.lpos = row.lpos.map((lpo) => {
            const next = { ...lpo };
            if (!includeFiles) delete next.attachmentData;
            return next;
        });
    }
    if (row.lpoAlert) {
        const alert = { ...row.lpoAlert };
        if (!includeFiles) delete alert.attachmentData;
        row.lpoAlert = alert;
    }
    if (row.supportingDocument) {
        const document = { ...row.supportingDocument };
        if (!includeFiles) delete document.data;
        row.supportingDocument = document;
    }
    if (row.lpoApproval) {
        const approval = { ...row.lpoApproval };
        if (!includeFiles) delete approval.attachmentData;
        row.lpoApproval = approval;
    }
    if (row.quotationFile) {
        const file = { ...row.quotationFile };
        delete file.data;
        row.quotationFile = file;
    }
    if (Array.isArray(row.oldDocuments)) {
        row.oldDocuments = row.oldDocuments.map((document) => {
            const next = { ...document };
            if (!includeFiles) delete next.data;
            return next;
        });
    }
    return row;
}

function lpoStatusLabel(mode) {
    if (mode === 'received') return 'LPO received';
    if (mode === 'not_required') return 'Not required';
    if (mode === 'required') return 'Required';
    return '';
}

function archivedFileRow(file, extra) {
    return {
        name: String(file?.name || '').trim(),
        mime: file?.mime || '',
        data: file?.data || '',
        bytes: Number(file?.bytes) || 0,
        kind: extra.kind,
        fromStatus: extra.fromStatus,
        fromLpoMode: extra.fromLpoMode,
        note: extra.note || '',
        reason: extra.reason || '',
        replacedAt: extra.replacedAt,
        replacedByName: extra.replacedByName || '',
    };
}

function archiveRows(order, rows) {
    const stored = rows.filter((row) => row.name || row.note);
    if (!stored.length) return;
    if (!Array.isArray(order.oldDocuments)) order.oldDocuments = [];
    const signature = stored
        .map((row) => [row.kind, row.name, row.bytes, row.fromStatus, row.fromLpoMode, row.note].join('|'))
        .join('||');
    if (order.oldDocuments.some((row) => row.archiveSignature === signature)) return;
    stored.forEach((row) => {
        order.oldDocuments.push({ ...row, archiveSignature: signature });
    });
    order.markModified('oldDocuments');
}

function archivePreviousStatus(order, actorName, reason) {
    const fromStatus = order.status || '';
    const fromLpoMode = order.lpoMode || 'required';
    const replacedAt = new Date();
    const note = String(order.supportingNote || '').trim();
    const extra = {
        fromStatus,
        fromLpoMode,
        replacedAt,
        replacedByName: actorName || '',
        reason: reason || '',
    };
    const rows = [];
    (order.lpos || []).forEach((lpo) => {
        if (!lpo?.attachmentName && !lpo?.lpoNo) return;
        rows.push(archivedFileRow(
            {
                name: lpo.attachmentName || lpo.lpoNo,
                mime: lpo.attachmentMime,
                data: lpo.attachmentData,
                bytes: lpo.attachmentBytes,
            },
            {
                ...extra,
                kind: 'LPO',
                note: [lpo.lpoNo, lpo.lpoDate, note].filter(Boolean).join(' · '),
            },
        ));
    });
    if (order.supportingDocument?.name) {
        rows.push(archivedFileRow(order.supportingDocument, { ...extra, kind: 'Supporting document', note }));
    }
    const alertName = order.lpoAlert?.attachmentName || '';
    if (alertName && alertName !== order.supportingDocument?.name) {
        rows.push(archivedFileRow(
            {
                name: alertName,
                mime: order.lpoAlert.attachmentMime,
                data: order.lpoAlert.attachmentData,
                bytes: order.lpoAlert.attachmentBytes,
            },
            { ...extra, kind: 'LPO notice', note: order.lpoAlert.message || note },
        ));
    }
    if (!rows.length) {
        rows.push(archivedFileRow(
            { name: [fromStatus || 'Status', lpoStatusLabel(fromLpoMode)].filter(Boolean).join(' · ') },
            { ...extra, kind: 'Status', note: note || reason || '' },
        ));
    }
    archiveRows(order, rows);
}

function archiveReplacedFile(order, file, { kind, note, actorName }) {
    if (!file?.name) return;
    archiveRows(order, [archivedFileRow(file, {
        kind,
        fromStatus: order.status || '',
        fromLpoMode: order.lpoMode || '',
        note: note || '',
        reason: 'File replaced',
        replacedAt: new Date(),
        replacedByName: actorName || '',
    })]);
}

function statusOrLpoWillChange(order, body) {
    if (!body) return false;
    if (body.submitLpoUpdate || body.decideLpoApproval || body.saveLpoDraft) return false;
    if (body.completeLpoFollowUp || body.uploadPendingAttachment || body.lpo || body.sendNotRequired) return true;
    if (body.status && body.status !== order.status) return true;
    if (body.lpoMode && body.lpoMode !== order.lpoMode) return true;
    return false;
}

const LPO_APPROVAL = 'Work Order LPO Approval';
const LPO_WAITING_STATUSES = new Set(['Draft', 'Not Started', 'Awaiting LPO', 'LPO Pending']);

function lpoChoiceLabel(mode) {
    if (mode === 'received') return 'LPO received';
    if (mode === 'not_required') return 'Not required';
    if (mode === 'required') return 'Required';
    return 'Required';
}

function clearedLpoApproval() {
    return {
        status: '',
        mode: '',
        note: '',
        reason: '',
        requestedByName: '',
        requestedById: '',
        lpoNo: '',
        lpoDate: '',
        lpoValue: 0,
        attachmentName: '',
        attachmentMime: '',
        attachmentData: '',
        attachmentBytes: 0,
    };
}

function storedApprovalFile(order) {
    const approval = order?.lpoApproval;
    if (!approval?.attachmentName && !approval?.attachmentData) return null;
    return {
        name: approval.attachmentName || '',
        mime: approval.attachmentMime || '',
        data: approval.attachmentData || '',
        bytes: approval.attachmentBytes || 0,
    };
}

function readOptionalFile(raw) {
    if (!raw) return null;
    const file = readAttachment(raw, { required: false });
    if (!file) return null;
    if (file.error) return file;
    return file;
}

function readLpoUpdate(body, order, { draft = false } = {}) {
    const mode = LPO_MODES.has(body?.lpoMode) ? body.lpoMode : '';
    if (!mode) return { error: 'Choose Required, Not required, or LPO received' };
    if (mode === 'required') return { mode };
    if (mode === 'not_required') {
        const note = cleanText(body?.supportingNote, 1000);
        const uploaded = readOptionalFile(body?.attachment);
        if (uploaded?.error) {
            return { error: uploaded.error === 'Attachment is required' ? 'Supporting document is required' : uploaded.error };
        }
        const file = uploaded || storedApprovalFile(order);
        if (!draft && !note) return { error: 'Reason is required' };
        if (!draft && !file?.data) return { error: 'Supporting document is required' };
        return { mode, note, file };
    }
    const lpoNo = cleanText(body?.lpo?.lpoNo, 80);
    const lpoDate = cleanText(body?.lpo?.lpoDate, 10);
    let lpoValue = cleanMoney(body?.lpo?.lpoValue);
    const quoteTotal = Number(order.value) || 0;
    if (!(lpoValue > 0) && quoteTotal > 0 && !draft) lpoValue = quoteTotal;
    if (quoteTotal > 0 && lpoValue && Math.abs(lpoValue - quoteTotal) > 0.009) {
        return { error: 'LPO value must match the quotation total' };
    }
    if (lpoDate && lpoDate > dubaiDateKey()) return { error: 'LPO date cannot be after today' };
    if (lpoDate && !/^\d{4}-\d{2}-\d{2}$/.test(lpoDate)) return { error: 'LPO date is not valid' };
    const uploaded = readOptionalFile(body?.lpo?.attachment);
    if (uploaded?.error) return { error: uploaded.error };
    const file = uploaded || storedApprovalFile(order);
    if (!draft && (!lpoNo || !/^\d{4}-\d{2}-\d{2}$/.test(lpoDate) || !(lpoValue > 0) || !file?.data)) {
        return { error: 'LPO number, date, value and attachment are required' };
    }
    return { mode, lpoNo, lpoDate, lpoValue, file };
}

function approvalFromPayload(order, payload, actorName, req, status) {
    const previous = order.lpoApproval || {};
    const file = payload.file;
    return {
        status,
        mode: payload.mode,
        note: payload.note || '',
        reason: '',
        requestedByName: actorName,
        requestedById: req.user?.id ? String(req.user.id) : (previous.requestedById || ''),
        requestedAt: status === 'pending' && previous.requestedAt ? previous.requestedAt : new Date(),
        lpoNo: payload.lpoNo || '',
        lpoDate: payload.lpoDate || '',
        lpoValue: payload.lpoValue || 0,
        attachmentName: file?.name || '',
        attachmentMime: file?.mime || '',
        attachmentData: file?.data || '',
        attachmentBytes: file?.bytes || 0,
    };
}

function applyLpoUpdate(order, payload, actorName) {
    archivePreviousStatus(order, actorName, 'LPO updated');
    if (payload.mode === 'not_required') {
        order.supportingNote = payload.note;
        order.supportingDocument = {
            name: payload.file.name,
            mime: payload.file.mime,
            data: payload.file.data,
            bytes: payload.file.bytes,
        };
        order.lpoMode = 'not_required';
        if (LPO_WAITING_STATUSES.has(order.status)) order.status = 'Completed';
    } else if (payload.mode === 'required') {
        order.lpoMode = 'required';
        if (LPO_WAITING_STATUSES.has(order.status)) order.status = 'Created';
    } else {
        const row = {
            lpoNo: payload.lpoNo,
            lpoDate: payload.lpoDate,
            lpoValue: payload.lpoValue,
            attachmentName: payload.file.name,
            attachmentMime: payload.file.mime,
            attachmentData: payload.file.data,
            attachmentBytes: payload.file.bytes,
        };
        if (!Array.isArray(order.lpos)) order.lpos = [];
        if (order.lpos.length) order.lpos.splice(0, 1, row);
        else order.lpos.push(row);
        order.lpoNo = payload.lpoNo;
        order.lpoMode = 'received';
        if (LPO_WAITING_STATUSES.has(order.status)) order.status = 'Created';
        order.markModified('lpos');
    }
    order.lpoFollowUp = '';
    order.attachmentPending = false;
    order.lpoLocked = true;
    order.lpoApproval = clearedLpoApproval();
    order.markModified('lpoApproval');
    if (order.lpoAlert) {
        order.lpoAlert.active = false;
        order.markModified('lpoAlert');
    }
}

function payloadFromApproval(approval) {
    const file = approval?.attachmentName ? {
        name: approval.attachmentName,
        mime: approval.attachmentMime || '',
        data: approval.attachmentData || '',
        bytes: approval.attachmentBytes || 0,
    } : null;
    if (approval?.mode === 'required') return { mode: 'required' };
    if (approval?.mode === 'not_required') return { mode: 'not_required', note: approval.note || '', file };
    return {
        mode: 'received',
        lpoNo: approval?.lpoNo || '',
        lpoDate: approval?.lpoDate || '',
        lpoValue: approval?.lpoValue || 0,
        file,
    };
}

async function closeLpoApprovalNotice(order, status, comment) {
    if (!order?._id) return;
    try {
        await DashboardAction.updateMany(
            { requestId: order._id, requestType: LPO_APPROVAL, status: 'Pending' },
            { $set: { status, actionedDate: new Date(), comment: comment || '' } },
        );
    } catch (error) {
        console.error('Could not close the LPO approval:', error);
    }
}

async function notifyProjectManager(order, actorName, payload) {
    const manager = await findProjectManager();
    if (!manager?._id) {
        return { emailed: false, message: 'Assign an active Project Manager on the flowchart before sending this LPO for approval.' };
    }
    const label = lpoChoiceLabel(payload.mode);
    const notice = {
        message: `Approve the LPO on ${order.workOrderNo}`,
        subject: `${order.workOrderNo}: LPO approval`,
        extra1: `Approve the LPO on ${order.workOrderNo}`,
        extra2: `${actorName} chose ${label}. Approve to change the status, or reject with a reason.`,
    };
    await syncDashboardAction({
        requestId: order._id,
        requestType: LPO_APPROVAL,
        assignedTo: manager._id,
        status: 'Pending',
        subjectName: order.customer || '',
        requestedByName: actorName || '',
        extra1: notice.extra1,
        extra2: notice.extra2,
        extra3: JSON.stringify({ path: `/production/work-order?workOrder=${order._id}&section=lpo` }),
    });
    let emailed = false;
    let message = notice.message;
    try {
        const sent = await sendWorkOrderFollowUpEmail({
            employee: manager,
            notice,
            workOrderId: String(order._id),
        });
        emailed = Boolean(sent.emailed);
        message = sent.message || notice.message;
    } catch (error) {
        console.error('Work order LPO approval email failed:', error);
        message = 'Email could not be sent. The approval was still saved.';
    }
    return { emailed, message, manager };
}

const ACTUAL_BOQ_FIELDS = [
    'slNo', 'category', 'subcategory', 'item', 'brand', 'modelNo',
    'descriptionNew', 'descriptionOld', 'quantity', 'unitPrice', 'total',
    'vendorName', 'paymentTerms',
];

function cleanBoqTables(raw) {
    const tables = Array.isArray(raw) ? raw.slice(0, 30) : [];
    return tables.map((table) => ({
        title: cleanText(table?.title, 120),
        rows: (Array.isArray(table?.rows) ? table.rows : []).slice(0, 400).map((row) => {
            const next = {};
            ACTUAL_BOQ_FIELDS.forEach((key) => {
                const value = row?.[key];
                if (key === 'quantity' || key === 'unitPrice' || key === 'total' || key === 'slNo') {
                    if (value === '' || value == null) next[key] = '';
                    else {
                        const amount = Number(value);
                        next[key] = Number.isFinite(amount) ? amount : cleanText(value, 40);
                    }
                } else {
                    next[key] = cleanText(value, 2000);
                }
            });
            return next;
        }),
    })).filter((table) => table.rows.length);
}

async function findActorEmployee(req) {
    const objectId = req.user?.employeeObjectId;
    const select = 'firstName lastName companyEmail workEmail status profileStatus employeeId primaryReportee';
    if (objectId && mongoose.Types.ObjectId.isValid(String(objectId))) {
        const employee = await EmployeeBasic.findById(objectId)
            .select(select)
            .populate('primaryReportee', 'companyEmail workEmail status profileStatus')
            .lean();
        if (employee) return employee;
    }
    if (req.user?.employeeId) {
        return EmployeeBasic.findOne({ employeeId: req.user.employeeId })
            .select(select)
            .populate('primaryReportee', 'companyEmail workEmail status profileStatus')
            .lean();
    }
    return null;
}

async function closeActualBoqNotice(order, status, comment) {
    if (!order?._id) return;
    await DashboardAction.updateMany(
        { requestId: order._id, requestType: ACTUAL_BOQ_REQUEST, status: 'Pending' },
        { $set: { status, actionedDate: new Date(), comment: comment || '' } },
    );
}

async function markActualBoqProjectTask(orderId) {
    const action = await DashboardAction.findOne({
        requestId: orderId,
        requestType: ACTUAL_BOQ_REQUEST,
        status: 'Pending',
    }).select('_id').lean();
    if (!action?._id) return;
    const task = await TaskManagerTask.findOne({
        sourceDashboardActionId: action._id,
        status: { $nin: ['Cancelled'] },
    }).sort({ updatedAt: -1 });
    if (!task) return;
    task.taskType = 'Project Task';
    await task.save();
}

async function saveActualBoq(req, res, order, actorName) {
    const tables = cleanBoqTables(req.body?.actualBoqTables);
    if (!tables.length) return res.status(400).json({ message: 'Add at least one actual BOQ row before saving' });
    if (order.actualBoq?.status === 'approved') {
        return res.status(400).json({ message: 'This actual BOQ is already approved' });
    }
    if (order.actualBoq?.status === 'pending') {
        return res.status(400).json({ message: 'This actual BOQ is waiting for the project manager' });
    }
    const actor = await findActorEmployee(req);
    if (!actor?._id) return res.status(400).json({ message: 'Your employee record is required to save this actual BOQ' });

    const submitting = Boolean(req.body?.submitActualBoq);
    const manager = submitting ? await findProjectManager() : null;
    if (submitting && !manager?._id) {
        return res.status(400).json({ message: 'Assign an active Project Manager on the flowchart before submitting the actual BOQ.' });
    }

    order.actualBoq = {
        status: submitting ? 'pending' : 'draft',
        tables,
        requestedByName: actorName,
        requestedById: String(actor._id),
        requestedAt: new Date(),
        reason: '',
        decidedByName: '',
        decidedAt: null,
    };
    order.markModified('actualBoq');
    await order.save();

    const assignee = submitting ? manager : actor;
    const notice = submitting
        ? {
            extra1: `Approve the actual BOQ on ${order.workOrderNo}`,
            extra2: `${actorName} submitted the actual BOQ. Approve it, or reject with a description.`,
            subject: `${order.workOrderNo}: actual BOQ approval`,
            message: `Approve the actual BOQ on ${order.workOrderNo}`,
        }
        : {
            extra1: `Actual BOQ draft on ${order.workOrderNo}`,
            extra2: `${actorName} saved an actual BOQ draft. Requester and assignee are the same.`,
            subject: `${order.workOrderNo}: actual BOQ draft`,
            message: `Actual BOQ draft on ${order.workOrderNo}`,
        };
    await syncDashboardAction({
        requestId: order._id,
        requestType: ACTUAL_BOQ_REQUEST,
        assignedTo: assignee._id,
        status: 'Pending',
        subjectName: order.customer || '',
        requestedByName: actorName,
        extra1: notice.extra1,
        extra2: notice.extra2,
        extra3: JSON.stringify({ path: `/production/work-order?workOrder=${order._id}&section=actual-boq` }),
    });
    if (submitting) await markActualBoqProjectTask(order._id);

    let emailMessage = submitting ? notice.message : 'Draft saved. The task and notification are assigned to you.';
    if (submitting) {
        try {
            const sent = await sendWorkOrderFollowUpEmail({
                employee: manager,
                notice,
                workOrderId: String(order._id),
                section: 'actual-boq',
            });
            emailMessage = sent.message || notice.message;
        } catch (error) {
            console.error('Actual BOQ approval email failed:', error);
            emailMessage = 'Email could not be sent. The approval was still saved.';
        }
    }
    return res.status(200).json({
        workOrder: await presentedForViewer(order, req),
        emailMessage,
        actualBoqSaved: true,
    });
}

async function openMaterialRequest(order, actorName) {
    const officer = await findPurchaseOfficer();
    const employee = officer?.empObjectId
        ? await EmployeeBasic.findById(officer.empObjectId)
            .select('firstName lastName companyEmail workEmail status profileStatus employeeId primaryReportee')
            .populate('primaryReportee', 'companyEmail workEmail status profileStatus')
            .lean()
        : null;
    const purchaserName = String(officer?.employeeName || [employee?.firstName, employee?.lastName].filter(Boolean).join(' ') || '').trim();
    order.materialRequest = {
        status: 'open',
        createdAt: new Date(),
        purchaserName,
        purchaserId: officer?.empObjectId ? String(officer.empObjectId) : '',
        tables: Array.isArray(order.actualBoq?.tables) ? order.actualBoq.tables : [],
    };
    order.markModified('materialRequest');
    if (!officer?.empObjectId) {
        return { message: 'Actual BOQ approved. Assign an active Purchase Officer on the flowchart so the material request can be assigned.' };
    }
    const notice = {
        extra1: `Create the MR for ${order.workOrderNo}`,
        extra2: `${actorName} approved the actual BOQ. Create the material request from these lines.`,
        subject: `${order.workOrderNo}: create the material request`,
        message: `Create the material request for ${order.workOrderNo}`,
    };
    await syncDashboardAction({
        requestId: order._id,
        requestType: MATERIAL_REQUEST,
        assignedTo: officer.empObjectId,
        status: 'Pending',
        subjectName: order.customer || '',
        requestedByName: actorName,
        extra1: notice.extra1,
        extra2: notice.extra2,
        extra3: JSON.stringify({ path: `/production/work-order?workOrder=${order._id}&section=mr` }),
    });
    const companyEmail = String(officer.companyEmail || employee?.companyEmail || '').trim();
    if (!companyEmail) {
        return { message: `Material request assigned to ${purchaserName || 'the purchase officer'}. No company email is set, so the email was not sent.` };
    }
    try {
        const sent = await sendWorkOrderFollowUpEmail({
            employee: employee ? { ...employee, companyEmail, workEmail: '' } : { companyEmail, firstName: purchaserName, status: 'Active', profileStatus: 'Active' },
            notice,
            workOrderId: String(order._id),
            section: 'mr',
        });
        return { message: sent.message || `Email sent to ${companyEmail}.` };
    } catch (error) {
        console.error('Material request email failed:', error);
        return { message: 'The material request task was saved. Email could not be sent.' };
    }
}

async function decideActualBoq(req, res, order, actorName) {
    const manager = await isProjectManager(req) || isJwtSystemSuperUser(req.user);
    if (!manager) return res.status(403).json({ message: 'Only the project manager can approve the actual BOQ' });
    if (order.actualBoq?.status !== 'pending') {
        return res.status(400).json({ message: 'This actual BOQ is not waiting for approval' });
    }
    const decision = req.body?.decideActualBoq === 'reject' ? 'reject' : 'approve';
    const reason = cleanText(req.body?.rejectReason, 1000);
    if (decision === 'reject' && !reason) {
        return res.status(400).json({ message: 'A description is required to reject the actual BOQ' });
    }
    order.actualBoq.status = decision === 'approve' ? 'approved' : 'rejected';
    order.actualBoq.reason = decision === 'reject' ? reason : '';
    order.actualBoq.decidedByName = actorName;
    order.actualBoq.decidedAt = new Date();
    order.markModified('actualBoq');
    let mrMessage = '';
    if (decision === 'approve') {
        mrMessage = (await openMaterialRequest(order, actorName)).message;
    }
    await order.save();
    const closed = decision === 'approve' ? 'Approved' : 'Rejected';
    await closeActualBoqNotice(order, closed, reason || 'Actual BOQ approved');
    await finishEmployeeWorkflowTasks(order._id, ACTUAL_BOQ_REQUEST, {
        taskStatus: decision === 'approve' ? 'Completed' : 'Rejected',
        event: closed,
        detail: decision === 'approve' ? 'Actual BOQ approved.' : reason,
        actorName,
    });
    return res.status(200).json({
        workOrder: await presentedForViewer(order, req),
        emailMessage: decision === 'approve' ? mrMessage : '',
        actualBoqSaved: true,
    });
}

async function presentedForViewer(order, req) {
    const presented = presentWorkOrder(order, { includeFiles: true });
    presented.viewerCanCompleteLpo = Boolean(order.lpoFollowUp) && await canCompleteLpoFollowUp(req, order);
    presented.viewerIsProjectManager = await isProjectManager(req);
    presented.lpoAssigneeName = await projectCoordinatorName();
    presented.projectManagerName = await projectManagerName();
    return presented;
}

async function allocateWorkOrderNo() {
    const year = workOrderYear();
    const rows = await WorkOrder.find({ year }).select('workOrderNo').lean();
    let sequence = nextSequenceForYear(year, rows.map((row) => row.workOrderNo));
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const workOrderNo = formatWorkOrderNo(year, sequence);
        const exists = await WorkOrder.exists({ workOrderNo });
        if (!exists) return { year, sequence, workOrderNo };
        sequence += 1;
    }
    throw new Error('Could not allocate a work order number');
}

export const getNextWorkOrderNo = async (_req, res) => {
    try {
        const allocated = await allocateWorkOrderNo();
        const missing = await missingWorkOrderFlowchartRoles();
        return res.status(200).json({
            workOrderNo: allocated.workOrderNo,
            createdOn: dubaiDateKey(),
            missingFlowchartRoles: missing.map((role) => role.label),
        });
    } catch (error) {
        console.error('Error preparing work order number:', error);
        return res.status(500).json({ message: 'Failed to prepare the work order number' });
    }
};

export const getWorkOrders = async (_req, res) => {
    try {
        const workOrders = await WorkOrder.find()
            .sort({ createdAt: -1 })
            .limit(500)
            .select('-lpos.attachmentData -lpoAlert.attachmentData -oldDocuments.data -budgets -quotationFile.data -lpoApproval.attachmentData')
            .lean();
        return res.status(200).json({ workOrders });
    } catch (error) {
        console.error('Error listing work orders:', error);
        return res.status(500).json({ message: 'Failed to load work orders' });
    }
};

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function duplicateQuoteMessage(workOrderNo) {
    const number = workOrderNo ? ` (${workOrderNo})` : '';
    return `Already work order created with this quote${number}. Check again.`;
}

async function findCreatedWorkOrderForQuote({ quotationRef, quotationId }) {
    const ref = cleanText(quotationRef, 80);
    const quoteId = cleanText(quotationId, 80);
    const or = [];
    if (ref) or.push({ quotationRef: { $regex: `^${escapeRegex(ref)}$`, $options: 'i' } });
    if (quoteId) or.push({ quotationId: quoteId });
    if (!or.length) return null;
    return WorkOrder.findOne({ status: { $ne: 'Draft' }, $or: or })
        .select('workOrderNo quotationRef status')
        .lean();
}

export const getWorkOrderQuotationUse = async (req, res) => {
    try {
        const existing = await findCreatedWorkOrderForQuote({
            quotationRef: req.query?.number || req.query?.quotationRef,
            quotationId: req.query?.quotationId,
        });
        if (!existing) return res.status(200).json({ used: false });
        return res.status(200).json({
            used: true,
            workOrderNo: existing.workOrderNo,
            message: duplicateQuoteMessage(existing.workOrderNo),
        });
    } catch (error) {
        console.error('Error checking the quotation:', error);
        return res.status(500).json({ message: 'Failed to check the quotation' });
    }
};

export const createWorkOrder = async (req, res) => {
    try {
        const missingRoles = await missingWorkOrderFlowchartRoles();
        if (missingRoles.length) {
            return res.status(400).json({
                message: flowchartRoleMessage(missingRoles.map((role) => role.label)),
                missingFlowchartRoles: missingRoles.map((role) => role.label),
            });
        }
        const crmCustomer = await resolveCrmCustomer(req.body?.customerId, req.body?.customer);
        if (!crmCustomer) {
            return res.status(400).json({ message: 'Select a customer that was added in CRM' });
        }
        const customer = crmCustomer.name;

        const intentDraft = req.body?.intent === 'draft' || req.body?.saveAsDraft === true;
        const type = TYPES.has(req.body?.type) ? req.body.type : 'Standalone';
        const value = cleanMoney(req.body?.value);
        const valueExclVat = cleanMoney(req.body?.valueExclVat);
        const vatAmount = cleanMoney(req.body?.vatAmount);
        if (value === null || valueExclVat === null || vatAmount === null) {
            return res.status(400).json({ message: 'Value must be a valid amount' });
        }

        const quotationRef = cleanText(req.body?.quotationRef, 80);
        const salespersonName = cleanText(req.body?.salespersonName, 120);
        const salespersonId = cleanText(req.body?.salespersonId, 80);
        const salespersonCode = cleanText(req.body?.salespersonEmployeeId, 80);
        const lpoMode = LPO_MODES.has(req.body?.lpoMode) ? req.body.lpoMode : 'required';
        const location = cleanText(req.body?.location, 200);
        const description = cleanText(req.body?.description, 1000);
        const confirmationDate = cleanText(req.body?.confirmationDate, 10);
        const projectName = type === 'Standalone' ? '' : cleanText(req.body?.projectName, 160);
        const senderName = cleanText(req.user?.name, 120) || 'An employee';

        let receivedLpo = null;
        let supportingFile = null;
        let supportingNote = '';
        if (lpoMode === 'received') {
            const lpoNo = cleanText(req.body?.lpoNo, 80);
            const lpoDate = cleanText(req.body?.lpoDate, 10);
            let lpoValue = cleanMoney(req.body?.lpoValue);
            if (!(lpoValue > 0) && value > 0) lpoValue = value;
            const file = readAttachment(req.body?.attachment, { required: !intentDraft });
            if (file?.error) return res.status(400).json({ message: file.error });
            if (!intentDraft && value > 0 && lpoValue && Math.abs(lpoValue - value) > 0.009) {
                return res.status(400).json({ message: 'LPO value must match the quotation total' });
            }
            if (!intentDraft && lpoDate && lpoDate > dubaiDateKey()) {
                return res.status(400).json({ message: 'LPO date cannot be after today' });
            }
            if (!intentDraft && (!lpoNo || !/^\d{4}-\d{2}-\d{2}$/.test(lpoDate) || !lpoValue)) {
                return res.status(400).json({ message: 'LPO number, date, value and attachment are required' });
            }
            if (lpoNo) {
                receivedLpo = {
                    lpoNo,
                    lpoDate,
                    lpoValue: lpoValue || 0,
                    attachmentName: file?.name || '',
                    attachmentMime: file?.mime || '',
                    attachmentData: file?.data || '',
                    attachmentBytes: file?.bytes || 0,
                };
            }
        } else if (lpoMode === 'not_required') {
            supportingNote = cleanText(req.body?.supportingNote, 1000);
            const file = readAttachment(req.body?.attachment, { required: false });
            if (file?.error) return res.status(400).json({ message: file.error });
            if (file) supportingFile = file;
        }

        if (!intentDraft) {
            if (!quotationRef) {
                return res.status(400).json({ message: 'A Zoho quotation is required' });
            }
            if (!salespersonName) {
                return res.status(400).json({ message: 'Salesperson is required' });
            }
            if (!location || !description || !confirmationDate) {
                return res.status(400).json({ message: 'Confirmation date, location and description are required' });
            }
        }

        const draftFor = new Set();
        if (req.user?.id) draftFor.add(String(req.user.id));
        if (req.user?.employeeId) draftFor.add(String(req.user.employeeId));
        if (req.user?.employeeObjectId) draftFor.add(String(req.user.employeeObjectId));
        if (salespersonId) draftFor.add(salespersonId);
        if (salespersonCode) draftFor.add(salespersonCode);

        const status = intentDraft ? 'Draft' : (lpoMode === 'received' ? 'Not Started' : 'LPO Pending');
        const lpoFollowUp = intentDraft || lpoMode === 'received'
            ? ''
            : (lpoMode === 'not_required' ? 'salesperson' : 'coordinator');

        const quotationId = cleanText(req.body?.quotationId, 80);
        const quotationDate = cleanText(req.body?.quotationDate, 10);
        if (quotationRef || quotationId) {
            const existingQuote = await findCreatedWorkOrderForQuote({ quotationRef, quotationId });
            if (existingQuote) {
                return res.status(400).json({ message: duplicateQuoteMessage(existingQuote.workOrderNo) });
            }
        }
        const quoteFallback = {
            quotationRef,
            quotationId,
            quotationDate,
            customer,
            salespersonName,
            valueExclVat,
            vatAmount,
            value,
        };
        let quotationSnapshot = null;
        if (quotationRef) {
            try {
                const estimate = await loadQuotationEstimate(quotationRef);
                quotationSnapshot = snapshotFromEstimate(estimate, quoteFallback);
            } catch (error) {
                console.error('Quotation snapshot was not loaded from Zoho:', error?.message || error);
                quotationSnapshot = snapshotFromEstimate(null, quoteFallback);
            }
        }
        let quotationFile = null;
        if (quotationRef || quotationId) {
            try {
                quotationFile = await captureQuotationFile({
                    estimateId: quotationSnapshot?.id || quotationId,
                    number: quotationRef,
                });
            } catch (error) {
                console.error('Quotation PDF was not stored:', error?.message || error);
            }
        }

        const payload = {
            customer,
            customerId: crmCustomer.id,
            quotationRef,
            quotationId,
            quotationDate,
            quotationSnapshot,
            ...(quotationFile ? { quotationFile } : {}),
            valueExclVat,
            vatAmount,
            lpoMode,
            lpoNo: receivedLpo?.lpoNo || '',
            confirmationDate,
            location,
            description,
            salespersonId,
            salespersonEmployeeId: salespersonCode,
            salespersonName,
            projectName,
            type,
            value,
            lpos: receivedLpo ? [receivedLpo] : [],
            lpoFollowUp,
            supportingNote: lpoMode === 'not_required' ? supportingNote : '',
            ...(supportingFile ? {
                supportingDocument: {
                    name: supportingFile.name,
                    mime: supportingFile.mime,
                    data: supportingFile.data,
                    bytes: supportingFile.bytes,
                },
            } : {}),
            status,
            draftForEmployeeIds: intentDraft ? [...draftFor] : [],
            createdOn: dubaiDateKey(),
            createdBy: req.user?.id ? String(req.user.id) : '',
            createdByName: senderName,
        };

        for (let attempt = 0; attempt < 5; attempt += 1) {
            const allocated = await allocateWorkOrderNo();
            try {
                const workOrder = await WorkOrder.create({ ...payload, ...allocated });
                let emailSent = false;
                let emailMessage = '';
                if (!intentDraft && lpoMode === 'not_required') {
                    try {
                        const notice = await openSalespersonFollowUp(workOrder, senderName);
                        emailSent = Boolean(notice.emailed);
                        emailMessage = notice.message || '';
                    } catch (error) {
                        console.error('Work order salesperson follow-up failed:', error);
                        emailMessage = 'The work order was created. The salesperson notice could not be sent.';
                    }
                } else if (!intentDraft && lpoMode === 'required') {
                    try {
                        const notice = await openCoordinatorFollowUp(workOrder, senderName);
                        emailSent = Boolean(notice.emailed);
                        emailMessage = notice.message || '';
                    } catch (error) {
                        console.error('Work order coordinator follow-up failed:', error);
                        emailMessage = 'The work order was created. The project coordinator notice could not be sent.';
                    }
                }
                return res.status(201).json({
                    workOrder: presentWorkOrder(workOrder),
                    emailSent,
                    emailMessage,
                });
            } catch (error) {
                if (error?.code !== 11000) throw error;
            }
        }

        return res.status(409).json({ message: 'Could not assign a work order number. Try again.' });
    } catch (error) {
        console.error('Error creating work order:', error);
        return res.status(500).json({ message: 'Failed to create the work order' });
    }
};

export const getWorkOrderActualBoq = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Work order was not found' });
        }
        const order = await WorkOrder.findById(id).select('quotationSnapshot vendorId vendorName').lean();
        if (!order) return res.status(404).json({ message: 'Work order was not found' });
        const lines = await buildActualBoq(order);
        return res.status(200).json({ lines });
    } catch (error) {
        console.error('Error loading actual BOQ:', error);
        return res.status(500).json({ message: 'Failed to load the actual BOQ' });
    }
};

export const getWorkOrder = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Work order was not found' });
        }
        const workOrder = await WorkOrder.findById(id).lean();
        if (!workOrder) return res.status(404).json({ message: 'Work order was not found' });
        return res.status(200).json({ workOrder: await presentedForViewer(workOrder, req) });
    } catch (error) {
        console.error('Error loading work order:', error);
        return res.status(500).json({ message: 'Failed to load the work order' });
    }
};

async function findWorkOrder(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    return WorkOrder.findById(id);
}

export const getWorkOrderQuotationFile = async (req, res) => {
    try {
        const order = await findWorkOrder(req.params.id);
        if (!order) return res.status(404).json({ message: 'Work order was not found' });
        if (!order.quotationRef && !order.quotationId) {
            return res.status(400).json({ message: 'This work order has no quotation' });
        }

        let file = order.quotationFile?.data ? order.quotationFile : null;
        if (!file) {
            file = await captureQuotationFile({
                estimateId: order.quotationId,
                number: order.quotationRef,
            });
            if (!file?.data) {
                return res.status(502).json({ message: 'Could not store this quotation' });
            }
            order.quotationFile = file;
            order.markModified('quotationFile');
            await order.save();
        }

        const buffer = Buffer.from(file.data, 'base64');
        const filename = String(file.name || `Quotation-${order.quotationRef || 'document'}.pdf`).replace(/"/g, '');
        res.setHeader('Content-Type', file.mime || 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).send(buffer);
    } catch (error) {
        console.error('Error opening the stored quotation:', error);
        const message = error?.message || 'Could not open this quotation';
        return res.status(error.statusCode || 502).json({ message });
    }
};

export const getWorkOrderQuotationChanges = async (req, res) => {
    try {
        const order = await findWorkOrder(req.params.id);
        if (!order) return res.status(404).json({ message: 'Work order was not found' });
        if (!order.quotationRef || !(await isProjectCoordinator(req))) {
            return res.status(200).json({ canUpdate: false, changed: false, changes: [] });
        }
        const estimate = await loadQuotationEstimate(order.quotationRef);
        const changes = quotationChanges(savedQuotation(order), snapshotFromEstimate(estimate, order));
        return res.status(200).json({ canUpdate: true, changed: changes.length > 0, changes });
    } catch (error) {
        console.error('Error comparing the quotation:', error);
        const message = error?.message || 'Could not check this quotation in Zoho';
        return res.status(error.statusCode || 502).json({ message });
    }
};

export const updateWorkOrderBudget = async (req, res) => {
    try {
        const action = String(req.body?.action || '');
        if (!['convert', 'rebudget', 'resync'].includes(action)) {
            return res.status(400).json({ message: 'Choose convert, rebudget, or resync' });
        }
        const order = await findWorkOrder(req.params.id);
        if (!order) return res.status(404).json({ message: 'Work order was not found' });
        if (!order.quotationRef) {
            return res.status(400).json({ message: 'This work order has no quotation' });
        }
        if (action === 'resync' && !isJwtSystemSuperUser(req.user)) {
            return res.status(403).json({ message: 'Only a system admin can resync the budget' });
        }
        if (action === 'convert' && order.budgeted) {
            return res.status(400).json({ message: 'This work order is already a budget. Use Re budget.' });
        }
        if ((action === 'rebudget' || action === 'resync') && !order.budgeted) {
            return res.status(400).json({ message: 'Convert this work order to a budget first' });
        }
        if (action === 'resync' && !order.budgets?.length) {
            return res.status(400).json({ message: 'There is no budget quotation to resync' });
        }

        const estimate = await loadQuotationEstimate(order.quotationRef);
        const quote = snapshotFromEstimate(estimate, order);
        const savedByName = cleanText(req.user?.name, 120);

        if (action === 'resync') {
            const latest = order.budgets[order.budgets.length - 1];
            latest.quote = quote;
            latest.savedAt = new Date();
            latest.savedByName = savedByName;
            latest.action = 'resync';
        } else {
            order.budgets.push({
                revision: order.budgets.length + 1,
                savedAt: new Date(),
                savedByName,
                action,
                quote,
            });
            order.budgeted = true;
        }
        order.markModified('budgets');
        await order.save();
        return res.status(200).json({ workOrder: presentWorkOrder(order, { includeFiles: true }) });
    } catch (error) {
        console.error('Error updating the work order budget:', error);
        const message = error?.message || 'Could not update the budget from Zoho';
        return res.status(error.statusCode || 502).json({ message });
    }
};

export const applyWorkOrderQuotationChanges = async (req, res) => {
    try {
        const order = await findWorkOrder(req.params.id);
        if (!order) return res.status(404).json({ message: 'Work order was not found' });
        if (!(await isProjectCoordinator(req))) {
            return res.status(403).json({ message: 'Only the project coordinator can update quotation changes' });
        }
        if (!order.quotationRef) {
            return res.status(400).json({ message: 'This work order has no quotation' });
        }
        const estimate = await loadQuotationEstimate(order.quotationRef);
        const changes = quotationChanges(savedQuotation(order), snapshotFromEstimate(estimate, order));
        const { lpoAdjusted } = applyQuotationSnapshot(order, estimate);
        try {
            const quotationFile = await captureQuotationFile({
                estimateId: order.quotationId || estimate?.id,
                number: order.quotationRef,
            });
            if (quotationFile) {
                const actorName = cleanText(req.user?.name, 120) || 'An employee';
                if (order.quotationFile?.name && order.quotationFile.data !== quotationFile.data) {
                    archiveReplacedFile(order, order.quotationFile, {
                        kind: 'Quotation',
                        note: order.quotationRef,
                        actorName,
                    });
                }
                order.quotationFile = quotationFile;
                order.markModified('quotationFile');
            }
        } catch (error) {
            console.error('Quotation PDF was not stored:', error?.message || error);
        }
        await order.save();
        return res.status(200).json({
            workOrder: presentWorkOrder(order, { includeFiles: true }),
            changes,
            lpoAdjusted,
        });
    } catch (error) {
        console.error('Error updating the quotation:', error);
        const message = error?.message || 'Could not update this quotation from Zoho';
        return res.status(error.statusCode || 502).json({ message });
    }
};

export const updateWorkOrder = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Work order was not found' });
        }
        const order = await WorkOrder.findById(id);
        if (!order) return res.status(404).json({ message: 'Work order was not found' });
        const actorName = cleanText(req.user?.name, 120) || 'An employee';
        if (req.body?.saveActualBoqDraft || req.body?.submitActualBoq) {
            return saveActualBoq(req, res, order, actorName);
        }
        if (req.body?.decideActualBoq) {
            return decideActualBoq(req, res, order, actorName);
        }
        if (req.body?.saveLpoDraft || req.body?.submitLpoUpdate || req.body?.decideLpoApproval) {
            const manager = await isProjectManager(req);
            if (req.body?.saveLpoDraft) {
                if (order.lpoLocked && !manager) {
                    return res.status(403).json({ message: 'Only the project manager can update the LPO' });
                }
                if (order.lpoApproval?.status === 'pending' && !manager) {
                    return res.status(400).json({ message: 'This LPO is waiting for the project manager' });
                }
                const draftPayload = readLpoUpdate(req.body, order, { draft: true });
                if (draftPayload.error) return res.status(400).json({ message: draftPayload.error });
                const previousApproval = order.lpoApproval || {};
                const keepPending = previousApproval.status === 'pending' && manager;
                order.lpoApproval = approvalFromPayload(
                    order,
                    draftPayload,
                    actorName,
                    req,
                    keepPending ? 'pending' : 'draft',
                );
                if (keepPending) {
                    order.lpoApproval.requestedByName = previousApproval.requestedByName || '';
                    order.lpoApproval.requestedById = previousApproval.requestedById || '';
                    order.lpoApproval.requestedAt = previousApproval.requestedAt;
                }
                order.markModified('lpoApproval');
                await order.save();
                return res.status(200).json({
                    workOrder: await presentedForViewer(order, req),
                    draftSaved: true,
                });
            }
            if (req.body?.decideLpoApproval) {
                if (!manager) {
                    return res.status(403).json({ message: 'Only the project manager can approve the LPO' });
                }
                if (order.lpoApproval?.status !== 'pending') {
                    return res.status(400).json({ message: 'This LPO is not waiting for approval' });
                }
                const decision = String(req.body.decision || '').toLowerCase();
                if (decision === 'reject') {
                    const reason = cleanText(req.body.reason, 1000);
                    if (!reason) return res.status(400).json({ message: 'A reason is required to reject the LPO' });
                    order.lpoApproval.reason = reason;
                    order.lpoApproval.status = 'rejected';
                    order.markModified('lpoApproval');
                    await order.save();
                    await closeLpoApprovalNotice(order, 'Rejected', reason);
                    return res.status(200).json({
                        workOrder: await presentedForViewer(order, req),
                        rejected: true,
                    });
                }
                if (decision !== 'approve') {
                    return res.status(400).json({ message: 'Choose approve or reject' });
                }
                const approved = payloadFromApproval(order.lpoApproval);
                if (approved.mode === 'not_required' && (!approved.note || !approved.file?.data)) {
                    return res.status(400).json({ message: 'Reason and supporting document are required before approval' });
                }
                if (
                    approved.mode === 'received'
                    && (!approved.lpoNo || !/^\d{4}-\d{2}-\d{2}$/.test(approved.lpoDate || '') || !(approved.lpoValue > 0) || !approved.file?.data)
                ) {
                    return res.status(400).json({ message: 'LPO number, date, value and attachment are required before approval' });
                }
                applyLpoUpdate(order, approved, actorName);
                await order.save();
                await closeLpoApprovalNotice(order, 'Approved', 'LPO approved');
                await closeLpoFollowUps(order, actorName, 'LPO approved');
                return res.status(200).json({
                    workOrder: await presentedForViewer(order, req),
                    applied: true,
                });
            }
            if (order.lpoLocked && !manager) {
                return res.status(403).json({ message: 'Only the project manager can update the LPO' });
            }
            if (order.lpoApproval?.status === 'pending' && !manager) {
                return res.status(400).json({ message: 'This LPO is waiting for the project manager' });
            }
            const payload = readLpoUpdate(req.body, order);
            if (payload.error) return res.status(400).json({ message: payload.error });
            if (manager) {
                applyLpoUpdate(order, payload, actorName);
                await order.save();
                await closeLpoApprovalNotice(order, 'Approved', 'LPO updated by the project manager');
                await closeLpoFollowUps(order, actorName, 'LPO updated');
                return res.status(200).json({
                    workOrder: await presentedForViewer(order, req),
                    applied: true,
                });
            }
            const managerEmployee = await findProjectManager();
            if (!managerEmployee?._id) {
                return res.status(400).json({ message: 'Assign an active Project Manager on the flowchart before updating the LPO.' });
            }
            order.lpoApproval = {
                status: 'pending',
                mode: payload.mode,
                note: payload.note || '',
                reason: '',
                requestedByName: actorName,
                requestedById: req.user?.id ? String(req.user.id) : '',
                requestedAt: new Date(),
                lpoNo: payload.lpoNo || '',
                lpoDate: payload.lpoDate || '',
                lpoValue: payload.lpoValue || 0,
                attachmentName: payload.file?.name || '',
                attachmentMime: payload.file?.mime || '',
                attachmentData: payload.file?.data || '',
                attachmentBytes: payload.file?.bytes || 0,
            };
            order.markModified('lpoApproval');
            await order.save();
            const notice = await notifyProjectManager(order, actorName, payload);
            return res.status(200).json({
                workOrder: await presentedForViewer(order, req),
                approvalSent: true,
                emailMessage: notice.message || '',
            });
        }
        if (statusOrLpoWillChange(order, req.body)) {
            archivePreviousStatus(order, actorName, 'Status or LPO changed');
        }
        const managerForLock = await isProjectManager(req);
        const touchesLpo = Boolean(
            req.body?.completeLpoFollowUp
            || req.body?.uploadPendingAttachment
            || req.body?.lpo
            || req.body?.sendNotRequired
            || (req.body?.lpoMode && req.body.lpoMode !== order.lpoMode),
        );
        if (touchesLpo && order.lpoLocked && !managerForLock) {
            return res.status(403).json({ message: 'Only the project manager can update the LPO' });
        }
        if (touchesLpo && order.lpoApproval?.status === 'pending' && !managerForLock) {
            return res.status(400).json({ message: 'This LPO is waiting for the project manager' });
        }

        if (req.body?.completeLpoFollowUp) {
            if (!order.lpoFollowUp) {
                return res.status(400).json({ message: 'This work order is not waiting on an LPO action' });
            }
            if (!(await canCompleteLpoFollowUp(req, order))) {
                const who = order.lpoFollowUp === 'coordinator' ? 'project coordinator' : 'salesperson';
                return res.status(403).json({ message: `The ${who} completes this step` });
            }
            const mode = LPO_MODES.has(req.body?.lpoMode) ? req.body.lpoMode : order.lpoMode;
            if (mode === 'not_required') {
                const note = cleanText(req.body?.supportingNote, 1000);
                if (!note) return res.status(400).json({ message: 'Note is required' });
                const file = readAttachment(req.body?.attachment, { required: !order.supportingDocument?.name });
                if (file?.error) return res.status(400).json({ message: file.error });
                if (!file && !order.supportingDocument?.name) {
                    return res.status(400).json({ message: 'Supporting document is required' });
                }
                if (file) {
                    order.supportingDocument = {
                        name: file.name,
                        mime: file.mime,
                        data: file.data,
                        bytes: file.bytes,
                    };
                }
                order.supportingNote = note;
                order.lpoMode = 'not_required';
                order.status = 'Completed';
            } else if (mode === 'required') {
                order.lpoMode = 'required';
                order.status = 'Created';
            } else {
                const lpoNo = cleanText(req.body?.lpo?.lpoNo, 80);
                const lpoDate = cleanText(req.body?.lpo?.lpoDate, 10);
                let lpoValue = cleanMoney(req.body?.lpo?.lpoValue);
                const quoteTotal = Number(order.value) || 0;
                if (!(lpoValue > 0) && quoteTotal > 0) lpoValue = quoteTotal;
                if (quoteTotal > 0 && lpoValue && Math.abs(lpoValue - quoteTotal) > 0.009) {
                    return res.status(400).json({ message: 'LPO value must match the quotation total' });
                }
                if (lpoDate && lpoDate > dubaiDateKey()) {
                    return res.status(400).json({ message: 'LPO date cannot be after today' });
                }
                if (!lpoNo || !/^\d{4}-\d{2}-\d{2}$/.test(lpoDate) || !(lpoValue > 0)) {
                    return res.status(400).json({ message: 'LPO number, date and value are required' });
                }
                if (order.lpos.length >= 1) {
                    return res.status(400).json({ message: 'This work order already has one LPO' });
                }
                const file = readAttachment(req.body?.lpo?.attachment, { required: true });
                if (file?.error) return res.status(400).json({ message: file.error });
                order.lpos.push({
                    lpoNo,
                    lpoDate,
                    lpoValue,
                    attachmentName: file?.name || '',
                    attachmentMime: file?.mime || '',
                    attachmentData: file?.data || '',
                    attachmentBytes: file?.bytes || 0,
                });
                order.lpoNo = lpoNo;
                order.lpoMode = 'received';
                order.status = 'Created';
            }
            order.lpoFollowUp = '';
            order.attachmentPending = false;
            if (order.lpoAlert) {
                order.lpoAlert.active = false;
                order.markModified('lpoAlert');
            }
            const detail = mode === 'not_required'
                ? 'Supporting document and note saved. Status is Completed.'
                : mode === 'required'
                    ? 'Work order created.'
                    : 'LPO received. Work order created.';
            await order.save();
            await closeLpoFollowUps(order, actorName, detail);
            const presented = presentWorkOrder(order, { includeFiles: true });
            presented.viewerCanCompleteLpo = false;
            return res.status(200).json({ workOrder: presented });
        }

        if (req.body?.dismissLpoAlert && order.lpoAlert) {
            order.lpoAlert.active = false;
            order.markModified('lpoAlert');
            await closeLpoNotFilledNotice(order);
        }

        if (req.body?.status) {
            if (!STATUSES.has(req.body.status)) {
                return res.status(400).json({ message: 'Status is not valid' });
            }
            order.status = req.body.status;
            if (req.body.status !== 'Draft') order.draftForEmployeeIds = [];
        }

        if (req.body?.convertToProject) {
            if (order.type !== 'Standalone') {
                return res.status(400).json({ message: 'Only a standalone work order can be converted to a project' });
            }
            order.type = 'Main WO';
            if (!String(order.projectName || '').trim()) {
                order.projectName = cleanText(order.customer || order.workOrderNo, 160);
            }
        }

        if (req.body?.uploadPendingAttachment) {
            if (!order.attachmentPending) {
                return res.status(400).json({ message: 'This work order does not need an attachment update' });
            }
            const allowed = order.lpoAlert?.forEmployeeIds || [];
            if (allowed.length && !actorMatches(req, allowed)) {
                return res.status(403).json({ message: 'The project coordinator uploads this attachment' });
            }
            const file = readAttachment(req.body.attachment, { required: true });
            if (!file || file.error) {
                return res.status(400).json({ message: file?.error || 'Attachment is required' });
            }
            const senderName = cleanText(req.user?.name, 120) || 'An employee';
            order.attachmentPending = false;
            order.lpoAlert = {
                ...(order.lpoAlert?.toObject ? order.lpoAlert.toObject() : (order.lpoAlert || {})),
                active: false,
                kind: 'attachment',
                attachmentName: file.name,
                attachmentMime: file.mime,
                attachmentData: file.data,
                attachmentBytes: file.bytes,
            };
            order.markModified('lpoAlert');
            await closeAttachmentRequest(order, senderName);
            await order.save();
            return res.status(200).json({
                workOrder: presentWorkOrder(order, { includeFiles: true }),
            });
        }

        if (req.body?.lpo) {
            if (order.lpoMode !== 'received') {
                return res.status(400).json({ message: 'Switch to LPO received before adding an LPO' });
            }
            const lpoNo = cleanText(req.body.lpo.lpoNo, 80);
            const lpoDate = cleanText(req.body.lpo.lpoDate, 10);
            let lpoValue = cleanMoney(req.body.lpo.lpoValue);
            const quoteTotal = Number(order.value) || 0;
            if (!(lpoValue > 0) && quoteTotal > 0) lpoValue = quoteTotal;
            if (quoteTotal > 0 && lpoValue && Math.abs(lpoValue - quoteTotal) > 0.009) {
                return res.status(400).json({ message: 'LPO value must match the quotation total' });
            }
            if (lpoDate && lpoDate > dubaiDateKey()) {
                return res.status(400).json({ message: 'LPO date cannot be after today' });
            }
            if (!lpoNo || !/^\d{4}-\d{2}-\d{2}$/.test(lpoDate) || !(lpoValue > 0)) {
                return res.status(400).json({ message: 'LPO number, date and value are required' });
            }
            if (order.lpos.length >= 1) {
                return res.status(400).json({ message: 'This work order already has one LPO' });
            }
            const file = readAttachment(req.body.lpo.attachment, { required: true });
            if (file?.error) return res.status(400).json({ message: file.error });
            order.lpos.push({
                lpoNo,
                lpoDate,
                lpoValue,
                attachmentName: file?.name || '',
                attachmentMime: file?.mime || '',
                attachmentData: file?.data || '',
                attachmentBytes: file?.bytes || 0,
            });
            order.lpoNo = lpoNo;
            if (order.lpoAlert?.active) {
                order.lpoAlert.active = false;
                order.markModified('lpoAlert');
            }
            await closeLpoNotFilledNotice(order);
            if (order.attachmentPending) {
                order.attachmentPending = false;
                await closeAttachmentRequest(order, cleanText(req.user?.name, 120) || 'An employee');
            }
        }

        if (req.body?.invoice) {
            const invoiceNo = cleanText(req.body.invoice.invoiceNo, 80);
            const invoiceDate = cleanText(req.body.invoice.invoiceDate, 10);
            const invoiceValue = cleanMoney(req.body.invoice.value);
            if (!invoiceNo || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) || !(invoiceValue > 0)) {
                return res.status(400).json({ message: 'Invoice date, invoice number and value are required' });
            }
            if (!Array.isArray(order.invoices)) order.invoices = [];
            const already = order.invoices.reduce((sum, row) => sum + (Number(row.value) || 0), 0);
            const orderValue = Number(order.value) || 0;
            const nextTotal = Math.round((already + invoiceValue) * 100) / 100;
            if (orderValue > 0 && nextTotal - orderValue > 0.009) {
                return res.status(400).json({ message: 'Invoice total cannot exceed the work order value' });
            }
            order.invoices.push({ invoiceNo, invoiceDate, value: invoiceValue });
            order.markModified('invoices');
            order.invoicedAmount = nextTotal;
        }

        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'vendorId')) {
            const vendor = await resolveInventoryVendor(req.body.vendorId);
            if (!vendor) {
                return res.status(400).json({ message: 'Select a vendor that was added in Vendor Management' });
            }
            order.vendorId = vendor.id;
            order.vendorName = vendor.name;
        }

        let emailResult = null;
        if (req.body?.sendNotRequired) {
            order.lpoMode = 'not_required';
            const file = readAttachment(req.body.attachment, { required: true });
            if (!file || file.error) {
                return res.status(400).json({ message: file?.error || 'Attachment is required when LPO is not required' });
            }
            const note = cleanText(req.body?.supportingNote, 1000);
            if (!note) {
                return res.status(400).json({ message: 'Description is required when LPO is not required' });
            }
            if (!order.salespersonId) {
                return res.status(400).json({ message: 'This work order has no salesperson to notify' });
            }
            const senderName = cleanText(req.user?.name, 120) || 'An employee';
            const copy = await openLpoNotFilledNotice(order, senderName);
            try {
                emailResult = await sendWorkOrderLpoNotFilledEmail({
                    salespersonId: order.salespersonId,
                    workOrderNo: order.workOrderNo,
                    customer: order.customer,
                    senderName,
                    attachment: file,
                });
            } catch (error) {
                console.error('Error emailing salesperson about LPO:', error);
                emailResult = {
                    emailed: false,
                    email: '',
                    message: 'Email could not be sent. The notification was still saved.',
                };
            }
            if (order.attachmentPending) {
                order.attachmentPending = false;
                await closeAttachmentRequest(order, senderName);
            }
            order.supportingNote = note;
            order.supportingDocument = {
                name: file.name,
                mime: file.mime,
                data: file.data,
                bytes: file.bytes,
            };
            order.lpoAlert = {
                active: true,
                message: copy.message,
                sentAt: new Date(),
                sentByName: senderName,
                sentById: req.user?.id ? String(req.user.id) : '',
                attachmentName: file.name,
                attachmentMime: file.mime,
                attachmentData: file.data,
                attachmentBytes: file.bytes,
                emailed: Boolean(emailResult?.emailed),
                emailTo: emailResult?.email || '',
                forEmployeeIds: [order.salespersonId, order.salespersonEmployeeId].filter(Boolean).map(String),
            };
            order.markModified('lpoAlert');
        }

        await order.save();
        return res.status(200).json({
            workOrder: presentWorkOrder(order, { includeFiles: true }),
            emailSent: Boolean(emailResult?.emailed),
            emailMessage: emailResult?.message || '',
        });
    } catch (error) {
        console.error('Error updating work order:', error);
        return res.status(500).json({ message: 'Failed to update the work order' });
    }
};

function partyRows(rows, codeKey) {
    return rows
        .map((row) => ({
            id: String(row._id),
            name: String(row.name || '').trim(),
            code: String(row[codeKey] || '').trim(),
            status: row.status || 'Active',
        }))
        .filter((row) => row.name);
}

export const getWorkOrderCustomers = async (_req, res) => {
    try {
        const rows = await CrmCustomer.find().select('name customerCode status').sort({ name: 1 }).lean();
        return res.status(200).json({ customers: partyRows(rows, 'customerCode') });
    } catch (error) {
        console.error('Error listing work order customers:', error);
        return res.status(500).json({ message: 'Failed to load customers' });
    }
};

export const getWorkOrderVendors = async (_req, res) => {
    try {
        const rows = await InventoryVendor.find().select('name vendorCode status').sort({ name: 1 }).lean();
        return res.status(200).json({ vendors: partyRows(rows, 'vendorCode') });
    } catch (error) {
        console.error('Error listing work order vendors:', error);
        return res.status(500).json({ message: 'Failed to load vendors' });
    }
};

export const getWorkOrderSalespeople = async (_req, res) => {
    try {
        const employees = await EmployeeBasic.find({
            employeeId: { $ne: 'VEGA-HR-0000' },
            status: { $ne: 'Left User' },
            companyEmail: { $exists: true, $nin: [null, ''] },
        })
            .select('_id employeeId firstName lastName companyEmail')
            .sort({ firstName: 1, lastName: 1 })
            .lean();

        const salespeople = employees
            .filter((employee) => String(employee.companyEmail || '').trim())
            .map((employee) => ({
                id: String(employee._id),
                employeeId: String(employee.employeeId || ''),
                name: [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim(),
                companyEmail: String(employee.companyEmail || '').trim(),
            }))
            .filter((employee) => employee.name);

        return res.status(200).json({ salespeople });
    } catch (error) {
        console.error('Error listing work order salespeople:', error);
        return res.status(500).json({ message: 'Failed to load employees' });
    }
};
