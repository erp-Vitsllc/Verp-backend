import nodemailer from 'nodemailer';
import Flowchart from '../../models/Flowchart.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import InventoryStockEntry from '../../models/inventory/InventoryStockEntry.js';
import { syncDashboardAction } from '../../utils/syncDashboard.js';
import { finishEmployeeWorkflowTasks, requesterNameForActor } from '../../utils/employeeWorkflowTask.js';

function cleanEmail(value) {
    return String(value || '').trim().toLowerCase();
}

export async function findPurchaseOfficer() {
    const row = await Flowchart.findOne({ category: 'purchaseofficer', status: 'Active' })
        .sort({ updatedAt: -1 })
        .lean();
    if (!row) return null;
    let companyEmail = cleanEmail(row.companyEmail);
    if (!companyEmail && row.empObjectId) {
        const employee = await EmployeeBasic.findById(row.empObjectId).select('companyEmail').lean();
        companyEmail = cleanEmail(employee?.companyEmail);
    }
    return { ...row, companyEmail };
}

export async function actorIsManagement(req) {
    const row = await Flowchart.findOne({ category: 'management', status: 'Active' })
        .sort({ updatedAt: -1 })
        .lean();
    return actorIsPurchaseOfficer(req, row);
}

export function actorIsPurchaseOfficer(req, officer) {
    if (!officer) return false;
    const actorEmployee = String(req.user?.employeeObjectId || '');
    const actorCode = String(req.user?.employeeId || '').trim().toLowerCase();
    if (actorEmployee && officer.empObjectId && actorEmployee === String(officer.empObjectId)) return true;
    if (actorCode && officer.employeeId && actorCode === String(officer.employeeId).trim().toLowerCase()) return true;
    return false;
}

function appOrigin() {
    return String(process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');
}

async function sendStockApprovalEmail({ officer, senderName, billNo, entryId, summary = '' }) {
    const email = cleanEmail(officer?.companyEmail);
    if (!email || !email.includes('@')) return;
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (!user || !pass) return;
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.office365.com',
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: { user, pass },
    });
    const bill = billNo || 'a stock bill';
    const link = `${appOrigin()}/inventory/item-master?stockEntry=${entryId}`;
    await transporter.sendMail({
        from: `"VERP" <${user}>`,
        to: email,
        subject: `Stock approval: ${bill}`,
        text: [
            `Hello ${officer.employeeName || 'Purchase Officer'},`,
            '',
            summary || `${senderName || 'An employee'} submitted ${bill} and it is waiting for your approval.`,
            'Open Item Master to accept or reject it:',
            link,
            '',
            'VERP',
        ].join('\n'),
    });
}

export const INVENTORY_BILL_DRAFT = 'Inventory Bill Draft';
export const DRAFT_BILL_MESSAGE = 'Bill you created is on draft. Submit it.';

function isRecordId(value) {
    return /^[a-fA-F0-9]{24}$/.test(String(value || '').trim());
}

function billLines(entry) {
    if (entry?.editPending && Array.isArray(entry?.pendingEdit?.lines) && entry.pendingEdit.lines.length) {
        return entry.pendingEdit.lines;
    }
    return Array.isArray(entry?.lines) ? entry.lines : [];
}

/** Item name and item code for a stock bill, in line order. */
export function presentBillItems(entry, codeByItemId = new Map()) {
    const items = [];
    const seen = new Set();
    for (const line of billLines(entry)) {
        const name = String(line?.itemName || line?.description || line?.modelNumber || '').trim();
        const code = String(codeByItemId.get(String(line?.itemId || '')) || '').trim();
        const key = `${name.toLowerCase()}|${code.toLowerCase()}`;
        if ((!name && !code) || seen.has(key)) continue;
        seen.add(key);
        items.push({ name, code });
    }
    return { items };
}

/** Items on each Inventory Bill Draft, keyed by the stock entry id. */
export async function billItemsByRequestId(actions = []) {
    const ids = [...new Set(
        (actions || [])
            .filter((action) => String(action?.requestType || '') === INVENTORY_BILL_DRAFT)
            .map((action) => String(action?.requestId || '').trim())
            .filter(isRecordId),
    )];
    const map = new Map();
    if (!ids.length) return map;
    const entries = await InventoryStockEntry.find({ _id: { $in: ids } })
        .select('editPending pendingEdit.lines.itemId pendingEdit.lines.itemName pendingEdit.lines.description pendingEdit.lines.modelNumber lines.itemId lines.itemName lines.description lines.modelNumber')
        .lean();
    const itemIds = [...new Set(entries.flatMap((entry) => (
        billLines(entry).map((line) => String(line?.itemId || '')).filter(isRecordId)
    )))];
    const catalog = itemIds.length
        ? await InventoryItem.find({ _id: { $in: itemIds } }).select('itemCode').lean()
        : [];
    const codeByItemId = new Map(catalog.map((row) => [String(row._id), String(row.itemCode || '').trim()]));
    for (const entry of entries) map.set(String(entry._id), presentBillItems(entry, codeByItemId));
    return map;
}

