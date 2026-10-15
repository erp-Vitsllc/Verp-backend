import nodemailer from 'nodemailer';
import AssetItem from '../models/AssetItem.js';
import AssetHistory from '../models/AssetHistory.js';
import DashboardAction from '../models/DashboardAction.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeeContact from '../models/EmployeeContact.js';
import { getResolvedAssetControllerEmployee, isFleetVehicleAsset } from './assetApprovalHelpers.js';
import { isUserInFlowchart } from './getDepartmentHOD.js';
import { applyAcceptedAssignmentState } from './assetOperationalFlags.js';
import { closeCompletedAssignmentNotificationsForAssets } from './closeCompletedAssignmentNotifications.js';
import { sendErpEmail } from './emailDispatch.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { isValidWhatsAppPhone, normalizeWhatsAppPhone } from './normalizeWhatsAppPhone.js';
import { sendTextMessage } from '../services/whatsappService.js';

export const TOOLS_ACK_ESCALATION_DAYS = 7;
export const TOOLS_ACK_ESCALATION_TYPE = 'Asset Assignment Escalation';
export const TOOLS_ACK_ESCALATION_MESSAGE =
    'This user is not responding. You can force assign him or return the assignment.';

const refId = (value) => {
    if (!value) return null;
    if (typeof value === 'object') return value._id || value.id || null;
    return value;
};

export function wholeDaysSince(dateValue, now = new Date()) {
    const start = new Date(dateValue);
    if (Number.isNaN(start.getTime())) return -1;
    const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const nowUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor((nowUtc - startUtc) / 86400000);
}

export function captureToolsAssignmentPrior(item) {
    if (!item) return null;
    return {
        status: item.status || 'Unassigned',
        acceptanceStatus: item.acceptanceStatus || null,
        assignedTo: refId(item.assignedTo),
        assignedToType: item.assignedToType || null,
        assignedCompany: refId(item.assignedCompany),
        assignedBy: refId(item.assignedBy),
        assignmentType: item.assignmentType || null,
        assignedDays: item.assignedDays ?? null,
        assignedDate: item.assignedDate || null,
        temporaryEndDate: item.temporaryEndDate || null,
        temporaryReminderSentAt: item.temporaryReminderSentAt || null,
        temporaryExpiredSentAt: item.temporaryExpiredSentAt || null,
        ownership: item.ownership || null,
        acceptedBy: refId(item.acceptedBy),
        onLeaveActive: item.onLeaveActive === true,
        onServiceActive: item.onServiceActive === true,
    };
}

export function buildToolsAssignmentAckRecord(prior, requestedAt = new Date()) {
    return {
        requestedAt,
        escalationActive: false,
        escalationNotifiedAt: null,
        prior: prior || null,
    };
}

export function attachToolsAssignmentAck(item, prior, requestedAt = new Date()) {
    if (!item) return;
    const existing =
        item.pendingActionDetails && typeof item.pendingActionDetails === 'object'
            ? { ...item.pendingActionDetails }
            : {};
    existing.toolsAssignmentAck = buildToolsAssignmentAckRecord(prior, requestedAt);
    item.pendingActionDetails = existing;
    item.markModified?.('pendingActionDetails');
}

function isToolsEmployeeAckPending(item) {
    if (!item) return false;
    if (item.pendingAction) return false;
    if (String(item.acceptanceStatus || '') !== 'Pending') return false;
    const status = String(item.status || '');
    if (status !== 'Pending' && status !== 'Assigned') return false;
    if (String(item.assignedToType || '') === 'Company') return false;
    if (!item.assignedTo) return false;
    if (item.pendingActionDetails?.vehicleHandoverFlow) return false;
    if (isFleetVehicleAsset(item)) return false;
    return true;
}

async function resolveRequestedAt(item) {
    const stored = item?.pendingActionDetails?.toolsAssignmentAck?.requestedAt;
    if (stored) return new Date(stored);
    const assigneeId = refId(item?.assignedTo);
    const history = await AssetHistory.findOne({
        assetId: item._id,
        action: 'Assigned',
        ...(assigneeId ? { assignedTo: assigneeId } : {}),
    })
        .sort({ date: -1, createdAt: -1 })
        .select('date createdAt')
        .lean();
    return history?.date || history?.createdAt || null;
}

