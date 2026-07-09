import nodemailer from 'nodemailer';
import AssetItem from '../models/AssetItem.js';
import DashboardAction from '../models/DashboardAction.js';
import AssetHistory from '../models/AssetHistory.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { resolveEmployeeEmail, pickEffectiveEmail } from '../utils/resolveEmployeeEmail.js';
import { resolveFrontendBaseUrl } from '../utils/resolveFrontendBaseUrl.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import { resolveProfileActivationSubmitterId } from '../utils/resolveProfileActivationSubmitterId.js';
import {
    isFleetVehicleAssetFields,
    isFleetVehicleAsset,
    isFleetVehicleProfileActive,
    resolveAssetControllerEmployee,
    getResolvedFleetHrEmployee,
} from '../utils/assetApprovalHelpers.js';
import {
    isHandoverReportsComplete,
    buildHandoverAssignDetailsPath,
    assigneeCanSelfAcknowledgeFleetHandover,
    buildFleetHandoverDisplayLabels,
    formatEmployeeDisplayName,
} from '../utils/vehicleHandoverApprovalFlow.js';
import { applyPendingHandoverAccessoriesToVehicleList } from '../utils/vehicleAccessoriesListSync.js';

export const VEHICLE_INSPECTION_DOC_TYPE = 'Vehicle Inspection';
export const VEHICLE_INSPECTION_HANDOVER_KIND = 'vehicle_inspection';

export function isInspectionHandoverHistoryRecord(record) {
    if (!record) return false;
    if (String(record?.details?.handoverKind || '').trim() === VEHICLE_INSPECTION_HANDOVER_KIND) {
        return true;
    }
    return record?.details?.firstInspection === true;
}

export function isVehicleInspectionWorkflowActive(asset) {
    const status = String(asset?.vehicleInspectionStatus || '').toLowerCase();
    return status === 'draft' || status === 'pending_hr';
}

function buildInspectionHandoverWorkflowMeta(submitterEmp, targetEmp) {
    const now = new Date();
    return {
        handoverKind: VEHICLE_INSPECTION_HANDOVER_KIND,
        stages: {
            assigner: {
                actorName: formatEmployeeDisplayName(submitterEmp),
                actorId: submitterEmp?._id?.toString?.() || '',
                actorEmployeeId: String(submitterEmp?.employeeId || '').trim(),
                date: now,
            },
            target: {
                actorName: formatEmployeeDisplayName(targetEmp),
                actorId: targetEmp?._id?.toString?.() || '',
                actorEmployeeId: String(targetEmp?.employeeId || '').trim(),
                date: now,
            },
            hr: { actorName: null, actorId: null, actorEmployeeId: null, date: null },
        },
    };
}

async function resolveFlowchartAdminOfficerEmployee() {
    const row = await getDepartmentHOD('admincontroller');
    if (!row) return null;
    return resolveAssetControllerEmployee(row);
}

async function createInspectionHandoverHistoryRow({
    assetId,
    submitterEmp,
    adminOfficerEmp,
    vehicleAssigneeEmp = null,
    isReinspection = false,
}) {
    const targetEmp = isReinspection
        ? adminOfficerEmp
        : vehicleAssigneeEmp?._id
          ? vehicleAssigneeEmp
          : adminOfficerEmp;

    let assigneeCanSelf = false;
    if (targetEmp?._id) {
        assigneeCanSelf = await assigneeCanSelfAcknowledgeFleetHandover(targetEmp);
    }

    const workflowMeta = {
        ...buildInspectionHandoverWorkflowMeta(submitterEmp, targetEmp),
        assigneeCanSelfAcknowledge: assigneeCanSelf,
        vehicleAssigneeId: vehicleAssigneeEmp?._id?.toString?.() || '',
        ...(isReinspection ? { reinspection: true } : {}),
    };

    const { handoverByDisplay, handoverToDisplay } = buildFleetHandoverDisplayLabels({
        workflowMeta,
        assignee: targetEmp,
        adminOfficer: adminOfficerEmp,
        isInspection: true,
    });

    return AssetHistory.create({
        assetId,
        action: 'Assigned',
        assignedToType: 'Employee',
        assignedTo: targetEmp._id,
        performedBy: submitterEmp?._id || null,
        comments: isReinspection ? 'Reinspection' : 'Do inspection',
        details: {
            handoverKind: VEHICLE_INSPECTION_HANDOVER_KIND,
            firstInspection: !isReinspection,
            reinspection: isReinspection,
            acceptanceStatus: 'Pending',
            inspectionFormStatus: 'draft',
            vehicleInspectionForm: {},
            vehicleHandoverWorkflow: workflowMeta,
            handoverByDisplay,
            handoverToDisplay,
        },
    });
}

const INSPECTION_FORM_CONDITIONS = new Set(['good', 'fair', 'poor']);

function normalizeInspectionFormPayload(raw = {}) {
    return {
        inspectionDate: String(raw.inspectionDate || '').trim(),
        odometerReading: String(raw.odometerReading ?? '').trim(),
        overallCondition: String(raw.overallCondition || '').trim().toLowerCase(),
        notes: String(raw.notes || '').trim(),
    };
}

function validateInspectionFormComplete(form) {
    if (!form.inspectionDate) {
        return 'Inspection date is required.';
    }
    if (!form.odometerReading) {
        return 'Odometer reading is required.';
    }
    const km = Number(form.odometerReading);
    if (!Number.isFinite(km) || km < 0) {
        return 'Odometer reading must be a valid number.';
    }
    if (!INSPECTION_FORM_CONDITIONS.has(form.overallCondition)) {
        return 'Overall condition must be Good, Fair, or Poor.';
    }
    return null;
}

function vehicleHasAssignedEmployee(asset) {
    const status = String(asset?.status || '').toLowerCase();
    const assigneeId = asset?.assignedTo?._id || asset?.assignedTo;
    return Boolean(assigneeId) && status === 'assigned';
}

