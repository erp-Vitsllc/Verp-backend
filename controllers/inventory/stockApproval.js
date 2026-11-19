import nodemailer from 'nodemailer';
import Flowchart from '../../models/Flowchart.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import { syncDashboardAction } from '../../utils/syncDashboard.js';

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

async function sendStockApprovalEmail({ officer, senderName, billNo, entryId }) {
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
            `${senderName || 'An employee'} submitted ${bill} and it is waiting for your approval.`,
            'Open Item Master to accept or reject it:',
            link,
            '',
            'VERP',
        ].join('\n'),
    });
}

export async function notifyStockApproval({ entry, officer, senderName }) {
    const bill = entry.billNo || 'Stock bill';
    const name = senderName || 'An employee';
    const path = `/inventory/item-master?stockEntry=${entry._id}`;
    if (officer?.empObjectId) {
        try {
            await syncDashboardAction({
                requestId: entry._id,
                requestType: 'Stock Approval',
                assignedTo: officer.empObjectId,
                status: 'Pending',
                requestedByName: name,
                extra1: `Stock approval · ${bill}`,
                extra2: `${name} submitted stock for your approval.`,
                extra3: JSON.stringify({ path }),
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
        });
    } catch (error) {
        console.error('Stock approval email failed:', error);
    }
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

export async function notifyDeliveryApproval({ delivery, officer, senderName }) {
    const label = delivery?.deliveryNo || 'a delivery order';
    const name = senderName || 'An employee';
    const path = '/inventory/delivery';
    if (officer?.empObjectId) {
        try {
            await syncDashboardAction({
                requestId: delivery._id,
                requestType: 'Delivery Approval',
                assignedTo: officer.empObjectId,
                status: 'Pending',
                requestedByName: name,
                extra1: `Delivery approval · ${label}`,
                extra2: `${name} submitted a delivery for your approval.`,
                extra3: JSON.stringify({ path }),
            });
        } catch (error) {
            console.error('Delivery approval notification failed:', error);
        }
    }
    try {
        await sendOfficerMail({
            officer,
            subject: `Delivery approval: ${label}`,
            text: [
                `Hello ${officer?.employeeName || 'Purchase Officer'},`,
                '',
                `${name} submitted ${label} and it is waiting for your approval.`,
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