async function inferPriorFromHistory(item) {
    const assigneeId = String(refId(item?.assignedTo) || '');
    const rows = await AssetHistory.find({ assetId: item._id })
        .sort({ date: -1, createdAt: -1 })
        .limit(8)
        .select('action date assignedTo assignedToType details')
        .lean();
    const previous = rows.find((row) => {
        if (row.action !== 'Accepted' && row.action !== 'Assigned') return false;
        const to = String(refId(row.assignedTo) || refId(row.details?.assignedTo) || '');
        return to && to !== assigneeId;
    });
    if (!previous) return null;
    const details = previous.details && typeof previous.details === 'object' ? previous.details : {};
    return {
        status: 'Assigned',
        acceptanceStatus: 'Accepted',
        assignedTo: refId(previous.assignedTo) || refId(details.assignedTo),
        assignedToType: previous.assignedToType || details.assignedToType || 'Employee',
        assignedCompany: refId(details.assignedCompany),
        assignedBy: refId(details.assignedBy),
        assignmentType: details.assignmentType || null,
        assignedDays: details.assignedDays ?? null,
        assignedDate: details.assignedDate || previous.date || null,
        temporaryEndDate: details.temporaryEndDate || null,
        temporaryReminderSentAt: null,
        temporaryExpiredSentAt: null,
        ownership: details.ownership || null,
        acceptedBy: refId(details.acceptedBy),
        onLeaveActive: details.onLeaveActive === true,
        onServiceActive: details.onServiceActive === true,
    };
}

function mailer() {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return {
        emailUser,
        transporter: nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        }),
    };
}

async function emailAssetController(controller, asset, assignee) {
    const to = String(controller?.companyEmail || '').trim();
    if (!to) {
        console.warn(
            `[ToolsAckEscalation] Asset controller ${controller?.employeeId || controller?._id} has no company email.`,
        );
        return false;
    }
    const transport = mailer();
    if (!transport) {
        console.error('[ToolsAckEscalation] Email credentials are not configured.');
        return false;
    }
    const assetName = asset?.name || 'Asset';
    const assetCode = asset?.assetId || '';
    const person =
        `${assignee?.firstName || ''} ${assignee?.lastName || ''}`.trim() ||
        assignee?.employeeId ||
        'The employee';
    const link = `${emailFrontendUrl().replace(/\/+$/, '')}/HRM/Asset/details/${asset._id}`;
    const subject = `No response on asset assignment: ${assetName}${assetCode ? ` (${assetCode})` : ''}`;
    const html = `
        <p>${person} has not responded for ${TOOLS_ACK_ESCALATION_DAYS} days on <strong>${assetName}</strong>${assetCode ? ` (${assetCode})` : ''}.</p>
        <p>${TOOLS_ACK_ESCALATION_MESSAGE}</p>
        <p><a href="${link}">Open the asset</a></p>
    `;
    const result = await sendErpEmail({
        transporter: transport.transporter,
        from: `"VeRP Notifications" <${transport.emailUser}>`,
        to: [to],
        subject,
        html,
        dedupeKey: `tools-ack-escalation:${asset._id}`,
        module: 'Asset',
        emailType: TOOLS_ACK_ESCALATION_TYPE,
        recordId: String(asset._id),
    });
    return result?.sent === true || result?.reason === 'duplicate';
}

async function upsertEscalationBell(controller, asset, assignee) {
    if (!controller?._id) return;
    const person =
        `${assignee?.firstName || ''} ${assignee?.lastName || ''}`.trim() ||
        assignee?.employeeId ||
        'Employee';
    await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            requestType: TOOLS_ACK_ESCALATION_TYPE,
            status: 'Pending',
        },
        {
            $set: {
                assignedTo: controller._id,
                assignedToEmpId: controller.employeeId || '',
                requestId: asset._id,
                requestType: TOOLS_ACK_ESCALATION_TYPE,
                status: 'Pending',
                subjectEmployeeId: assignee?.employeeId || '',
                subjectName: person,
                requestedByName: 'Asset system',
                extra1: `${asset.assetId || ''} — ${asset.name || ''}`.trim(),
                extra2: TOOLS_ACK_ESCALATION_MESSAGE,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

export async function closeToolsAssignmentEscalation(assetId, actionedBy = null, comment = 'Closed') {
    if (!assetId) return;
    await DashboardAction.updateMany(
        {
            requestId: assetId,
            requestType: TOOLS_ACK_ESCALATION_TYPE,
            status: 'Pending',
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment,
                ...(actionedBy ? { actionedBy } : {}),
            },
        },
    ).catch(() => null);
}

export async function userIsToolsAssetController(req) {
    if (!req?.user) return false;
    const inFlow = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
    if (inFlow) return true;
    const controller = await getResolvedAssetControllerEmployee();
    const currentId = req.user?.employeeObjectId ? String(req.user.employeeObjectId) : '';
    if (controller?._id && currentId && String(controller._id) === currentId) return true;
    const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, '');
    if (controller?.employeeId && req.user?.employeeId && norm(controller.employeeId) === norm(req.user.employeeId)) {
        return true;
    }
    return false;
}