export async function canEditInspectionHandoverContent(req, asset, record) {
    const userId = await resolveProfileActivationSubmitterId(req);
    if (!userId) return false;
    if (!isInspectionHandoverHistoryRecord(record)) return false;
    if (String(asset?.vehicleInspectionStatus || '').toLowerCase() !== 'draft') return false;

    const linkedId = asset?.vehicleInspectionHandoverHistoryId;
    if (!linkedId || String(linkedId) !== String(record._id)) return false;

    if (record?.details?.reinspection === true) {
        const adminOfficer = await resolveFlowchartAdminOfficerEmployee();
        if (!adminOfficer?._id) return false;
        return String(userId) === String(adminOfficer._id);
    }

    const isAdmin = await isUserInFlowchart(req.user, 'admincontroller').catch(() => false);

    let assetDoc = asset;
    if (
        !assetDoc?.status ||
        !assetDoc?.assignedTo ||
        (typeof assetDoc.assignedTo === 'object' && assetDoc.assignedTo.companyEmail === undefined)
    ) {
        assetDoc = await AssetItem.findById(asset._id || asset)
            .select('status assignedTo vehicleInspectionStatus vehicleInspectionHandoverHistoryId')
            .populate('assignedTo', 'companyEmail enablePortalAccess employeeId')
            .lean();
    }

    if (!vehicleHasAssignedEmployee(assetDoc)) {
        return isAdmin;
    }

    const workflowMeta = record?.details?.vehicleHandoverWorkflow;
    let assigneeCanSelf = false;
    if (typeof workflowMeta?.assigneeCanSelfAcknowledge === 'boolean') {
        assigneeCanSelf = workflowMeta.assigneeCanSelfAcknowledge;
    } else {
        const assigneeDoc =
            typeof assetDoc.assignedTo === 'object'
                ? assetDoc.assignedTo
                : await EmployeeBasic.findById(assetDoc.assignedTo)
                    .select('companyEmail enablePortalAccess employeeId')
                    .lean();
        assigneeCanSelf = assigneeDoc
            ? await assigneeCanSelfAcknowledgeFleetHandover(assigneeDoc)
            : false;
    }

    const assigneeId = assetDoc.assignedTo?._id || assetDoc.assignedTo;
    if (assigneeCanSelf && String(userId) === String(assigneeId)) {
        return true;
    }

    return isAdmin;
}

async function canEditVehicleInspectionForm(req, asset, record) {
    return canEditInspectionHandoverContent(req, asset, record);
}

async function markInspectionHandoverHistoryApproved(historyId, reviewerEmp) {
    if (!historyId) return;
    const existing = await AssetHistory.findById(historyId).select('details').lean();
    if (!existing) return;
    const workflow = existing.details?.vehicleHandoverWorkflow || {};
    const stages = { ...(workflow.stages || {}) };
    stages.hr = {
        actorName: formatEmployeeDisplayName(reviewerEmp),
        actorId: reviewerEmp?._id?.toString?.() || '',
        actorEmployeeId: String(reviewerEmp?.employeeId || '').trim(),
        date: new Date(),
    };
    await AssetHistory.findByIdAndUpdate(historyId, {
        action: 'Accepted',
        $set: {
            'details.acceptanceStatus': 'Accepted',
            'details.vehicleHandoverWorkflow': { ...workflow, stages },
        },
    });
}

function buildInspectionHandoverDetailsUrl(req, assetId, historyId) {
    const base = String(resolveFrontendBaseUrl(req) || '').replace(/\/+$/, '');
    return `${base}${buildHandoverAssignDetailsPath(assetId, historyId)}`;
}

async function markInspectionHandoverHistoryRejected(historyId, reviewerId) {
    if (!historyId) return;
    await AssetHistory.findByIdAndUpdate(historyId, {
        action: 'Rejected',
        performedBy: reviewerId || undefined,
        $set: {
            'details.acceptanceStatus': 'Rejected',
        },
    });
}

const vehicleSubjectForDashboard = (asset) => ({
    firstName: asset.name || 'Vehicle',
    lastName: `(${asset.assetId || ''})`.trim(),
    employeeId: asset.assetId || '',
    designation: asset.typeId?.name || '',
});

const hasFormalVehicleInspectionDoc = (asset) =>
    (asset?.documents || []).some(
        (doc) => String(doc?.type || '').trim().toLowerCase() === VEHICLE_INSPECTION_DOC_TYPE.toLowerCase(),
    );

const hasVehicleInspectionHistory = (asset) =>
    String(asset?.vehicleInspectionStatus || '').toLowerCase() === 'active' || hasFormalVehicleInspectionDoc(asset);

export const canProcessVehicleInspection = async (req) => isUserInFlowchart(req.user, 'hr').catch(() => false);

const canSubmitVehicleInspection = async (req) => {
    const submitterId = await resolveProfileActivationSubmitterId(req);
    if (!submitterId) return false;
    return isUserInFlowchart(req.user, 'admincontroller').catch(() => false);
};

const canSubmitVehicleReinspection = async (req) => {
    const submitterId = await resolveProfileActivationSubmitterId(req);
    if (!submitterId) return false;
    const inFlowchart = await isUserInFlowchart(req.user, 'admincontroller').catch(() => false);
    if (!inFlowchart) return false;
    const adminOfficer = await resolveFlowchartAdminOfficerEmployee();
    if (!adminOfficer?._id) return false;
    return String(adminOfficer._id) === String(submitterId);
};

const sendHrInspectionRequestEmail = async ({ req, hrEmail, hrName, vehicleLabel, detailUrl }) => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass || !hrEmail?.trim()) return;

    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    await transporter
        .sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to: hrEmail,
            subject: `Vehicle inspection request: ${vehicleLabel}`,
            html: `
                <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
                    <h2 style="color:#1d4ed8;">Vehicle inspection — HR approval</h2>
                    <p>Hello <strong>${hrName}</strong>,</p>
                    <p>A user requested to create the first vehicle inspection record for <strong>${vehicleLabel}</strong>.</p>
                    <p>Please review and approve or reject in VeRP. The inspection document is created only after approval.</p>
                    <p><a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:8px;">Open vehicle</a></p>
                </div>
            `,
        })
        .catch(() => { });
};

function buildInspectionDashboardExtra3(assetId, historyId, viewerRole, extra = {}) {
    return JSON.stringify({
        activationSubject: 'vehicle',
        activationViewerRole: viewerRole,
        vehicleMongoId: String(assetId),
        historyId: String(historyId),
        detailsPath: buildHandoverAssignDetailsPath(assetId, historyId),
        ...extra,
    });
}

