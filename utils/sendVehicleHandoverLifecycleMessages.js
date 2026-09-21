import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeeContact from '../models/EmployeeContact.js';
import AssetItem from '../models/AssetItem.js';
import AssetHistory from '../models/AssetHistory.js';
import User from '../models/User.js';
import { isFleetVehicleAsset, getResolvedFleetHrEmployee } from './assetApprovalHelpers.js';
import { getEventChannels } from './notificationEmailPermission.js';
import { isValidWhatsAppPhone, normalizeWhatsAppPhone } from './normalizeWhatsAppPhone.js';
import { sendErpEmail, buildEmailDedupeKey } from './emailDispatch.js';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { generatePdf } from './generatePdf.js';
import { VEHICLE_HANDOVER_PDF_SELECTOR } from './assetHandoverPdfConstants.js';
import { isJwtSystemSuperUser } from './systemSuperUser.js';
import { resolvePreviousHandoverAssignee } from './vehicleHandoverApprovalFlow.js';

export const VEHICLE_HANDOVER_EVENT = 'hrm.vehicle.handover';

const EMPLOYEE_SELECT =
    'firstName lastName employeeId companyEmail primaryReportee';

function logFail(step, detail) {
    console.error(`[VehicleHandoverNotify] FAILED ${step}: ${detail}`);
}

function logOk(step, detail) {
    console.log(`[VehicleHandoverNotify] ${step}: ${detail}`);
}

function vehicleLabel(asset) {
    const plate = String(asset?.plateNumber || '').trim();
    const name = String(asset?.name || '').trim();
    if (plate && name) return `${name} (${plate})`;
    return plate || name || String(asset?.assetId || 'Vehicle');
}