async function assertEscalationReady(item) {
    if (!isToolsEmployeeAckPending(item)) {
        return { ok: false, message: 'This asset is not waiting on an employee assignment response.' };
    }
    const requestedAt = await resolveRequestedAt(item);
    const elapsed = requestedAt ? wholeDaysSince(requestedAt) : -1;
    const alreadyFlagged = item.pendingActionDetails?.toolsAssignmentAck?.escalationActive === true;
    if (!alreadyFlagged && elapsed < TOOLS_ACK_ESCALATION_DAYS) {
        return {
            ok: false,
            message: `Force assign and return are available after ${TOOLS_ACK_ESCALATION_DAYS} days without a response.`,
        };
    }
    return { ok: true, requestedAt, elapsed };
}

function clearAckMeta(item) {
    const details =
        item.pendingActionDetails && typeof item.pendingActionDetails === 'object'
            ? { ...item.pendingActionDetails }
            : {};
    delete details.toolsAssignmentAck;
    delete details.serviceReassignContext;
    delete details.parkingReassignContext;
    item.pendingActionDetails = Object.keys(details).length ? details : null;
    item.markModified('pendingActionDetails');
}

export async function notifyForceAssignedEmployee(asset) {
    const assignee = asset?.assignedTo;
    const assetName = asset?.name || 'This asset';
    const text = `${assetName} is assigned to you forcefully, for further details contact asset controller`;
    const companyEmail = String(assignee?.companyEmail || '').trim();
    if (companyEmail) {
        const transport = mailer();
        if (!transport) return { channel: 'email', sent: false, reason: 'email_not_configured' };
        const result = await sendErpEmail({
            transporter: transport.transporter,
            from: `"VeRP Notifications" <${transport.emailUser}>`,
            to: [companyEmail],
            subject: `${assetName} is assigned to you`,
            html: `<p>${text}</p>`,
            text,
            dedupeKey: `tools-force-assign:${asset._id}:${assignee?._id || assignee?.employeeId || ''}`,
            module: 'Asset',
            emailType: 'Asset Force Assign',
            recordId: String(asset._id),
        });
        return { channel: 'email', sent: result?.sent !== false, reason: result?.reason || '' };
    }

    const contact = assignee?.employeeId
        ? await EmployeeContact.findOne({ employeeId: String(assignee.employeeId).trim() })
              .select('whatsappNumber')
              .lean()
        : null;
    const phone = normalizeWhatsAppPhone(contact?.whatsappNumber || '');
    if (!isValidWhatsAppPhone(phone)) {
        return { channel: 'whatsapp', sent: false, reason: 'no_company_email_or_whatsapp' };
    }
    const result = await sendTextMessage(phone, text, {
        source: 'auto',
        employeeId: assignee.employeeId,
        contactName: `${assignee.firstName || ''} ${assignee.lastName || ''}`.trim(),
    });
    return { channel: 'whatsapp', sent: result?.success !== false && !result?.error, reason: result?.error || '' };
}