async function sendInspectionAssigneeTaskEmail({
    to,
    recipientName,
    vehicleLabel,
    detailUrl,
    requestedByName,
    roleLabel = 'Handover To (Admin Officer)',
    instruction = 'please complete the assessment and body condition reports, then submit for HR approval.',
}) {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass || !to?.trim()) return;

    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    await transporter
        .sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to,
            subject: `Action required — vehicle inspection handover: ${vehicleLabel}`,
            html: `
                <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
                    <h2 style="color:#1d4ed8;">Vehicle inspection handover</h2>
                    <p>Hello <strong>${recipientName || 'there'}</strong>,</p>
                    <p><strong>${requestedByName || 'A colleague'}</strong> created a vehicle inspection handover for <strong>${vehicleLabel}</strong>.</p>
                    <p>As <strong>${roleLabel}</strong>, ${instruction}</p>
                    <p><a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:8px;">Open inspection handover</a></p>
                </div>
            `,
        })
        .catch(() => { });
}

async function sendInspectionRequesterAckEmail({ to, recipientName, vehicleLabel, adminName, detailUrl }) {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass || !to?.trim()) return;

    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    await transporter
        .sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to,
            subject: `Vehicle inspection handover created: ${vehicleLabel}`,
            html: `
                <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
                    <h2 style="color:#1d4ed8;">Inspection handover created</h2>
                    <p>Hello <strong>${recipientName || 'there'}</strong>,</p>
                    <p>Your vehicle inspection handover for <strong>${vehicleLabel}</strong> was created successfully.</p>
                    <p><strong>${adminName || 'Admin Officer'}</strong> will complete the assessment and body condition reports, then submit for HR approval.</p>
                    <p><a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:8px;">View handover</a></p>
                </div>
            `,
        })
        .catch(() => { });
}

async function notifyInspectionHandoverRequester({
    req,
    asset,
    handoverHistory,
    submitterEmp,
    adminOfficerEmp,
    requestedByName,
}) {
    if (!submitterEmp?._id || !handoverHistory?._id) return;

    const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || asset._id})`;
    const historyId = handoverHistory._id;
    const detailUrl = buildInspectionHandoverDetailsUrl(req, asset._id, historyId);
    const requesterName = formatEmployeeDisplayName(submitterEmp) || requestedByName || 'System';
    const adminName = formatEmployeeDisplayName(adminOfficerEmp);

    const requesterEmail = pickEffectiveEmail(submitterEmp);
    if (requesterEmail?.trim()) {
        await sendInspectionRequesterAckEmail({
            to: requesterEmail,
            recipientName: requesterName,
            vehicleLabel,
            adminName,
            detailUrl,
        });
    }

    await syncDashboardAction({
        requestId: asset._id,
        requestType: 'Vehicle Inspection',
        assignedTo: String(submitterEmp._id),
        status: 'Pending',
        subjectEmployee: vehicleSubjectForDashboard(asset),
        requestedByName: requesterName,
        extra1: `[Fleet] ${vehicleLabel} — inspection handover in progress`,
        extra2: '',
        extra3: buildInspectionDashboardExtra3(asset._id, historyId, 'inspection_requester', {
            inspectionRequesterTrack: true,
        }),
    });
}

async function notifyInspectionHandoverAssignee({
    req,
    asset,
    handoverHistory,
    adminOfficerEmp,
    submitterEmp,
}) {
    const assigneeId =
        handoverHistory?.assignedTo?._id ||
        handoverHistory?.assignedTo ||
        adminOfficerEmp?._id;
    if (!assigneeId || !handoverHistory?._id) return;

    const assigneeEmp = await EmployeeBasic.findById(assigneeId)
        .select('_id employeeId firstName lastName companyEmail workEmail personalEmail email')
        .lean();
    if (!assigneeEmp?._id) return;

    const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || asset._id})`;
    const historyId = handoverHistory._id;
    const detailUrl = buildInspectionHandoverDetailsUrl(req, asset._id, historyId);
    const requestedByName =
        formatEmployeeDisplayName(submitterEmp) ||
        req.user?.name ||
        [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
        'System';

    const assigneeEmail =
        pickEffectiveEmail(assigneeEmp) || resolveEmployeeEmail(assigneeEmp).email;
    if (assigneeEmail?.trim()) {
        await sendInspectionAssigneeTaskEmail({
            to: assigneeEmail,
            recipientName: formatEmployeeDisplayName(assigneeEmp),
            vehicleLabel,
            detailUrl,
            requestedByName,
        });
    }

    await syncDashboardAction({
        requestId: asset._id,
        requestType: 'Vehicle Inspection',
        assignedTo: String(assigneeEmp._id),
        status: 'Pending',
        subjectEmployee: vehicleSubjectForDashboard(asset),
        requestedByName,
        extra1: `[Fleet] ${vehicleLabel} — complete inspection handover`,
        extra2: '',
        extra3: buildInspectionDashboardExtra3(asset._id, historyId, 'inspection_assignee', {
            inspectionFormTask: true,
        }),
    });
}

