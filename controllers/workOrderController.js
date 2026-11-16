import mongoose from 'mongoose';
import WorkOrder from '../models/WorkOrder.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { dubaiDateKey, formatWorkOrderNo, nextSequenceForYear, workOrderYear } from '../utils/workOrderNumber.js';
import { lpoNotFilledNotice, sendWorkOrderLpoNotFilledEmail } from '../utils/sendWorkOrderLpoEmail.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import DashboardAction from '../models/DashboardAction.js';

const TYPES = new Set(['Standalone', 'Main WO', 'Variation']);
const STATUSES = new Set(['Draft', 'Not Started', 'Awaiting LPO', 'In Progress', 'Fully Invoiced', 'Completed']);
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
        return res.status(200).json({
            workOrderNo: allocated.workOrderNo,
            createdOn: dubaiDateKey(),
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
            .select('-lpos.attachmentData -lpoAlert.attachmentData')
            .lean();
        return res.status(200).json({ workOrders });
    } catch (error) {
        console.error('Error listing work orders:', error);
        return res.status(500).json({ message: 'Failed to load work orders' });
    }
};

export const createWorkOrder = async (req, res) => {
    try {
        const customer = cleanText(req.body?.customer, 160);
        if (customer.length < 2) {
            return res.status(400).json({ message: 'Customer is required' });
        }

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
        let notRequiredFile = null;
        if (lpoMode === 'received') {
            const lpoNo = cleanText(req.body?.lpoNo, 80);
            const lpoDate = cleanText(req.body?.lpoDate, 10);
            const lpoValue = cleanMoney(req.body?.lpoValue);
            const file = readAttachment(req.body?.attachment, { required: !intentDraft });
            if (file?.error) return res.status(400).json({ message: file.error });
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
        } else if (lpoMode === 'not_required' && !intentDraft) {
            const file = readAttachment(req.body?.attachment, { required: true });
            if (!file || file.error) {
                return res.status(400).json({ message: file?.error || 'Attachment is required when LPO is not required' });
            }
            notRequiredFile = file;
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

        const status = intentDraft ? 'Draft' : 'Not Started';
        const lpoAlert = notRequiredFile
            ? {
                active: true,
                message: `${senderName} did not fill the LPO.`,
                sentAt: new Date(),
                sentByName: senderName,
                sentById: req.user?.id ? String(req.user.id) : '',
                attachmentName: notRequiredFile.name,
                attachmentMime: notRequiredFile.mime,
                attachmentData: notRequiredFile.data,
                attachmentBytes: notRequiredFile.bytes,
                emailed: false,
                emailTo: '',
                forEmployeeIds: [salespersonId, salespersonCode].filter(Boolean),
            }
            : undefined;

        const payload = {
            customer,
            quotationRef,
            quotationId: cleanText(req.body?.quotationId, 80),
            quotationDate: cleanText(req.body?.quotationDate, 10),
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
            ...(lpoAlert ? { lpoAlert } : {}),
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
                if (notRequiredFile) {
                    const copy = await openLpoNotFilledNotice(workOrder, senderName);
                    workOrder.lpoAlert.message = copy.message;
                    try {
                        const notice = await sendWorkOrderLpoNotFilledEmail({
                            salespersonId,
                            workOrderNo: workOrder.workOrderNo,
                            customer,
                            senderName,
                            attachment: notRequiredFile,
                        });
                        emailSent = Boolean(notice.emailed);
                        emailMessage = notice.message || '';
                        workOrder.lpoAlert.emailed = Boolean(notice.emailed);
                        workOrder.lpoAlert.emailTo = notice.email || '';
                    } catch (error) {
                        console.error('Work order LPO email failed:', error);
                        emailMessage = 'Email could not be sent. The notification was still saved.';
                    }
                    workOrder.markModified('lpoAlert');
                    await workOrder.save();
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
        return res.status(200).json({ workOrder: presentWorkOrder(workOrder, { includeFiles: true }) });
    } catch (error) {
        console.error('Error loading work order:', error);
        return res.status(500).json({ message: 'Failed to load the work order' });
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

        if (req.body?.lpoMode) {
            if (!LPO_MODES.has(req.body.lpoMode)) {
                return res.status(400).json({ message: 'Choose Required, Not required, or LPO received' });
            }
            order.lpoMode = req.body.lpoMode;
        }

        if (req.body?.lpo) {
            if (order.lpoMode !== 'received') {
                return res.status(400).json({ message: 'Switch to LPO received before adding an LPO' });
            }
            const lpoNo = cleanText(req.body.lpo.lpoNo, 80);
            const lpoDate = cleanText(req.body.lpo.lpoDate, 10);
            const lpoValue = cleanMoney(req.body.lpo.lpoValue);
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