export async function forceAssignPendingToolsAsset({ assetId, actorEmployeeId }) {
    const item = await AssetItem.findById(assetId)
        .populate('typeId', 'name')
        .populate('assignedTo', 'firstName lastName employeeId companyEmail');
    if (!item) return { status: 404, message: 'Asset not found' };

    const gate = await assertEscalationReady(item);
    if (!gate.ok) return { status: 400, message: gate.message };

    const assigneeId = refId(item.assignedTo);
    applyAcceptedAssignmentState(item, actorEmployeeId || assigneeId, {
        preserveService: item.onServiceActive === true,
        preserveParking: item.onLeaveActive === true,
    });
    if (actorEmployeeId) item.acceptedBy = actorEmployeeId;
    item.actionRequiredBy = null;
    item.pendingAction = null;
    const holderName = `${item.assignedTo?.firstName || ''} ${item.assignedTo?.lastName || ''}`.trim();
    if (holderName) item.ownership = holderName;
    clearAckMeta(item);
    await item.save();

    await AssetHistory.create({
        assetId: item._id,
        action: 'Accepted',
        assignedTo: assigneeId,
        assignedToType: 'Employee',
        performedBy: actorEmployeeId || undefined,
        comments: 'Force assigned by the asset controller because the employee did not respond.',
        date: new Date(),
    });

    await closeToolsAssignmentEscalation(item._id, actorEmployeeId, 'Force assigned');
    await closeCompletedAssignmentNotificationsForAssets([item._id], actorEmployeeId).catch(() => null);

    let notify = { channel: 'none', sent: false };
    try {
        notify = await notifyForceAssignedEmployee(item);
    } catch (error) {
        console.error('[ToolsAckEscalation] Force-assign notice failed:', error?.message || error);
    }

    return {
        status: 200,
        message: notify.sent
            ? 'Asset force assigned. The employee has been notified.'
            : 'Asset force assigned. The employee has no company email or WhatsApp number on file.',
        notify,
    };
}

function applyPrior(item, prior) {
    const status = prior?.status || 'Unassigned';
    const backToPool = !prior?.assignedTo || status === 'Unassigned' || status === 'Returned';
    item.status = status;
    item.acceptanceStatus = prior?.acceptanceStatus || (backToPool ? 'Pending' : 'Accepted');
    item.assignedTo = backToPool ? null : prior.assignedTo;
    item.assignedToType = backToPool ? null : prior.assignedToType || 'Employee';
    item.assignedCompany = backToPool ? null : prior.assignedCompany || null;
    item.assignedBy = backToPool ? null : prior.assignedBy || null;
    item.assignmentType = backToPool ? null : prior.assignmentType || null;
    item.assignedDays = backToPool ? null : prior.assignedDays ?? null;
    item.assignedDate = backToPool ? null : prior.assignedDate || null;
    item.temporaryEndDate = backToPool ? null : prior.temporaryEndDate || null;
    item.temporaryReminderSentAt = backToPool ? null : prior.temporaryReminderSentAt || null;
    item.temporaryExpiredSentAt = backToPool ? null : prior.temporaryExpiredSentAt || null;
    item.ownership = prior?.ownership || (backToPool ? 'Unassigned' : item.ownership);
    item.acceptedBy = backToPool ? null : prior.acceptedBy || null;
    item.onLeaveActive = prior?.onLeaveActive === true;
    item.onServiceActive = prior?.onServiceActive === true;
    item.actionRequiredBy = null;
    item.pendingAction = null;
    item.negotiationHistory = [];
}

export async function revertPendingToolsAssignment({ assetId, actorEmployeeId }) {
    const item = await AssetItem.findById(assetId).populate('typeId', 'name');
    if (!item) return { status: 404, message: 'Asset not found' };

    const gate = await assertEscalationReady(item);
    if (!gate.ok) return { status: 400, message: gate.message };

    let prior = item.pendingActionDetails?.toolsAssignmentAck?.prior || null;
    if (!prior?.status && !prior?.assignedTo) {
        prior = (await inferPriorFromHistory(item)) || {
            status: 'Unassigned',
            acceptanceStatus: 'Pending',
            assignedTo: null,
            ownership: 'Unassigned',
        };
    }
    applyPrior(item, prior);
    clearAckMeta(item);
    await item.save();

    await AssetHistory.create({
        assetId: item._id,
        action: 'Update',
        assignedTo: refId(item.assignedTo) || undefined,
        assignedToType: item.assignedToType || undefined,
        performedBy: actorEmployeeId || undefined,
        comments: `Assignment returned to the previous status (${item.status}) by the asset controller.`,
        date: new Date(),
    });

    await closeToolsAssignmentEscalation(item._id, actorEmployeeId, 'Assignment returned to previous status');
    await closeCompletedAssignmentNotificationsForAssets([item._id], actorEmployeeId).catch(() => null);

    return {
        status: 200,
        message: `Assignment returned to ${item.status}.`,
    };
}