async function notifyInspectionHandoverVehicleAssignee({
    req,
    asset,
    handoverHistory,
    submitterEmp,
}) {
    if (!vehicleHasAssignedEmployee(asset) || !handoverHistory?._id) return;

    const assigneeRef = asset.assignedTo;
    const assigneeEmp =
        typeof assigneeRef === 'object' && assigneeRef?._id
            ? assigneeRef
            : await EmployeeBasic.findById(assigneeRef)
                .select('_id employeeId firstName lastName companyEmail workEmail personalEmail email enablePortalAccess')
                .lean();
    if (!assigneeEmp?._id) return;

    const assigneeCanSelf = await assigneeCanSelfAcknowledgeFleetHandover(assigneeEmp);
    if (!assigneeCanSelf) return;

    const adminOfficerId = handoverHistory?.assignedTo?._id || handoverHistory?.assignedTo;
    if (adminOfficerId && String(assigneeEmp._id) === String(adminOfficerId)) return;

    const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || asset._id})`;
    const historyId = handoverHistory._id;
    const detailUrl = buildInspectionHandoverDetailsUrl(req, asset._id, historyId);
    const requestedByName =
        formatEmployeeDisplayName(submitterEmp) ||
        req.user?.name ||
        [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
        'System';

    const assigneeEmail =
        pickEffectiveEmail(assigneeEmp) || resolveEmployeeEmail(assigneeEmp).email;
    if (assigneeEmail?.trim()) {
        await sendInspectionAssigneeTaskEmail({
            to: assigneeEmail,
            recipientName: formatEmployeeDisplayName(assigneeEmp),
            vehicleLabel,
            detailUrl,
            requestedByName,
            roleLabel: 'assigned vehicle user',
            instruction:
                'please complete the assessment and body condition reports, then submit for HR approval.',
        });
    }

    await syncDashboardAction({
        requestId: asset._id,
        requestType: 'Vehicle Inspection',
        assignedTo: String(assigneeEmp._id),
        status: 'Pending',
        subjectEmployee: vehicleSubjectForDashboard(asset),
        requestedByName,
        extra1: `[Fleet] ${vehicleLabel} — complete inspection handover`,
        extra2: '',
        extra3: buildInspectionDashboardExtra3(asset._id, historyId, 'inspection_vehicle_assignee', {
            inspectionVehicleAssigneeTask: true,
        }),
    });
}

async function updateInspectionAdminAwaitingHrTrack({
    asset,
    handoverHistory,
    requestedByName,
}) {
    const assigneeId = handoverHistory?.assignedTo?._id || handoverHistory?.assignedTo;
    if (!assigneeId || !asset?._id || !handoverHistory?._id) return;

    const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || asset._id})`;
    const historyId = handoverHistory._id;
    const extra3 = buildInspectionDashboardExtra3(asset._id, historyId, 'inspection_assignee', {
        inspectionFormTask: true,
        inspectionAwaitingHr: true,
    });

    const updated = await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            requestType: 'Vehicle Inspection',
            assignedTo: assigneeId,
            status: 'Pending',
            extra3: { $regex: '"inspectionFormTask"\\s*:\\s*true', $options: 'i' },
        },
        {
            $set: {
                extra1: `[Fleet] ${vehicleLabel} — awaiting HR approval`,
                extra2: '',
                extra3,
                requestedByName: requestedByName || 'System',
            },
        },
    );

    if (!updated) {
        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Inspection',
            assignedTo: String(assigneeId),
            status: 'Pending',
            subjectEmployee: vehicleSubjectForDashboard(asset),
            requestedByName: requestedByName || 'System',
            extra1: `[Fleet] ${vehicleLabel} — awaiting HR approval`,
            extra2: '',
            extra3,
        });
    }
}

const sendInspectionOutcomeEmail = async ({ submitterEmployee, reviewerName, vehicleLabel, detailUrl, status }) => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return;

    const { email } = resolveEmployeeEmail(submitterEmployee);
    if (!email?.trim()) return;

    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    const approved = status === 'approved';
    const submitterName =
        `${submitterEmployee?.firstName || ''} ${submitterEmployee?.lastName || ''}`.trim() || 'there';

    await transporter
        .sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to: email,
            subject: `Vehicle inspection ${approved ? 'approved' : 'rejected'}: ${vehicleLabel}`,
            html: `
                <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
                    <h2 style="color:${approved ? '#059669' : '#dc2626'};">Vehicle inspection ${approved ? 'approved' : 'rejected'}</h2>
                    <p>Hello <strong>${submitterName}</strong>,</p>
                    <p>HR (${reviewerName}) has <strong>${approved ? 'approved' : 'rejected'}</strong> your vehicle inspection create request for <strong>${vehicleLabel}</strong>.</p>
                    ${approved ? '<p>The inspection record has been created on the vehicle.</p>' : '<p>You may submit a new request if needed.</p>'}
                    <p><a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:8px;">Open vehicle</a></p>
                </div>
            `,
        })
        .catch(() => { });
};

async function sendInspectionApprovedStakeholderEmails({
    req,
    asset,
    historyId,
    reviewerDisplayName,
}) {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return;

    const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || asset._id})`;
    const detailUrl = historyId
        ? buildInspectionHandoverDetailsUrl(req, asset._id, historyId)
        : `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${asset._id}?tab=handover`;

    const historyRecord = historyId
        ? await AssetHistory.findById(historyId)
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee',
                populate: {
                    path: 'primaryReportee',
                    select: 'firstName lastName employeeId companyEmail workEmail personalEmail email',
                },
            })
            .lean()
        : null;

    const adminOfficer = historyRecord?.assignedTo || null;
    const primaryReportee =
        adminOfficer?.primaryReportee && typeof adminOfficer.primaryReportee === 'object'
            ? adminOfficer.primaryReportee
            : null;

    const recipients = [];
    const seen = new Set();
    const push = (emp) => {
        const id = emp?._id?.toString?.();
        if (!emp || !id || seen.has(id)) return;
        seen.add(id);
        recipients.push(emp);
    };

    push(primaryReportee);
    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    for (const recipient of recipients) {
        const email = pickEffectiveEmail(recipient);
        if (!email?.trim()) continue;

        const recipientName =
            `${recipient.firstName || ''} ${recipient.lastName || ''}`.trim() || 'there';

        await transporter
            .sendMail({
                from: `"VeRP Portal" <${emailUser}>`,
                to: email,
                subject: `Vehicle inspection approved: ${vehicleLabel}`,
                html: `
                    <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
                        <h2 style="color:#059669;">Vehicle inspection approved</h2>
                        <p>Hello <strong>${recipientName}</strong>,</p>
                        <p>HR (${reviewerDisplayName}) has <strong>approved</strong> the vehicle inspection for <strong>${vehicleLabel}</strong>.</p>
                        <p>You are receiving this as the primary reportee for the Admin Officer who completed the inspection handover.</p>
                        <p><a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:8px;">Open handover details</a></p>
                    </div>
                `,
            })
            .catch(() => { });
    }
}

async function closeInspectionAssigneeDashboardTasks(assetId, comment = 'Submitted to HR for approval') {
    if (!assetId) return;
    await DashboardAction.updateMany(
        {
            requestId: assetId,
            requestType: 'Vehicle Inspection',
            status: 'Pending',
            extra3: {
                $regex:
                    '("inspectionFormTask"|"inspectionVehicleAssigneeTask"|"inspection_assignee"|"inspection_vehicle_assignee"|"inspection_requester")',
                $options: 'i',
            },
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment,
            },
        },
    );
}

async function upsertInspectionHrDashboardAction({
    asset,
    handoverHistory,
    hrEmployee,
    requestedByName,
    vehicleLabel,
}) {
    await DashboardAction.updateMany(
        {
            requestId: asset._id,
            requestType: 'Vehicle Inspection',
            status: 'Pending',
            assignedTo: hrEmployee._id,
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: 'Superseded by latest HR review task',
            },
        },
    );

    const hrExtra3 = buildInspectionDashboardExtra3(asset._id, handoverHistory._id, 'flowchart_hr', {
        inspectionReview: true,
    });
    const subject = vehicleSubjectForDashboard(asset);

    await DashboardAction.findOneAndUpdate(
        {
            requestId: asset._id,
            requestType: 'Vehicle Inspection',
            assignedTo: hrEmployee._id,
            status: 'Pending',
            extra3: { $regex: '"inspectionReview"\\s*:\\s*true', $options: 'i' },
        },
        {
            assignedTo: hrEmployee._id,
            assignedToEmpId: hrEmployee.employeeId,
            requestId: asset._id,
            requestType: 'Vehicle Inspection',
            status: 'Pending',
            subjectEmployeeId: subject.employeeId,
            subjectName: `${subject.firstName || ''} ${subject.lastName || ''}`.trim(),
            requestedByName: requestedByName || 'System',
            requestedDate: new Date(),
            extra1: `[Fleet] ${vehicleLabel} — HR approval required`,
            extra2: '',
            extra3: hrExtra3,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

async function notifyHrForVehicleInspection({
    req,
    asset,
    handoverHistory,
    submitterId,
    skipStatusUpdate = false,
}) {
    const designatedHr = await getResolvedFleetHrEmployee();
    if (!designatedHr?._id) {
        throw new Error('No HR assignee is configured in the flowchart.');
    }
    const { email: hrEmail } = resolveEmployeeEmail(designatedHr);

    if (!skipStatusUpdate) {
        await AssetItem.updateOne(
            { _id: asset._id },
            {
                $set: {
                    vehicleInspectionStatus: 'pending_hr',
                    vehicleInspectionSubmittedAt: new Date(),
                    vehicleInspectionSubmittedBy: submitterId,
                    vehicleInspectionHandoverHistoryId: handoverHistory._id,
                },
            },
        );
    }

    const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || asset._id})`;
    const detailUrl = buildInspectionHandoverDetailsUrl(req, asset._id, handoverHistory._id);
    const hrName = `${designatedHr.firstName || ''} ${designatedHr.lastName || ''}`.trim() || 'HR';

    const requestedByName =
        req.user?.name ||
        [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
        req.user?.employeeId ||
        '';

    await closeInspectionAssigneeDashboardTasks(asset._id);

    await upsertInspectionHrDashboardAction({
        asset,
        handoverHistory,
        hrEmployee: designatedHr,
        requestedByName,
        vehicleLabel,
    });

    if (hrEmail?.trim()) {
        await sendHrInspectionRequestEmail({ req, hrEmail, hrName, vehicleLabel, detailUrl });
    }
}

