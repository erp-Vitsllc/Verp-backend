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
import { finishEmployeeWorkflowTasks } from '../utils/employeeWorkflowTask.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';
import { fetchZohoEstimateByNumber, fetchZohoEstimatePdf } from '../services/zohoService.js';
import {
    applyQuotationSnapshot,
    quotationChanges,
    savedQuotation,
    snapshotFromEstimate,
} from '../utils/workOrderQuotationSync.js';

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
    if (row.quotationFile) {
        const file = { ...row.quotationFile };
        delete file.data;
        row.quotationFile = file;
    }
    return row;
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
            .select('-lpos.attachmentData -lpoAlert.attachmentData -budgets -quotationFile.data')
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

export const getWorkOrder = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Work order was not found' });
        }
        const workOrder = await WorkOrder.findById(id).lean();
        if (!workOrder) return res.status(404).json({ message: 'Work order was not found' });
        const presented = presentWorkOrder(workOrder, { includeFiles: true });
        presented.viewerCanCompleteLpo = Boolean(workOrder.lpoFollowUp) && await canCompleteLpoFollowUp(req, workOrder);
        return res.status(200).json({ workOrder: presented });
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

        if (req.body?.completeLpoFollowUp) {
            if (!order.lpoFollowUp) {
                return res.status(400).json({ message: 'This work order is not waiting on an LPO action' });
            }
            if (!(await canCompleteLpoFollowUp(req, order))) {
                const who = order.lpoFollowUp === 'coordinator' ? 'project coordinator' : 'salesperson';
                return res.status(403).json({ message: `The ${who} completes this step` });
            }
            const mode = LPO_MODES.has(req.body?.lpoMode) ? req.body.lpoMode : order.lpoMode;
            const actorName = cleanText(req.user?.name, 120) || 'An employee';
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

        if (req.body?.lpoMode) {
            if (!LPO_MODES.has(req.body.lpoMode)) {
                return res.status(400).json({ message: 'Choose Required, Not required, or LPO received' });
            }
            order.lpoMode = req.body.lpoMode;
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
