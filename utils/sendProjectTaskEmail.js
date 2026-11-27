import nodemailer from 'nodemailer';
import DashboardAction from '../models/DashboardAction.js';
import TaskManagerTask from '../models/TaskManagerTask.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { oneTaskNumber } from './taskNumberStore.js';
import { workOrderDetailsPath } from './workOrderPath.js';

function appOrigin() {
    return String(process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function listedProjectTaskNumber(workOrderNo, taskNumber) {
    const order = String(workOrderNo || '').trim();
    const number = String(taskNumber || '').trim();
    const parsed = /^TSK-\d{2}-(\d+)$/i.exec(number);
    if (!order) return number;
    if (!parsed) return number || order;
    const raw = parsed[1];
    const tail = raw.length > 4 ? raw.slice(-4) : raw.padStart(4, '0');
    return `${order}-${tail}`;
}

function dubaiDateLabel(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Dubai',
    }).format(date);
}

function projectTaskMessage({
    notificationTitle,
    taskNumber,
    taskStatus,
    taskName,
    taskDescription,
    createdDate,
    assignedBy,
    assignedTo,
    updatedBy,
    updatedDate,
    userRemarks,
    taskUrl,
}) {
    return [
        `**${notificationTitle}**`,
        '',
        `**Task No:** ${taskNumber}`,
        `**Status:** ${taskStatus}`,
        '',
        `**Task Name:** ${taskName}`,
        `**Task Description:** ${taskDescription}`,
        `**Created Date:** ${createdDate}`,
        `**Assigned By:** ${assignedBy}`,
        `**Assigned To:** ${assignedTo}`,
        '',
        '---',
        '',
        '**Latest Update**',
        '',
        `**Updated By:** ${updatedBy}`,
        `**Updated Date:** ${updatedDate}`,
        `**Remarks:** ${userRemarks}`,
        '',
        `[Open Task in ERP](${taskUrl})`,
        '',
        '---',
        '',
        'VEGA Digital IT Solutions LLC',
        'Automated ERP Task Notification',
    ].join('\n');
}

function projectTaskHtml(fields) {
    const row = (label, value) => `<p style="margin:0 0 6px;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`;
    return [
        `<p style="margin:0 0 16px;"><strong>${escapeHtml(fields.notificationTitle)}</strong></p>`,
        row('Task No', fields.taskNumber),
        row('Status', fields.taskStatus),
        '<p style="margin:12px 0;"></p>',
        row('Task Name', fields.taskName),
        row('Task Description', fields.taskDescription),
        row('Created Date', fields.createdDate),
        row('Assigned By', fields.assignedBy),
        row('Assigned To', fields.assignedTo),
        '<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />',
        '<p style="margin:0 0 10px;"><strong>Latest Update</strong></p>',
        row('Updated By', fields.updatedBy),
        row('Updated Date', fields.updatedDate),
        row('Remarks', fields.userRemarks),
        `<p style="margin:16px 0;"><a href="${escapeHtml(fields.taskUrl)}">Open Task in ERP</a></p>`,
        '<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />',
        '<p style="margin:0;color:#64748b;">VEGA Digital IT Solutions LLC<br />Automated ERP Task Notification</p>',
    ].join('');
}

function mailTransport() {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (!user || !pass) return null;
    return {
        user,
        transporter: nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.office365.com',
            port: Number(process.env.SMTP_PORT || 587),
            secure: false,
            auth: { user, pass },
        }),
    };
}

async function latestWorkOrderTask(workOrderId) {
    const id = String(workOrderId || '').trim();
    if (!/^[a-f\d]{24}$/i.test(id)) return null;
    const action = await DashboardAction.findOne({
        requestId: id,
        status: 'Pending',
        requestType: /^Work Order /,
    }).sort({ updatedAt: -1 }).select('taskNumber requestedByName requestedDate status').lean();
    if (!action) return null;
    let stored = String(action.taskNumber || '').trim();
    if (!stored) stored = await oneTaskNumber({ actionId: String(action._id), requestDate: action.requestedDate || new Date() });
    const task = await TaskManagerTask.findOne({ sourceDashboardActionId: action._id })
        .sort({ updatedAt: -1 })
        .select('taskNumber status')
        .lean();
    if (task && stored && !String(task.taskNumber || '').trim()) {
        await TaskManagerTask.updateOne({ _id: task._id }, { $set: { taskNumber: stored } });
    }
    return {
        actionId: String(action._id),
        taskNumber: String(task?.taskNumber || stored || '').trim(),
        status: task?.status || action.status || 'Pending',
        requestedByName: action.requestedByName || '',
        createdAt: action.requestedDate || new Date(),
    };
}

/** Every work-order email uses the same task notice. */
export async function sendWorkOrderNoticeEmail({
    employee,
    workOrderId,
    workOrderNo,
    notificationTitle,
    taskName,
    taskDescription,
    remarks,
    assignedBy = '',
    section = 'overview',
    attachments,
    missingEmailMessage = 'The employee has no company email. The notification was still saved.',
}) {
    if (!employee) return { emailed: false, email: '', message: 'No employee is set for this notice.' };
    const { email } = resolveEmployeeEmail(employee);
    if (!email) return { emailed: false, email: '', message: missingEmailMessage };
    const mail = mailTransport();
    if (!mail) return { emailed: false, email, message: 'Email is not configured. The notification was still saved.' };
    const saved = await latestWorkOrderTask(workOrderId);
    const assigneeName = [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() || 'Employee';
    const sender = assignedBy || saved?.requestedByName || assigneeName;
    const createdDate = dubaiDateLabel(saved?.createdAt || new Date());
    const shownNumber = listedProjectTaskNumber(workOrderNo, saved?.taskNumber || '');
    const taskUrl = saved?.actionId
        ? `${appOrigin()}/task-manager/${encodeURIComponent(saved.actionId)}`
        : `${appOrigin()}${workOrderDetailsPath(workOrderId, section)}`;
    const title = notificationTitle || taskName || 'Work order task';
    const fields = {
        notificationTitle: title,
        taskNumber: shownNumber || workOrderNo || '',
        taskStatus: saved?.status || 'Pending',
        taskName: taskName || title,
        taskDescription: taskDescription || remarks || title,
        createdDate,
        assignedBy: sender,
        assignedTo: assigneeName,
        updatedBy: sender,
        updatedDate: createdDate,
        userRemarks: remarks || taskDescription || title,
        taskUrl,
    };
    await mail.transporter.sendMail({
        from: `"VERP" <${mail.user}>`,
        to: email,
        subject: title,
        text: projectTaskMessage(fields),
        html: projectTaskHtml(fields),
        attachments: attachments || [],
    });
    return { emailed: true, email, message: `Email sent to ${email}.` };
}

/** Email the project coordinator when the root project task is created. */
export async function sendProjectCoordinatorTaskEmail({
    employee,
    order,
    taskName,
    assignedBy,
    assignedTo,
    remarks,
}) {
    return sendWorkOrderNoticeEmail({
        employee,
        workOrderId: order?._id,
        workOrderNo: order?.workOrderNo,
        notificationTitle: 'New work order created',
        taskName: taskName || 'New work order created — Work order create',
        taskDescription: String(order?.description || '').trim() || `Project task for ${order?.workOrderNo || 'the work order'}.`,
        remarks: remarks || `Created and assigned to ${assignedTo || 'the project coordinator'}.`,
        assignedBy: assignedBy || assignedTo || '',
        section: 'overview',
        missingEmailMessage: 'Project coordinator has no company email. The task was still saved.',
    });
}