/**
 * After assessment and body condition are complete on an inspection handover row, notify HR.
 * Does not assign the vehicle — only advances the inspection workflow.
 */
export async function submitInspectionHandoverAfterAssessment(req, record) {
    const handoverKind = String(record?.details?.handoverKind || '').trim();
    if (handoverKind !== VEHICLE_INSPECTION_HANDOVER_KIND) {
        return { submitted: false };
    }

    if (!isHandoverReportsComplete(record)) {
        throw new Error(
            'Complete Body Condition Report before submitting for HR approval.',
        );
    }

    const asset = await AssetItem.findById(record.assetId).populate('typeId', 'name').lean();
    if (!asset) {
        throw new Error('Vehicle asset not found.');
    }
    const linkedId = asset.vehicleInspectionHandoverHistoryId;
    if (!linkedId || String(linkedId) !== String(record._id)) {
        throw new Error('Inspection handover is not linked to this vehicle.');
    }

    const submitterId = await resolveProfileActivationSubmitterId(req);
    if (!submitterId) {
        throw new Error('Your portal login must be linked to an Employee record.');
    }

    const lockedAsset = await AssetItem.findOneAndUpdate(
        {
            _id: asset._id,
            vehicleInspectionStatus: 'draft',
            vehicleInspectionHandoverHistoryId: record._id,
        },
        {
            $set: {
                vehicleInspectionStatus: 'pending_hr',
                vehicleInspectionSubmittedAt: new Date(),
                vehicleInspectionSubmittedBy: submitterId,
            },
        },
        { new: true },
    )
        .populate('typeId', 'name')
        .lean();

    if (!lockedAsset) {
        const current = await AssetItem.findById(asset._id)
            .select('vehicleInspectionStatus')
            .lean();
        if (String(current?.vehicleInspectionStatus || '').toLowerCase() === 'pending_hr') {
            return { submitted: false, alreadySubmitted: true };
        }
        throw new Error('Inspection could not be submitted. Refresh the page and try again.');
    }

    const workflow = record.details?.vehicleHandoverWorkflow || {};
    const stages = { ...(workflow.stages || {}) };
    const targetEmp = record.assignedTo
        ? await EmployeeBasic.findById(record.assignedTo).select('firstName lastName employeeId').lean()
        : null;
    stages.target = {
        ...(stages.target || {}),
        actorName: formatEmployeeDisplayName(targetEmp) || stages.target?.actorName || '',
        actorId: targetEmp?._id?.toString?.() || stages.target?.actorId || '',
        actorEmployeeId: String(targetEmp?.employeeId || stages.target?.actorEmployeeId || '').trim(),
        date: new Date(),
    };

    record.details = {
        ...(record.details || {}),
        inspectionFormStatus: 'complete',
        inspectionFormCompletedAt: new Date(),
        vehicleHandoverWorkflow: { ...workflow, stages },
    };
    record.markModified('details');
    await record.save();

    await notifyHrForVehicleInspection({
        req,
        asset: lockedAsset,
        handoverHistory: record,
        submitterId,
        skipStatusUpdate: true,
    });

    const refreshedAsset = await AssetItem.findById(lockedAsset._id).populate('typeId', 'name').lean();
    return { submitted: true, asset: refreshedAsset };
}

/**
 * POST /api/AssetItem/history-record/:historyId/submit-inspection-for-hr
 * Sends a completed inspection handover (assessment + body condition) to HR for approval.
 */
export const submitInspectionHandoverForHr = async (req, res) => {
    try {
        const { historyId } = req.params;
        const record = await AssetHistory.findById(historyId);
        if (!record) {
            return res.status(404).json({ message: 'History record not found' });
        }

        const inspectionSubmitResult = await submitInspectionHandoverAfterAssessment(req, record);

        const populated = await AssetHistory.findById(historyId)
            .populate('performedBy', 'firstName lastName employeeId')
            .populate('assignedTo', 'firstName lastName employeeId');

        const responseBody = populated?.toObject?.() || {};
        if (inspectionSubmitResult?.asset) {
            responseBody.vehicleAsset = inspectionSubmitResult.asset;
            responseBody.inspectionSubmittedForHr = inspectionSubmitResult.submitted === true;
        }

        return res.status(200).json(responseBody);
    } catch (err) {
        return res.status(400).json({
            message: err.message || 'Failed to submit inspection for HR approval.',
        });
    }
};