function employeeName(emp) {
    return `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim() || emp?.employeeId || 'Employee';
}

function companyEmailOf(emp) {
    return String(emp?.companyEmail || '').trim();
}

async function resolveWhatsAppNumber(employeeId) {
    const code = String(employeeId || '').trim();
    if (!code) return '';
    const contact = await EmployeeContact.findOne({ employeeId: code }).select('whatsappNumber').lean();
    const phone = normalizeWhatsAppPhone(contact?.whatsappNumber || '');
    return isValidWhatsAppPhone(phone) ? phone : '';
}

export async function resolveVehicleHandoverChannel(employee) {
    if (!employee) return { channel: 'none', reason: 'no_employee' };
    const channels = await getEventChannels(VEHICLE_HANDOVER_EVENT);
    const phone = await resolveWhatsAppNumber(employee.employeeId);
    if (channels.whatsapp !== false && phone) {
        return { channel: 'whatsapp', phone, companyEmail: '' };
    }
    const email = companyEmailOf(employee);
    if (email) {
        return { channel: 'email', phone: '', companyEmail: email };
    }
    if (channels.whatsapp !== false && !phone) {
        return { channel: 'none', reason: 'no_whatsapp_number' };
    }
    return { channel: 'none', reason: 'no_company_email' };
}

async function loadEmployee(ref) {
    if (!ref) return null;
    if (ref.employeeId && (ref.companyEmail !== undefined || ref.firstName)) {
        if (ref.primaryReportee && typeof ref.primaryReportee === 'object' && ref.primaryReportee.employeeId) {
            return ref;
        }
    }
    const id = ref._id || ref.id || ref;
    if (!id) return null;
    return EmployeeBasic.findById(id)
        .select(EMPLOYEE_SELECT)
        .populate('primaryReportee', EMPLOYEE_SELECT)
        .lean();
}

async function resolveNewUserRecipient(assignee) {
    const emp = await loadEmployee(assignee);
    if (!emp) return { employee: null, channel: 'none', reason: 'no_assignee' };
    const own = await resolveVehicleHandoverChannel(emp);
    if (own.channel !== 'none') {
        return { employee: emp, ...own };
    }
    const reportee = emp.primaryReportee?._id
        ? await loadEmployee(emp.primaryReportee)
        : null;
    if (!reportee) {
        return { employee: emp, channel: 'none', reason: own.reason || 'no_company_email_or_whatsapp' };
    }
    const via = await resolveVehicleHandoverChannel(reportee);
    return { employee: reportee, ...via, viaReportee: true, forAssignee: emp };
}

function createTransporter() {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return {
        transporter: nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        }),
        emailUser,
    };
}

function wrapHtml(title, bodyHtml) {
    return `
        <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;color:#1e293b;">
            <h2 style="margin:0 0 12px;">${title}</h2>
            ${bodyHtml}
            <p style="font-size:12px;color:#64748b;margin-top:24px;">VeRP Asset Management — automated message</p>
        </div>
    `;
}

async function deliverVehicleHandoverMessage({
    step,
    employee,
    subject,
    text,
    html,
    recordId,
    pdfBuffer = null,
    pdfFilename = '',
    attachDocument = false,
}) {
    if (!employee) {
        const result = { sent: false, step, reason: 'no_employee' };
        logFail(step, result.reason);
        return result;
    }

    const picked = await resolveVehicleHandoverChannel(employee);
    if (picked.channel === 'none') {
        const result = {
            sent: false,
            step,
            employeeId: employee.employeeId || '',
            reason: picked.reason || 'no_channel',
        };
        logFail(step, `${result.employeeId} ${result.reason}`);
        return result;
    }

    const dedupeKey = buildEmailDedupeKey([
        VEHICLE_HANDOVER_EVENT,
        step,
        String(recordId || ''),
        String(employee.employeeId || employee._id || ''),
    ]);

    if (picked.channel === 'whatsapp') {
        const caption = String(text || subject || '').trim();
        if (attachDocument && pdfBuffer?.length) {
            const { sendDocumentMessage } = await import('../services/whatsappService.js');
            const result = await sendDocumentMessage(
                picked.phone,
                {
                    buffer: pdfBuffer,
                    filename: pdfFilename || 'vehicle-handover.pdf',
                    caption,
                },
                {
                    source: 'auto',
                    eventKey: VEHICLE_HANDOVER_EVENT,
                    skipPaidChannelCheck: true,
                    employeeId: employee.employeeId,
                    contactName: employeeName(employee),
                },
            );
            if (!result?.success) {
                const out = {
                    sent: false,
                    step,
                    channel: 'whatsapp',
                    employeeId: employee.employeeId || '',
                    reason: result?.error || 'whatsapp_failed',
                };
                logFail(step, `${out.employeeId} ${out.reason}`);
                return out;
            }
            logOk(step, `whatsapp document ${employee.employeeId}`);
            return { sent: true, step, channel: 'whatsapp', employeeId: employee.employeeId || '' };
        }

        const { sendTextMessage } = await import('../services/whatsappService.js');
        const result = await sendTextMessage(picked.phone, caption, {
            source: 'auto',
            eventKey: VEHICLE_HANDOVER_EVENT,
            skipPaidChannelCheck: true,
            employeeId: employee.employeeId,
            contactName: employeeName(employee),
        });
        if (!result?.success) {
            const out = {
                sent: false,
                step,
                channel: 'whatsapp',
                employeeId: employee.employeeId || '',
                reason: result?.error || 'whatsapp_failed',
            };
            logFail(step, `${out.employeeId} ${out.reason}`);
            return out;
        }
        logOk(step, `whatsapp text ${employee.employeeId}`);
        return { sent: true, step, channel: 'whatsapp', employeeId: employee.employeeId || '' };
    }

    const mail = createTransporter();
    if (!mail) {
        const out = { sent: false, step, channel: 'email', reason: 'email_not_configured' };
        logFail(step, out.reason);
        return out;
    }

    const attachments =
        attachDocument && pdfBuffer?.length
            ? [
                  {
                      filename: pdfFilename || 'vehicle-handover.pdf',
                      content: pdfBuffer,
                      contentType: 'application/pdf',
                  },
              ]
            : [];

    const result = await sendErpEmail({
        transporter: mail.transporter,
        from: `"VeRP Asset Management" <${mail.emailUser}>`,
        to: [picked.companyEmail],
        subject,
        html: html || wrapHtml(subject, `<p>${String(text || '').replace(/</g, '')}</p>`),
        attachments,
        dedupeKey,
        module: VEHICLE_HANDOVER_EVENT,
        emailType: 'VehicleHandover',
        recordId: String(recordId || ''),
        metadata: { eventKey: VEHICLE_HANDOVER_EVENT, subjectCategory: 'information' },
    });

    if (!result?.sent) {
        const out = {
            sent: false,
            step,
            channel: 'email',
            employeeId: employee.employeeId || '',
            reason: result?.reason || 'email_failed',
        };
        logFail(step, `${out.employeeId} ${out.reason}`);
        return out;
    }
    logOk(step, `email ${employee.employeeId} ${picked.companyEmail}`);
    return { sent: true, step, channel: 'email', employeeId: employee.employeeId || '' };
}

async function buildHandoverPdf(req, assetId, historyId) {
    if (!req || !assetId || !historyId) return null;
    try {
        const baseUrl = resolveFrontendBaseUrl(req);
        const printUrl = `${baseUrl}/print/vehicle-handover/${assetId}?historyId=${encodeURIComponent(String(historyId))}`;
        const token = req.headers?.authorization?.split(' ')[1] || '';
        const userObj = req.user?.id ? await User.findById(req.user.id).lean() : null;
        const userPayload = {
            id: req.user?.id,
            isAdmin: isJwtSystemSuperUser(userObj || req.user),
            role: userObj?.role || req.user?.role,
            employeeId: userObj?.employeeId || req.user?.employeeId,
        };
        const buf = await generatePdf(printUrl, token, userPayload, {}, VEHICLE_HANDOVER_PDF_SELECTOR);
        return buf?.length ? buf : null;
    } catch (err) {
        logFail('pdf', err?.message || err);
        return null;
    }
}

function summarize(results) {
    const list = (results || []).filter(Boolean);
    const failed = list.filter((row) => !row.sent);
    return {
        ok: failed.length === 0,
        sent: list.filter((row) => row.sent).length,
        failed: failed.length,
        results: list,
        failures: failed,
    };
}

export async function maybeNotifyVehicleHandoverReportsReady(req, historyRecord) {
    const historyId = historyRecord?._id;
    if (!historyId) return summarize([]);

    const details = historyRecord.details || {};
    if (details.handoverKind === 'vehicle_inspection' || details.firstInspection === true) {
        return summarize([]);
    }
    if (!details.receiverAssessmentCompleted || !details.bodyConditionCompleted) {
        return summarize([]);
    }
    if (details.vehicleHandoverReportsReadyNotifiedAt) {
        return summarize([]);
    }

    const asset = await AssetItem.findById(historyRecord.assetId)
        .populate('typeId', 'name')
        .populate({
            path: 'assignedTo',
            select: EMPLOYEE_SELECT,
            populate: { path: 'primaryReportee', select: EMPLOYEE_SELECT },
        })
        .lean();
    if (!isFleetVehicleAsset(asset) || !asset?.assignedTo) {
        return summarize([]);
    }

    const recipient = await resolveNewUserRecipient(asset.assignedTo);
    const label = vehicleLabel(asset);
    const text = `The vehicle handover for ${label} has been updated and sent to you. Please review and approve in VeRP.`;
    const result = await deliverVehicleHandoverMessage({
        step: 'reports_sent',
        employee: recipient.employee,
        subject: `Vehicle handover updated: ${label}`,
        text,
        html: wrapHtml(
            'Vehicle handover updated',
            `<p>${text}</p>${recipient.viaReportee ? '<p>You are receiving this as the primary reportee.</p>' : ''}`,
        ),
        recordId: String(historyId),
    });

    await AssetHistory.updateOne(
        { _id: historyId },
        { $set: { 'details.vehicleHandoverReportsReadyNotifiedAt': new Date() } },
    ).catch(() => null);

    return summarize([result]);
}

export async function notifyVehicleHandoverAfterTargetApprove({
    req,
    asset,
    historyId,
    requiresHr = false,
}) {
    if (historyId) {
        const existing = await AssetHistory.findById(historyId)
            .select('details.vehicleHandoverTargetApproveNotifiedAt')
            .lean();
        if (existing?.details?.vehicleHandoverTargetApproveNotifiedAt) {
            return summarize([]);
        }
    }

    const results = [];
    const label = vehicleLabel(asset);
    const plateName = label;

    const assignee = await loadEmployee(asset.assignedTo);
    const newRecipient = await resolveNewUserRecipient(assignee);
    const pdf = await buildHandoverPdf(req, asset._id, historyId);
    if (!pdf) {
        logFail('target_approve_pdf', 'handover PDF could not be generated');
    }

    const assignText = `You got assigned a new vehicle: ${plateName}.`;
    results.push(
        await deliverVehicleHandoverMessage({
            step: 'new_assignee_assigned',
            employee: newRecipient.employee,
            subject: `Vehicle assigned to you: ${plateName}`,
            text: assignText,
            html: wrapHtml('Vehicle assigned', `<p>${assignText}</p>`),
            recordId: String(historyId),
            pdfBuffer: pdf,
            pdfFilename: `vehicle-handover-${asset.assetId || 'vehicle'}.pdf`,
            attachDocument: true,
        }),
    );
    if (!pdf) {
        results[results.length - 1] = {
            ...results[results.length - 1],
            pdfFailed: true,
        };
    }

    const previous = await resolvePreviousHandoverAssignee(asset._id, historyId);
    if (previous && String(previous._id) !== String(assignee?._id || '')) {
        const oldEmp = await loadEmployee(previous);
        let removedText = `The vehicle ${plateName} is removed from your asset list.`;
        if (requiresHr) {
            removedText += ' Damage spotted, it will go to HR approval.';
        }
        results.push(
            await deliverVehicleHandoverMessage({
                step: 'old_user_removed',
                employee: oldEmp,
                subject: `Vehicle removed from your list: ${plateName}`,
                text: removedText,
                html: wrapHtml('Vehicle removed', `<p>${removedText}</p>`),
                recordId: String(historyId),
            }),
        );
    }

    if (requiresHr) {
        const hr = await getResolvedFleetHrEmployee();
        const hrEmp = await loadEmployee(hr);
        const hrText = `Damage was spotted on ${plateName}. Please check the handover and make a decision.`;
        results.push(
            await deliverVehicleHandoverMessage({
                step: 'hr_damage_review',
                employee: hrEmp,
                subject: `Vehicle handover damage review: ${plateName}`,
                text: hrText,
                html: wrapHtml('Handover damage review', `<p>${hrText}</p>`),
                recordId: String(historyId),
            }),
        );
    }

    if (historyId) {
        await AssetHistory.updateOne(
            { _id: historyId },
            { $set: { 'details.vehicleHandoverTargetApproveNotifiedAt': new Date() } },
        ).catch(() => null);
    }

    return summarize(results);
}

export async function notifyVehicleHandoverAfterHrDecision({
    asset,
    historyId,
    hasFine = false,
}) {
    if (historyId) {
        const existing = await AssetHistory.findById(historyId)
            .select('details.vehicleHandoverHrDecisionNotifiedAt')
            .lean();
        if (existing?.details?.vehicleHandoverHrDecisionNotifiedAt) {
            return summarize([]);
        }
    }

    const previous = await resolvePreviousHandoverAssignee(asset._id, historyId);
    if (!previous) return summarize([]);

    const assigneeId = asset.assignedTo?._id || asset.assignedTo;
    if (assigneeId && String(previous._id) === String(assigneeId)) {
        return summarize([]);
    }

    const oldEmp = await loadEmployee(previous);
    const label = vehicleLabel(asset);
    const text = hasFine
        ? `HR recorded damage on ${label} as a fine. You may receive a fine.`
        : `HR approved the handover for ${label} without a fine. You do not have any fine.`;

    const result = await deliverVehicleHandoverMessage({
        step: 'hr_fine_decision',
        employee: oldEmp,
        subject: hasFine
            ? `Handover damage may become a fine: ${label}`
            : `Handover approved without fine: ${label}`,
        text,
        html: wrapHtml('HR handover decision', `<p>${text}</p>`),
        recordId: String(historyId),
    });
    if (historyId) {
        await AssetHistory.updateOne(
            { _id: historyId },
            { $set: { 'details.vehicleHandoverHrDecisionNotifiedAt': new Date() } },
        ).catch(() => null);
    }
    return summarize([result]);
}