export async function notifyStockApproval({ entry, officer, senderName, kind = 'submit' }) {
    const bill = entry.billNo || 'Stock bill';
    const name = senderName || 'An employee';
    const edited = kind === 'edit';
    const summary = edited
        ? `${name} edited this bill and it is waiting for your approval.`
        : `${name} submitted this bill for your approval.`;
    if (officer?.empObjectId) {
        try {
            await syncDashboardAction({
                requestId: entry._id,
                requestType: INVENTORY_BILL_DRAFT,
                assignedTo: officer.empObjectId,
                status: 'Pending',
                requestedByName: name,
                subjectName: bill,
                extra1: edited ? `Bill edit · ${bill}` : bill,
                extra2: summary,
                extra3: JSON.stringify({ path: `/inventory/bills?bill=${entry._id}` }),
            });
        } catch (error) {
            console.error('Stock approval notification failed:', error);
        }
    }
    try {
        await sendStockApprovalEmail({
            officer,
            senderName: name,
            billNo: entry.billNo,
            entryId: entry._id,
            summary,
        });
    } catch (error) {
        console.error('Stock approval email failed:', error);
    }
}

export async function notifyDraftBill({ entry, actorId }) {
    if (!entry?._id) return;
    const assignee = entry.createdBy || actorId;
    if (!assignee) return;
    const bill = entry.billNo || 'Draft bill';
    const requestedByName = await requesterNameForActor(assignee);
    try {
        await syncDashboardAction({
            requestId: entry._id,
            requestType: INVENTORY_BILL_DRAFT,
            assignedTo: assignee,
            status: 'Pending',
            requestedByName,
            subjectName: bill,
            extra1: bill,
            extra2: DRAFT_BILL_MESSAGE,
            extra3: JSON.stringify({ path: `/inventory/bills?bill=${entry._id}` }),
        });
    } catch (error) {
        console.error('Draft bill notification failed:', error);
    }
}

export async function closeDraftBill(entryId, actorEmployeeId, outcome = 'Approved') {
    if (!entryId) return;
    const rejected = String(outcome || '') === 'Rejected';
    try {
        const actorName = await requesterNameForActor(actorEmployeeId);
        await syncDashboardAction({
            requestId: entryId,
            requestType: INVENTORY_BILL_DRAFT,
            status: rejected ? 'Rejected' : 'Approved',
            actionedBy: actorEmployeeId || undefined,
        });
        await finishEmployeeWorkflowTasks(entryId, INVENTORY_BILL_DRAFT, {
            taskStatus: rejected ? 'Rejected' : 'Completed',
            event: rejected ? 'Rejected' : 'Completed',
            detail: rejected ? 'The bill was rejected.' : 'The bill is no longer in draft.',
            actorName,
        });
    } catch (error) {
        console.error('Could not close the draft bill notification:', error);
    }
}

/** Open a task for each of this viewer's draft bills, and leave submitted bills alone. */
export async function syncViewerDraftBills(rows, viewerUserId) {
    const drafts = (rows || []).filter((row) => (
        row?.status === 'draft'
        && viewerUserId
        && String(row.createdBy || '') === String(viewerUserId)
    ));
    await Promise.all(drafts.map((row) => notifyDraftBill({ entry: row, actorId: viewerUserId })));
}

export async function closeStockApproval(entryId, status, actorEmployeeId) {
    if (!entryId) return;
    try {
        await syncDashboardAction({
            requestId: entryId,
            requestType: 'Stock Approval',
            status,
            actionedBy: actorEmployeeId || undefined,
        });
    } catch (error) {
        console.error('Could not close the stock approval notification:', error);
    }
}

async function sendOfficerMail({ officer, subject, text }) {
    const email = cleanEmail(officer?.companyEmail);
    if (!email || !email.includes('@')) return;
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (!user || !pass) return;
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.office365.com',
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: { user, pass },
    });
    await transporter.sendMail({
        from: `"VERP" <${user}>`,
        to: email,
        subject,
        text,
    });
}

export async function notifyDeliveryApproval({ delivery, officer, senderName, kind = 'submit' }) {
    const label = delivery?.deliveryNo || 'a delivery order';
    const name = senderName || 'An employee';
    const path = '/inventory/delivery';
    const edited = kind === 'edit';
    const summary = edited
        ? `${name} edited ${label} and it is waiting for your approval.`
        : `${name} submitted a delivery for your approval.`;
    if (officer?.empObjectId) {
        try {
            await syncDashboardAction({
                requestId: delivery._id,
                requestType: 'Delivery Approval',
                assignedTo: officer.empObjectId,
                status: 'Pending',
                requestedByName: name,
                extra1: edited ? `Delivery edit · ${label}` : `Delivery approval · ${label}`,
                extra2: summary,
                extra3: JSON.stringify({ path }),
            });
        } catch (error) {
            console.error('Delivery approval notification failed:', error);
        }
    }
    try {
        await sendOfficerMail({
            officer,
            subject: edited ? `Delivery edit approval: ${label}` : `Delivery approval: ${label}`,
            text: [
                `Hello ${officer?.employeeName || 'Purchase Officer'},`,
                '',
                summary,
                'Open Delivery to accept or reject it:',
                `${appOrigin()}${path}`,
                '',
                'VERP',
            ].join('\n'),
        });
    } catch (error) {
        console.error('Delivery approval email failed:', error);
    }
}

export async function closeDeliveryApproval(deliveryId, status, actorEmployeeId) {
    if (!deliveryId) return;
    try {
        await syncDashboardAction({
            requestId: deliveryId,
            requestType: 'Delivery Approval',
            status,
            actionedBy: actorEmployeeId || undefined,
        });
    } catch (error) {
        console.error('Could not close the delivery approval notification:', error);
    }
}