/**
 * POST /api/AssetItem/:id/submit-vehicle-inspection-request
 */
export const submitVehicleInspectionRequest = async (req, res) => {
    try {
        const { id } = req.params;

        const asset = await AssetItem.findById(id)
            .populate('typeId', 'name')
            .populate(
                'assignedTo',
                'firstName lastName employeeId companyEmail enablePortalAccess workEmail personalEmail email',
            )
            .lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }
        if (!(await canSubmitVehicleInspection(req))) {
            return res.status(403).json({
                message: 'Only the flowchart Admin Officer can create vehicle inspections.',
            });
        }

        const inspectionStatus = String(asset.vehicleInspectionStatus || '').toLowerCase();
        if (inspectionStatus === 'draft') {
            return res.status(400).json({
                message: 'An inspection handover row already exists. Complete the form from the handover table.',
            });
        }
        if (inspectionStatus === 'pending_hr') {
            return res.status(400).json({ message: 'A vehicle inspection request is already pending HR approval.' });
        }
        if (inspectionStatus === 'active' || hasVehicleInspectionHistory(asset)) {
            return res.status(400).json({
                message: 'Vehicle inspection is already complete. Use Create Reinspection for a new inspection cycle.',
            });
        }

        return createVehicleInspectionHandover(req, res, asset, { isReinspection: false });
    } catch (err) {
        console.error('submitVehicleInspectionRequest:', err);
        return res.status(500).json({ message: err.message || 'Failed to submit inspection request.' });
    }
};

/**
 * POST /api/AssetItem/:id/submit-vehicle-reinspection-request
 */
export const submitVehicleReinspectionRequest = async (req, res) => {
    try {
        const { id } = req.params;

        const asset = await AssetItem.findById(id)
            .populate('typeId', 'name')
            .populate(
                'assignedTo',
                'firstName lastName employeeId companyEmail enablePortalAccess workEmail personalEmail email',
            )
            .lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }
        if (!(await canSubmitVehicleReinspection(req))) {
            return res.status(403).json({
                message: 'Only the flowchart Admin Officer can create vehicle reinspections.',
            });
        }
        if (!isFleetVehicleProfileActive(asset)) {
            return res.status(400).json({
                message: 'Vehicle profile must be activated before creating a reinspection.',
            });
        }

        const inspectionStatus = String(asset.vehicleInspectionStatus || '').toLowerCase();
        if (inspectionStatus === 'draft') {
            return res.status(400).json({
                message: 'A reinspection handover is already in progress. Complete it from the handover table.',
            });
        }
        if (inspectionStatus === 'pending_hr') {
            return res.status(400).json({
                message: 'A vehicle reinspection request is already pending HR approval.',
            });
        }
        if (inspectionStatus !== 'active' && !hasVehicleInspectionHistory(asset)) {
            return res.status(400).json({
                message: 'Complete the first vehicle inspection before creating a reinspection.',
            });
        }

        return createVehicleInspectionHandover(req, res, asset, { isReinspection: true });
    } catch (err) {
        console.error('submitVehicleReinspectionRequest:', err);
        return res.status(500).json({ message: err.message || 'Failed to submit reinspection request.' });
    }
};

async function createVehicleInspectionHandover(req, res, asset, { isReinspection = false } = {}) {
    const id = asset._id;

    const submitterId = await resolveProfileActivationSubmitterId(req);
    if (!submitterId) {
        return res.status(400).json({
            message: 'Your portal login must be linked to an Employee record before you can submit a request.',
        });
    }

    const [submitterEmp, adminOfficerEmp] = await Promise.all([
        EmployeeBasic.findById(submitterId).select('firstName lastName employeeId').lean(),
        resolveFlowchartAdminOfficerEmployee(),
    ]);
    if (!submitterEmp?._id) {
        return res.status(400).json({ message: 'Submitter employee record not found.' });
    }
    if (!adminOfficerEmp?._id) {
        return res.status(400).json({
            message: 'Admin Officer is not configured in the flowchart.',
        });
    }

    const vehicleAssigneeEmp =
        asset.assignedTo && String(asset.status || '').toLowerCase() === 'assigned'
            ? typeof asset.assignedTo === 'object'
                ? asset.assignedTo
                : await EmployeeBasic.findById(asset.assignedTo)
                      .select(
                          'firstName lastName employeeId companyEmail enablePortalAccess workEmail personalEmail email',
                      )
                      .lean()
            : null;

    const handoverHistory = await createInspectionHandoverHistoryRow({
        assetId: asset._id,
        submitterEmp,
        adminOfficerEmp,
        vehicleAssigneeEmp,
        isReinspection,
    });

    await AssetItem.updateOne(
        { _id: id },
        {
            $set: {
                vehicleInspectionStatus: 'draft',
                vehicleInspectionSubmittedAt: new Date(),
                vehicleInspectionRequestedBy: submitterId,
                vehicleInspectionSubmittedBy: submitterId,
                vehicleInspectionHandoverHistoryId: handoverHistory._id,
            },
        },
    );

    const assetForNotify = await AssetItem.findById(id).populate('typeId', 'name').lean();
    const requestedByName = formatEmployeeDisplayName(submitterEmp) || 'System';

    await notifyInspectionHandoverAssignee({
        req,
        asset: assetForNotify || asset,
        handoverHistory,
        adminOfficerEmp,
        submitterEmp,
    });

    await notifyInspectionHandoverVehicleAssignee({
        req,
        asset: assetForNotify || asset,
        handoverHistory,
        submitterEmp,
    });

    const samePerson =
        String(submitterEmp._id) === String(adminOfficerEmp._id) ||
        String(submitterEmp._id) === String(handoverHistory.assignedTo);
    if (!samePerson) {
        await notifyInspectionHandoverRequester({
            req,
            asset: assetForNotify || asset,
            handoverHistory,
            submitterEmp,
            adminOfficerEmp,
            requestedByName,
        });
    }

    return res.status(200).json({
        message: isReinspection
            ? 'Reinspection handover created. Complete the assessment from the handover row.'
            : 'Inspection handover created. Complete the assessment from the handover row.',
        vehicleInspectionStatus: 'draft',
        handoverHistoryId: handoverHistory._id,
        reinspection: isReinspection,
    });
}