async function ensureAckRecord(item, requestedAt) {
    const existing = item.pendingActionDetails?.toolsAssignmentAck;
    if (existing?.requestedAt && existing?.prior) return;
    const prior = existing?.prior || (await inferPriorFromHistory(item));
    const details =
        item.pendingActionDetails && typeof item.pendingActionDetails === 'object'
            ? { ...item.pendingActionDetails }
            : {};
    details.toolsAssignmentAck = {
        ...(existing || {}),
        requestedAt: existing?.requestedAt || requestedAt || new Date(),
        escalationActive: existing?.escalationActive === true,
        escalationNotifiedAt: existing?.escalationNotifiedAt || null,
        prior: prior || existing?.prior || null,
    };
    item.pendingActionDetails = details;
    item.markModified('pendingActionDetails');
}

export async function processToolsAssignmentAckEscalation() {
    try {
        const openBells = await DashboardAction.find({
            requestType: TOOLS_ACK_ESCALATION_TYPE,
            status: 'Pending',
        })
            .select('_id requestId')
            .lean();
        if (openBells.length) {
            const ids = openBells.map((row) => row.requestId).filter(Boolean);
            const stillPending = await AssetItem.find({
                _id: { $in: ids },
                status: 'Pending',
                acceptanceStatus: 'Pending',
                assignedTo: { $ne: null },
            })
                .select('_id pendingAction pendingActionDetails plateNumber typeId assignedToType')
                .populate('typeId', 'name')
                .lean();
            const stillIds = new Set(
                stillPending.filter((row) => isToolsEmployeeAckPending(row)).map((row) => String(row._id)),
            );
            const stale = openBells.filter((row) => !stillIds.has(String(row.requestId)));
            if (stale.length) {
                await DashboardAction.updateMany(
                    { _id: { $in: stale.map((row) => row._id) } },
                    {
                        $set: {
                            status: 'Approved',
                            actionedDate: new Date(),
                            comment: 'Auto-closed: assignment is no longer waiting for a response.',
                        },
                    },
                );
            }
        }

        const candidates = await AssetItem.find({
            status: 'Pending',
            acceptanceStatus: 'Pending',
            assignedToType: 'Employee',
            assignedTo: { $ne: null },
            $or: [{ pendingAction: null }, { pendingAction: '' }, { pendingAction: { $exists: false } }],
        })
            .populate('typeId', 'name')
            .populate('assignedTo', 'firstName lastName employeeId companyEmail')
            .limit(300);

        const controller = await getResolvedAssetControllerEmployee();
        if (!controller?._id) {
            console.warn('[ToolsAckEscalation] No asset controller is configured.');
            return;
        }

        for (const item of candidates) {
            if (!isToolsEmployeeAckPending(item)) continue;
            const requestedAt = await resolveRequestedAt(item);
            if (!requestedAt || wholeDaysSince(requestedAt) < TOOLS_ACK_ESCALATION_DAYS) continue;

            await ensureAckRecord(item, requestedAt);
            const ack = item.pendingActionDetails.toolsAssignmentAck;
            const alreadyNotified = !!ack.escalationNotifiedAt;
            ack.escalationActive = true;
            item.markModified('pendingActionDetails');
            await item.save();

            await upsertEscalationBell(controller, item, item.assignedTo);
            if (!alreadyNotified) {
                let emailed = false;
                try {
                    emailed = await emailAssetController(controller, item, item.assignedTo);
                } catch (error) {
                    console.error(
                        `[ToolsAckEscalation] Email failed for ${item.assetId || item._id}:`,
                        error?.message || error,
                    );
                }
                const hasCompanyEmail = !!String(controller?.companyEmail || '').trim();
                if (emailed || !hasCompanyEmail) {
                    ack.escalationNotifiedAt = new Date();
                    item.markModified('pendingActionDetails');
                    await item.save();
                }
            }
        }
    } catch (error) {
        console.error('[ToolsAckEscalation] Non-fatal error:', error?.message || error);
    }
}
