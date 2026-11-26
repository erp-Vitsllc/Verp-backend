import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { workOrderDetailsPath } from './workOrderPath.js';

function personName(employee) {
    return [employee?.firstName, employee?.lastName].filter(Boolean).join(' ').trim() || 'there';
}

export function lpoNotFilledNotice({ senderName, workOrderNo, customer }) {
    const who = senderName || 'An employee';
    const job = customer ? ` for ${customer}` : '';
    const number = workOrderNo || 'this work order';
    return {
        message: `${who} did not fill the LPO on ${number}${job}. Number, date and value were left empty.`,
        subject: `${number}: LPO was not filled`,
        extra1: `LPO was not filled on ${number}`,
        extra2: `${customer || 'Work order'} — number, date and value were left empty.`,
    };
}

export function salespersonFollowUpNotice(workOrderNo) {
    const number = workOrderNo || 'this work order';
    const message = `Add the supporting document and note on ${number}`;
    return {
        message,
        subject: `${number}: supporting document needed`,
        extra1: message,
        extra2: `Open ${number}, add the supporting document and note, then click Create.`,
    };
}

export function coordinatorFollowUpNotice(workOrderNo) {
    const number = workOrderNo || 'this work order';
    const message = `Create work order ${number}`;
    return {
        message,
        subject: `${number}: create the work order`,
        extra1: message,
        extra2: `Open ${number} and click Create. Change the LPO option first if the fields should be different.`,
    };
}

export function lpoAttachmentNotice(workOrderNo) {
    const number = workOrderNo || 'this work order';
    const message = `Upload attachment to the work order ${number}`;
    return {
        message,
        subject: message,
        extra1: message,
        extra2: `Open ${number} and upload the attachment in LPO Details.`,
    };
}

function appOrigin() {
    return String(process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export async function sendWorkOrderAttachmentRequestEmail({
    employee,
    workOrderNo,
    workOrderId,
}) {
    const notice = lpoAttachmentNotice(workOrderNo);
    if (!employee) {
        return { emailed: false, email: '', message: notice.message, notice };
    }
    const { email } = resolveEmployeeEmail(employee);
    if (!email) {
        return {
            emailed: false,
            email: '',
            message: 'Project coordinator has no company email. The notification was still saved.',
            notice,
        };
    }
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (!user || !pass) {
        return {
            emailed: false,
            email,
            message: 'Email is not configured. The notification was still saved.',
            notice,
        };
    }
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.office365.com',
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: { user, pass },
    });
    const name = [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() || 'Project Coordinator';
    const link = `${appOrigin()}${workOrderDetailsPath(workOrderId, 'lpo')}`;
    await transporter.sendMail({
        from: `"VERP" <${user}>`,
        to: email,
        subject: notice.subject,
        text: [
            `Hello ${name},`,
            '',
            notice.message,
            'Open the work order and upload the attachment in LPO Details:',
            link,
            '',
            'VERP',
        ].join('\n'),
    });
    return { emailed: true, email, message: `Email sent to ${email}.`, notice };
}

export async function sendWorkOrderFollowUpEmail({ employee, notice, workOrderId, section = 'lpo' }) {
    if (!employee) {
        return { emailed: false, email: '', message: notice?.message || 'No employee is set for this notice.' };
    }
    const { email } = resolveEmployeeEmail(employee);
    if (!email) {
        return {
            emailed: false,
            email: '',
            message: 'The employee has no company email. The notification was still saved.',
        };
    }
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (!user || !pass) {
        return {
            emailed: false,
            email,
            message: 'Email is not configured. The notification was still saved.',
        };
    }
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.office365.com',
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: { user, pass },
    });
    const name = personName(employee);
    const link = `${appOrigin()}${workOrderDetailsPath(workOrderId, section)}`;
    await transporter.sendMail({
        from: `"VERP" <${user}>`,
        to: email,
        subject: notice.subject,
        text: [
            `Hello ${name},`,
            '',
            notice.message,
            notice.extra2,
            link,
            '',
            'VERP',
        ].join('\n'),
    });
    return { emailed: true, email, message: `Email sent to ${email}.` };
}

export async function sendWorkOrderLpoNotFilledEmail({
    salespersonId,
    workOrderNo,
    customer,
    senderName,
    attachment,
}) {
    if (!salespersonId) {
        return { emailed: false, email: '', message: 'No salesperson is set on this work order.' };
    }

    const employee = await EmployeeBasic.findById(salespersonId)
        .select('firstName lastName companyEmail workEmail status profileStatus employeeId primaryReportee')
        .populate('primaryReportee', 'companyEmail workEmail status profileStatus')
        .lean();

    if (!employee) {
        return { emailed: false, email: '', message: 'Salesperson was not found.' };
    }

    const { email } = resolveEmployeeEmail(employee);
    if (!email) {
        return {
            emailed: false,
            email: '',
            message: 'Salesperson has no company email. The notification was still saved.',
        };
    }

    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (!user || !pass) {
        return {
            emailed: false,
            email,
            message: 'Email is not configured. The notification was still saved.',
        };
    }

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.office365.com',
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: { user, pass },
    });

    const name = personName(employee);
    const notice = lpoNotFilledNotice({ senderName, workOrderNo, customer });
    await transporter.sendMail({
        from: `"VERP" <${user}>`,
        to: email,
        subject: notice.subject,
        text: [
            `Hello ${name},`,
            '',
            notice.message,
            'LPO was marked Not required. The attachment is included with this email.',
            '',
            'VERP',
        ].join('\n'),
        attachments: attachment?.buffer
            ? [{
                filename: attachment.name || 'attachment',
                content: attachment.buffer,
                contentType: attachment.mime || 'application/octet-stream',
            }]
            : [],
    });

    return { emailed: true, email, message: `Email sent to ${email}.` };
}