/**
 * POST /api/AssetItem/:id/approve-vehicle-inspection
 */
export const approveVehicleInspection = async (req, res) => {
    try {
        const { id } = req.params;

        if (!(await canProcessVehicleInspection(req))) {
            return res.status(403).json({ message: 'Only flowchart HR can approve vehicle inspection requests.' });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (String(asset.vehicleInspectionStatus || '').toLowerCase() !== 'pending_hr') {
            return res.status(400).json({ message: 'No pending vehicle inspection request to approve.' });
        }

        const alreadyHasInspectionRecord = hasVehicleInspectionHistory(asset);

        const requesterId =
            asset.vehicleInspectionRequestedBy || asset.vehicleInspectionSubmittedBy || null;
        const reviewerId = await resolveProfileActivationSubmitterId(req);
        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

        const historyRecord = asset.vehicleInspectionHandoverHistoryId
            ? await AssetHistory.findById(asset.vehicleInspectionHandoverHistoryId)
                .select('details assetId')
                .lean()
            : null;
        const inspectionForm = historyRecord?.details?.vehicleInspectionForm || {};
        const receiverAssessment = historyRecord?.details?.receiverAssessment || null;

        const inspectionDoc = {
            type: VEHICLE_INSPECTION_DOC_TYPE,
            issueDate: inspectionForm.inspectionDate
                ? new Date(inspectionForm.inspectionDate)
                : new Date(),
            description: JSON.stringify({
                source: 'hr_approved_request',
                inspectionDate: inspectionForm.inspectionDate || null,
                odometerReading: inspectionForm.odometerReading || null,
                overallCondition: inspectionForm.overallCondition || null,
                notes: inspectionForm.notes || '',
                receiverAssessment,
            }),
        };

        try {
            const reviewerEmp = reviewerId
                ? await EmployeeBasic.findById(reviewerId).select('firstName lastName employeeId').lean()
                : null;
            await markInspectionHandoverHistoryApproved(
                asset.vehicleInspectionHandoverHistoryId,
                reviewerEmp,
            );
            if (historyRecord) {
                await applyPendingHandoverAccessoriesToVehicleList(historyRecord).catch(() => null);
            }
        } catch {
            /* non-fatal */
        }

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: {
                    vehicleInspectionStatus: 'active',
                    vehicleInspectionApprovedAt: new Date(),
                    vehicleInspectionApprovedBy: reviewerId || null,
                },
                $unset: {
                    vehicleInspectionSubmittedAt: 1,
                    vehicleInspectionSubmittedBy: 1,
                    vehicleInspectionRequestedBy: 1,
                },
                ...(alreadyHasInspectionRecord ? {} : { $push: { documents: inspectionDoc } }),
            },
        );

        try {
            const DashboardAction = (await import('../models/DashboardAction.js')).default;
            await DashboardAction.updateMany(
                {
                    requestId: asset._id,
                    requestType: 'Vehicle Inspection',
                    status: 'Pending',
                },
                { $set: { status: 'Approved' } },
            );
        } catch {
            /* non-fatal */
        }

        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const historyId = asset.vehicleInspectionHandoverHistoryId;
        const detailUrl = historyId
            ? buildInspectionHandoverDetailsUrl(req, id, historyId)
            : `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}?tab=handover`;

        const requesterEmp = requesterId
            ? await EmployeeBasic.findById(requesterId)
                .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                .lean()
            : null;

        sendInspectionOutcomeEmail({
            submitterEmployee: requesterEmp,
            reviewerName: reviewerDisplayName,
            vehicleLabel,
            detailUrl,
            status: 'approved',
        }).catch(() => { });

        sendInspectionApprovedStakeholderEmails({
            req,
            asset,
            historyId,
            reviewerDisplayName,
        }).catch(() => { });

        if (historyId) {
            const historyRecord = await AssetHistory.findById(historyId)
                .select('assignedTo')
                .lean();
            const assigneeId = historyRecord?.assignedTo;
            if (assigneeId) {
                await syncDashboardAction({
                    requestId: asset._id,
                    requestType: 'Vehicle Inspection',
                    assignedTo: String(assigneeId),
                    status: 'Approved',
                    subjectEmployee: vehicleSubjectForDashboard(asset),
                    requestedByName: reviewerDisplayName,
                    extra1: `[Fleet] ${vehicleLabel} — vehicle inspection approved`,
                    extra2: '',
                    extra3: buildInspectionDashboardExtra3(asset._id, historyId, 'inspection_assignee', {
                        outcome: 'approve',
                    }),
                });
            }
        }

        if (requesterId) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Inspection',
                assignedTo: String(requesterId),
                status: 'Approved',
                subjectEmployee: vehicleSubjectForDashboard(asset),
                requestedByName: reviewerDisplayName,
                extra1: `[Fleet] ${vehicleLabel} — vehicle inspection approved`,
                extra2: '',
                extra3: buildInspectionDashboardExtra3(asset._id, historyId, 'inspection_requester', {
                    outcome: 'approve',
                }),
            });
        }

        const refreshed = await AssetItem.findById(id)
            .populate('typeId', 'name')
            .populate('assignedTo', 'firstName lastName employeeId')
            .lean();

        return res.status(200).json({
            message: 'Vehicle inspection approved and record created.',
            asset: refreshed,
            vehicleInspectionStatus: 'active',
        });
    } catch (err) {
        console.error('approveVehicleInspection:', err);
        return res.status(500).json({ message: err.message || 'Failed to approve vehicle inspection.' });
    }
};

/**
 * POST /api/AssetItem/:id/reject-vehicle-inspection
 */
export const rejectVehicleInspection = async (req, res) => {
    try {
        const { id } = req.params;

        if (!(await canProcessVehicleInspection(req))) {
            return res.status(403).json({ message: 'Only flowchart HR can reject vehicle inspection requests.' });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (String(asset.vehicleInspectionStatus || '').toLowerCase() !== 'pending_hr') {
            return res.status(400).json({ message: 'No pending vehicle inspection request to reject.' });
        }

        const requesterId =
            asset.vehicleInspectionRequestedBy || asset.vehicleInspectionSubmittedBy || null;
        const reviewerId = await resolveProfileActivationSubmitterId(req);
        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

        const pendingHistoryId = asset.vehicleInspectionHandoverHistoryId;
        const pendingHistory = pendingHistoryId
            ? await AssetHistory.findById(pendingHistoryId).select('details').lean()
            : null;
        const isReinspectionReject = pendingHistory?.details?.reinspection === true;
        const restoreActiveAfterReject =
            isReinspectionReject && hasVehicleInspectionHistory(asset);

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: { vehicleInspectionStatus: restoreActiveAfterReject ? 'active' : 'none' },
                $unset: {
                    vehicleInspectionSubmittedAt: 1,
                    vehicleInspectionSubmittedBy: 1,
                    vehicleInspectionRequestedBy: 1,
                    ...(restoreActiveAfterReject
                        ? {}
                        : {
                              vehicleInspectionApprovedAt: 1,
                              vehicleInspectionApprovedBy: 1,
                          }),
                    vehicleInspectionHandoverHistoryId: 1,
                },
            },
        );

        try {
            await markInspectionHandoverHistoryRejected(pendingHistoryId, reviewerId);
        } catch {
            /* non-fatal */
        }

        try {
            const DashboardAction = (await import('../models/DashboardAction.js')).default;
            await DashboardAction.updateMany(
                {
                    requestId: asset._id,
                    requestType: 'Vehicle Inspection',
                    status: 'Pending',
                },
                { $set: { status: 'Rejected' } },
            );
        } catch {
            /* non-fatal */
        }

        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const historyId = asset.vehicleInspectionHandoverHistoryId;
        const detailUrl = historyId
            ? buildInspectionHandoverDetailsUrl(req, id, historyId)
            : `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}?tab=handover`;

        const requesterEmp = requesterId
            ? await EmployeeBasic.findById(requesterId)
                .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                .lean()
            : null;

        sendInspectionOutcomeEmail({
            submitterEmployee: requesterEmp,
            reviewerName: reviewerDisplayName,
            vehicleLabel,
            detailUrl,
            status: 'rejected',
        }).catch(() => { });

        if (requesterId) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Inspection',
                assignedTo: String(requesterId),
                status: 'Rejected',
                subjectEmployee: vehicleSubjectForDashboard(asset),
                requestedByName: reviewerDisplayName,
                extra1: `[Fleet] ${vehicleLabel} — vehicle inspection rejected`,
                extra2: '',
                extra3: buildInspectionDashboardExtra3(asset._id, historyId, 'inspection_requester', {
                    outcome: 'reject',
                }),
            });
        }

        return res.status(200).json({
            message: 'Vehicle inspection request rejected.',
            vehicleInspectionStatus: 'none',
        });
    } catch (err) {
        console.error('rejectVehicleInspection:', err);
        return res.status(500).json({ message: err.message || 'Failed to reject vehicle inspection.' });
    }
};

/**
 * PUT /api/AssetItem/history-record/:historyId/vehicle-inspection-form
 */
export const updateHistoryVehicleInspectionForm = async (req, res) => {
    try {
        const { historyId } = req.params;
        const { vehicleInspectionForm, partial, submitForHr } = req.body;

        if (!vehicleInspectionForm || typeof vehicleInspectionForm !== 'object') {
            return res.status(400).json({ message: 'vehicleInspectionForm is required.' });
        }

        const record = await AssetHistory.findById(historyId);
        if (!record) {
            return res.status(404).json({ message: 'History record not found.' });
        }
        if (String(record.details?.handoverKind || '') !== VEHICLE_INSPECTION_HANDOVER_KIND) {
            return res.status(400).json({ message: 'Not a vehicle inspection handover record.' });
        }

        const asset = await AssetItem.findById(record.assetId)
            .populate('typeId', 'name')
            .populate('assignedTo', 'companyEmail enablePortalAccess employeeId')
            .lean();
        if (!asset) {
            return res.status(404).json({ message: 'Vehicle asset not found.' });
        }
        if (!(await canEditVehicleInspectionForm(req, asset, record))) {
            return res.status(403).json({
                message: 'You cannot edit this inspection form or it has already been submitted.',
            });
        }

        const existing =
            record.details?.vehicleInspectionForm && typeof record.details.vehicleInspectionForm === 'object'
                ? record.details.vehicleInspectionForm
                : {};
        const normalized = normalizeInspectionFormPayload(vehicleInspectionForm);
        const merged = partial
            ? {
                ...existing,
                ...(vehicleInspectionForm.inspectionDate !== undefined
                    ? { inspectionDate: normalized.inspectionDate }
                    : {}),
                ...(vehicleInspectionForm.odometerReading !== undefined
                    ? { odometerReading: normalized.odometerReading }
                    : {}),
                ...(vehicleInspectionForm.overallCondition !== undefined
                    ? { overallCondition: normalized.overallCondition }
                    : {}),
                ...(vehicleInspectionForm.notes !== undefined ? { notes: normalized.notes } : {}),
            }
            : {
                ...existing,
                ...normalized,
            };

        if (!partial || submitForHr) {
            const validationError = validateInspectionFormComplete(merged);
            if (validationError) {
                return res.status(400).json({ message: validationError });
            }
        }

        const detailsBase =
            record.details && typeof record.details === 'object' ? { ...record.details } : {};
        detailsBase.vehicleInspectionForm = merged;

        if (submitForHr) {
            detailsBase.inspectionFormStatus = 'complete';
            detailsBase.inspectionFormCompletedAt = new Date();
        } else if (!partial) {
            detailsBase.inspectionFormStatus = 'draft';
        }

        record.details = detailsBase;
        await record.save();

        if (submitForHr) {
            const submitterId = await resolveProfileActivationSubmitterId(req);
            if (!submitterId) {
                return res.status(400).json({
                    message: 'Your portal login must be linked to an Employee record.',
                });
            }
            await notifyHrForVehicleInspection({
                req,
                asset,
                handoverHistory: record,
                submitterId,
            });
        }

        const refreshed = await AssetHistory.findById(historyId).lean();
        const refreshedAsset = submitForHr
            ? await AssetItem.findById(asset._id).populate('typeId', 'name').lean()
            : asset;

        return res.status(200).json({
            message: submitForHr
                ? 'Inspection form submitted. HR will be notified for approval.'
                : partial
                    ? 'Inspection form draft saved.'
                    : 'Inspection form saved.',
            historyRecord: refreshed,
            vehicleInspectionStatus: submitForHr ? 'pending_hr' : 'draft',
            asset: refreshedAsset,
        });
    } catch (err) {
        console.error('updateHistoryVehicleInspectionForm:', err);
        return res.status(500).json({ message: err.message || 'Failed to save inspection form.' });
    }
};
