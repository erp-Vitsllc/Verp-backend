import { resolveFrontendBaseUrl } from '../utils/resolveFrontendBaseUrl.js';
import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Flowchart from '../models/Flowchart.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { resolveEmployeeEmail } from '../utils/resolveEmployeeEmail.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import { resolveProfileActivationSubmitterId } from '../utils/resolveProfileActivationSubmitterId.js';
import { clearVehicleProfileActivationHoldDashboardRows } from '../utils/clearVehicleProfileActivationHoldDashboardRows.js';
import {
    sendVehicleProfileActivationHoldEmail,
    sendVehicleProfileActivationOutcomeEmail,
    sendVehicleProfileActivationReviewRequestEmail,
    sendVehicleProfileActivatedNotifyMany,
} from '../utils/sendVehicleProfileActivationEmails.js';
import {
    assertVehicleProfileActivationReady,
    VEHICLE_PROFILE_ACTIVATION_SECTION_IDS,
} from '../utils/vehicleProfileCompletion.js';
import {
    userIsFlowchartAdminOfficer,
    userCanDirectAddAssetToPool,
} from '../utils/assetApprovalHelpers.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';

const ALLOWED_SECTIONS = new Set([
    ...VEHICLE_PROFILE_ACTIVATION_SECTION_IDS,
    'warranty',
    'documents',
]);

const SECTION_LABEL = {
    basic: 'Basic details',
    registration: 'Registration card',
    insurance: 'Insurance card',
    profile_picture: 'Profile picture',
    warranty: 'Warranty',
    documents: 'Documents summary',
};

const isFleetVehicleAsset = (asset) => {
    if (!asset) return false;
    const plate = String(asset.plateNumber || '').trim();
    if (plate) return true;
    const tn = String(asset.typeId?.name || '').toLowerCase();
    return (
        tn.includes('vehicle') ||
        tn.includes('car') ||
        tn.includes('fleet') ||
        tn.includes('truck')
    );
};

const trimDesc = (d) => String(d || '').trim();

const sanitizeRowNotesBySectionId = (raw, allowedSectionIds) => {
    const allowed = new Set((allowedSectionIds || []).map(String));
    if (!raw || typeof raw !== 'object' || allowed.size === 0) return null;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        const key = String(k || '').trim();
        if (!allowed.has(key)) continue;
        const note = String(v ?? '').trim();
        if (note) out[key] = note.slice(0, 2000);
    }
    return Object.keys(out).length ? out : null;
};

const assertSubmitPrerequisites = (asset) => assertVehicleProfileActivationReady(asset);

const vehicleSubjectForDashboard = (asset) => ({
    firstName: asset.name || 'Vehicle',
    lastName: `(${asset.assetId || ''})`.trim(),
    employeeId: asset.assetId || '',
    designation: asset.typeId?.name || '',
});

const displayNameFromReq = (req, fallback = 'Colleague') =>
    req.user?.name ||
    [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
    req.user?.employeeId ||
    fallback;

const classifyActivationActor = async (req) => {
    const isHr = await isUserInFlowchart(req.user, 'hr').catch(() => false);
    if (isHr) return { tier: 'hr', isHr: true, isAdminTier: false };

    const isSuper = isJwtSystemSuperUser(req.user);
    const isAdminOfficer = await userIsFlowchartAdminOfficer(req).catch(() => false);
    const isAssetController = await userCanDirectAddAssetToPool(req).catch(() => false);
    const isAdminTier = !!(isSuper || isAdminOfficer || isAssetController);
    if (isAdminTier) {
        return { tier: 'admin_or_super', isHr: false, isAdminTier: true };
    }
    return { tier: 'employee', isHr: false, isAdminTier: false };
};

const canProcessHrStage = async (req) => isUserInFlowchart(req.user, 'hr').catch(() => false);

const canProcessAdminStage = async (req) => {
    const actor = await classifyActivationActor(req);
    return actor.isAdminTier;
};

const resolveEmailCredentials = () => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return { emailUser, emailPass };
};

const listActiveFlowchartEmployees = async () => {
    const rows = await Flowchart.find({ status: 'Active' })
        .populate(
            'empObjectId',
            'firstName lastName employeeId companyEmail workEmail personalEmail email',
        )
        .lean();
    const seen = new Set();
    const list = [];
    for (const row of rows || []) {
        const emp = row.empObjectId;
        const id = emp?._id?.toString?.();
        if (!emp || !id || seen.has(id)) continue;
        seen.add(id);
        list.push(emp);
    }
    return list;
};

const resolveAdminAndAssetController = async () => {
    const [adminRaw, acRaw] = await Promise.all([
        getDepartmentHOD('admincontroller'),
        getDepartmentHOD('assetcontroller'),
    ]);
    const pick = async (raw) => {
        if (!raw) return null;
        if (raw._id && (raw.companyEmail || raw.workEmail || raw.email || raw.personalEmail)) return raw;
        if (raw._id) {
            return EmployeeBasic.findById(raw._id)
                .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                .lean();
        }
        return null;
    };
    const [adminOfficer, assetController] = await Promise.all([pick(adminRaw), pick(acRaw)]);
    return { adminOfficer, assetController };
};

const clearPendingActivationDashboard = async (assetId) => {
    try {
        const DashboardAction = (await import('../models/DashboardAction.js')).default;
        await DashboardAction.deleteMany({
            requestId: assetId,
            requestType: 'Vehicle Profile Activation',
            status: { $in: ['Pending', 'On Hold'] },
        });
    } catch (_e) {
        /* non-fatal */
    }
};

const markActivationDashboardApproved = async (assetId, req, comment = 'Vehicle profile activation approved') => {
    try {
        const DashboardAction = (await import('../models/DashboardAction.js')).default;
        await DashboardAction.updateMany(
            {
                requestId: assetId,
                requestType: 'Vehicle Profile Activation',
                status: { $in: ['Pending', 'On Hold'] },
            },
            {
                status: 'Approved',
                actionedDate: new Date(),
                actionedBy: req.user?.employeeObjectId || req.user?._id,
                comment,
            },
        );
    } catch (e) {
        console.error('[vehicleProfileActivation] dashboard approve', e);
    }
};

const createPendingDashboardForAssignees = async ({
    asset,
    assignees,
    requestedByName,
    extra1,
    extra2,
    viewerRole,
    sections,
}) => {
    const subjectForDash = vehicleSubjectForDashboard(asset);
    const seen = new Set();
    for (const assignee of assignees) {
        const id = assignee?._id?.toString?.();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Profile Activation',
            assignedTo: id,
            status: 'Pending',
            subjectEmployee: subjectForDash,
            requestedByName,
            extra1,
            extra2: extra2 || '',
            extra3: JSON.stringify({
                activationSubject: 'vehicle',
                activationViewerRole: viewerRole,
                includedSections: sections,
                vehicleMongoId: String(asset._id),
            }),
        });
    }
};

const activateVehicleProfile = async ({ asset, id, req, origin }) => {
    await AssetItem.updateOne(
        { _id: id },
        {
            $set: {
                vehicleProfileActivationStatus: 'active',
                vehicleProfileActivationOrigin: origin || asset.vehicleProfileActivationOrigin || 'none',
            },
            $unset: {
                vehicleProfileActivationHold: 1,
                vehicleProfileActivationSubmittedAt: 1,
                vehicleProfileActivationSubmittedBy: 1,
                vehicleProfileActivationDescription: 1,
                vehicleProfileActivationSections: 1,
                actionRequiredBy: 1,
            },
        },
    );

    if (['Pending', 'Submitted for Approval'].includes(String(asset.status || ''))) {
        await AssetItem.updateOne(
            { _id: id },
            {
                $set: {
                    status: asset.assignedTo || asset.assignedCompany ? 'Assigned' : 'Unassigned',
                },
            },
        );
    }

    await markActivationDashboardApproved(asset._id, req);

    const baseUrl = resolveFrontendBaseUrl(req);
    const detailUrl = `${baseUrl}/HRM/Asset/Vehicle/details/${id}`;
    const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
    const activatedByName = displayNameFromReq(req, 'HR');
    const effectiveOrigin = String(origin || asset.vehicleProfileActivationOrigin || 'hr').toLowerCase();

    const { adminOfficer, assetController } = await resolveAdminAndAssetController();
    const recipients = [];

    if (effectiveOrigin === 'employee') {
        const submitterId = asset.vehicleProfileActivationSubmittedBy || null;
        if (submitterId) {
            const submitterEmp = await EmployeeBasic.findById(submitterId)
                .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                .lean();
            if (submitterEmp) recipients.push(submitterEmp);
        }
        const flowchartPeople = await listActiveFlowchartEmployees();
        recipients.push(...flowchartPeople);
    } else {
        if (adminOfficer) recipients.push(adminOfficer);
        if (assetController) recipients.push(assetController);
    }

    sendVehicleProfileActivatedNotifyMany({
        recipients,
        vehicleLabel,
        detailUrl,
        activatedByName,
    }).catch(() => {});

    try {
        const AssetHistory = (await import('../models/AssetHistory.js')).default;
        await AssetHistory.create({
            assetId: asset._id,
            action: 'Update',
            performedBy: req.user?.employeeObjectId || req.user?._id || null,
            comments: 'Vehicle profile activation approved — status Active.',
            details: { type: 'VehicleProfileActivationApprove', origin: effectiveOrigin },
        });
    } catch (_h) {
        /* non-fatal */
    }
};

/**
 * Route a completed profile to the next approver tier (or activate if HR).
 * POST /api/AssetItem/:id/submit-vehicle-profile-activation
 */
export const submitVehicleProfileActivation = async (req, res) => {
    try {
        const { id } = req.params;
        const { description = '', includedSections = [] } = req.body || {};
        const sections = Array.isArray(includedSections)
            ? [...new Set(includedSections.map((s) => String(s || '').trim()).filter(Boolean))]
            : [];

        for (const s of sections) {
            if (!ALLOWED_SECTIONS.has(s)) {
                return res.status(400).json({ message: `Invalid section: ${s}` });
            }
        }
        if (sections.length === 0) {
            return res.status(400).json({ message: 'Select at least one item to include in this request.' });
        }

        const asset = await AssetItem.findById(id)
            .populate('typeId', 'name')
            .populate('assignedTo', 'firstName lastName employeeId')
            .lean();

        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({
                message: 'Vehicle profile activation is only available for fleet vehicle assets.',
            });
        }

        const status = String(asset.vehicleProfileActivationStatus || 'inactive').toLowerCase();
        if (status === 'active') {
            return res.status(400).json({ message: 'This vehicle profile is already activated.' });
        }

        const hold = asset.vehicleProfileActivationHold || null;
        const heldSectionList = Array.isArray(hold?.unapprovedSections)
            ? hold.unapprovedSections.map(String)
            : [];
        const isResubmitAfterHold =
            (status === 'submitted' || status === 'pending_admin') && heldSectionList.length > 0;
        const isFreshAfterReject = status === 'rejected';

        if ((status === 'submitted' || status === 'pending_admin') && !isResubmitAfterHold) {
            return res.status(400).json({
                message: 'This vehicle is already awaiting profile activation review.',
            });
        }

        const prereqErr = assertSubmitPrerequisites(asset);
        if (prereqErr) return res.status(400).json({ message: prereqErr });

        const submitterId = await resolveProfileActivationSubmitterId(req);
        if (!submitterId) {
            return res.status(400).json({
                message:
                    'Your portal login must be linked to an Employee record before you can submit. Check user → employee mapping.',
            });
        }

        if (isResubmitAfterHold) {
            if (String(asset.vehicleProfileActivationSubmittedBy || '') !== String(submitterId)) {
                return res.status(403).json({
                    message: 'Only the employee who submitted this request can resubmit after a hold.',
                });
            }
            const missing = heldSectionList.filter((s) => !sections.includes(String(s)));
            if (missing.length) {
                return res.status(400).json({
                    message: `This resubmission must include every section that was on hold: ${missing.join(', ')}.`,
                });
            }
        }

        const creds = resolveEmailCredentials();
        if (!creds) {
            return res.status(500).json({ message: 'Email credentials are not configured on the server.' });
        }

        const actor = await classifyActivationActor(req);
        const requestedByName = displayNameFromReq(req);
        const baseUrl = resolveFrontendBaseUrl(req);
        const detailUrl = `${baseUrl}/HRM/Asset/Vehicle/details/${id}`;
        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const descText = String(description || '').trim();
        const sectionsHtml = sections.map((s) => `<li>${SECTION_LABEL[s] || s}</li>`).join('');
        const sectionLabels = sections.map((s) => SECTION_LABEL[s] || s).join(', ');

        if (isResubmitAfterHold || isFreshAfterReject) {
            await clearVehicleProfileActivationHoldDashboardRows(asset._id);
            await clearPendingActivationDashboard(asset._id);
        }

        // --- HR: activate immediately ---
        if (actor.tier === 'hr') {
            await AssetItem.updateOne(
                { _id: id },
                {
                    $set: {
                        vehicleProfileActivationSubmittedAt: new Date(),
                        vehicleProfileActivationSubmittedBy: submitterId,
                        vehicleProfileActivationDescription: descText || '',
                        vehicleProfileActivationSections: sections,
                        vehicleProfileActivationOrigin: 'hr',
                    },
                    $unset: { vehicleProfileActivationHold: 1 },
                },
            );
            const fresh = await AssetItem.findById(id).populate('typeId', 'name').lean();
            await activateVehicleProfile({ asset: fresh || asset, id, req, origin: 'hr' });
            const refreshed = await AssetItem.findById(id)
                .populate('typeId', 'name')
                .populate('assignedTo', 'firstName lastName employeeId')
                .lean();
            return res.status(200).json({
                message: 'Vehicle profile activated. Admin Officer and Asset Controller have been emailed.',
                asset: refreshed,
                vehicleProfileActivationStatus: 'active',
                routedTo: 'active',
            });
        }

        // --- Admin Officer / Asset Controller / Superuser → HR ---
        if (actor.tier === 'admin_or_super') {
            const designatedHr = await getDepartmentHOD('hr');
            if (!designatedHr?._id) {
                return res.status(400).json({
                    message: 'No HR assignee is configured in the company flowchart for this workflow.',
                });
            }
            const { email: hrEmail } = resolveEmployeeEmail(designatedHr);
            if (!hrEmail || !String(hrEmail).trim()) {
                return res.status(400).json({
                    message: 'The flowchart HR assignee does not have a resolvable email address.',
                });
            }

            await sendVehicleProfileActivationReviewRequestEmail({
                recipientEmployee: designatedHr,
                reviewerRoleLabel: 'HR',
                vehicleLabel,
                detailUrl,
                sectionsHtml,
                noteText: descText,
                requesterName: requestedByName,
            });

            await createPendingDashboardForAssignees({
                asset,
                assignees: [designatedHr],
                requestedByName,
                extra1: `[Fleet] ${vehicleLabel} — profile awaiting HR approval (${sectionLabels})`,
                extra2: descText,
                viewerRole: 'flowchart_hr',
                sections,
            });

            await AssetItem.updateOne(
                { _id: id },
                {
                    $set: {
                        vehicleProfileActivationStatus: 'submitted',
                        vehicleProfileActivationSubmittedAt: new Date(),
                        vehicleProfileActivationSubmittedBy: submitterId,
                        vehicleProfileActivationDescription: descText || '',
                        vehicleProfileActivationSections: sections,
                        vehicleProfileActivationOrigin: 'admin_or_super',
                        actionRequiredBy: designatedHr._id,
                    },
                    $unset: { vehicleProfileActivationHold: 1 },
                },
            );

            try {
                const AssetHistory = (await import('../models/AssetHistory.js')).default;
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Update',
                    performedBy: submitterId,
                    comments: `Approved vehicle profile — sent to HR for activation (${sections.join(', ')}).`,
                    details: {
                        type: 'VehicleProfileActivationSubmit',
                        routedTo: 'hr',
                        sections,
                        description: descText,
                    },
                });
            } catch (hErr) {
                console.error('[submitVehicleProfileActivation] history log failed:', hErr?.message || hErr);
            }

            return res.status(200).json({
                message:
                    'Sent to HR for activation. HR has been emailed and will see the task on their dashboard.',
                vehicleProfileActivationStatus: 'submitted',
                routedTo: 'hr',
            });
        }

        // --- Other users → Admin Officer + Asset Controller ---
        const { adminOfficer, assetController } = await resolveAdminAndAssetController();
        const adminAssignees = [adminOfficer, assetController].filter((e) => e?._id);
        if (!adminAssignees.length) {
            return res.status(400).json({
                message:
                    'No Admin Officer or Asset Controller is configured in the company flowchart for this workflow.',
            });
        }

        for (const assignee of adminAssignees) {
            await sendVehicleProfileActivationReviewRequestEmail({
                recipientEmployee: assignee,
                reviewerRoleLabel: 'Admin Officer / Asset Controller',
                vehicleLabel,
                detailUrl,
                sectionsHtml,
                noteText: descText,
                requesterName: requestedByName,
            }).catch(() => {});
        }

        await createPendingDashboardForAssignees({
            asset,
            assignees: adminAssignees,
            requestedByName,
            extra1: `[Fleet] ${vehicleLabel} — profile awaiting Admin Officer / Asset Controller approval (${sectionLabels})`,
            extra2: descText,
            viewerRole: 'flowchart_admin',
            sections,
        });

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: {
                    vehicleProfileActivationStatus: 'pending_admin',
                    vehicleProfileActivationSubmittedAt: new Date(),
                    vehicleProfileActivationSubmittedBy: submitterId,
                    vehicleProfileActivationDescription: descText || '',
                    vehicleProfileActivationSections: sections,
                    vehicleProfileActivationOrigin: 'employee',
                    actionRequiredBy: adminAssignees[0]._id,
                },
                $unset: { vehicleProfileActivationHold: 1 },
            },
        );

        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: submitterId,
                comments: `Submitted vehicle profile for Admin Officer / Asset Controller review (${sections.join(', ')}).`,
                details: {
                    type: 'VehicleProfileActivationSubmit',
                    routedTo: 'admin',
                    sections,
                    description: descText,
                },
            });
        } catch (hErr) {
            console.error('[submitVehicleProfileActivation] history log failed:', hErr?.message || hErr);
        }

        return res.status(200).json({
            message:
                'Submitted for Admin Officer / Asset Controller review. They have been emailed and will see the task on their dashboard.',
            vehicleProfileActivationStatus: 'pending_admin',
            routedTo: 'admin',
        });
    } catch (err) {
        console.error('submitVehicleProfileActivation:', err);
        return res.status(500).json({ message: err.message || 'Failed to submit vehicle profile activation.' });
    }
};

/**
 * Approve at current stage:
 * - pending_admin → Admin Officer / AC / superuser forwards to HR
 * - submitted → HR activates
 * POST /api/AssetItem/:id/approve-vehicle-profile-activation
 */
export const approveVehicleProfileActivation = async (req, res) => {
    try {
        const { id } = req.params;
        const approvedSections = Array.isArray(req.body?.approvedSections)
            ? req.body.approvedSections.map((s) => String(s || '').trim()).filter(Boolean)
            : [];
        const selectionProvided = req.body?.selectionProvided === true;

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }

        const status = String(asset.vehicleProfileActivationStatus || '').toLowerCase();
        if (status !== 'submitted' && status !== 'pending_admin') {
            return res.status(400).json({ message: 'This vehicle is not awaiting profile activation review.' });
        }

        const hold = asset.vehicleProfileActivationHold || null;
        const heldSectionList = Array.isArray(hold?.unapprovedSections)
            ? hold.unapprovedSections.map(String)
            : [];
        if (heldSectionList.length > 0) {
            return res.status(400).json({
                message: 'This request is on hold. The submitter must resubmit before it can be approved.',
            });
        }

        const requested = [...new Set((asset.vehicleProfileActivationSections || []).map(String))].filter(
            (s) => ALLOWED_SECTIONS.has(s),
        );
        if (!selectionProvided) {
            return res.status(400).json({
                message:
                    'Confirm acceptance with the section checklist (all items must be checked to accept).',
            });
        }
        if (selectionProvided) {
            const sortedReq = [...requested].sort().join(',');
            const sortedApr = [...new Set(approvedSections)].sort().join(',');
            if (!requested.length || sortedReq !== sortedApr) {
                return res.status(400).json({
                    message:
                        'Accept requires every section in this request to be checked, or use Hold when only some are acceptable.',
                });
            }
        }

        const baseUrl = resolveFrontendBaseUrl(req);
        const detailUrl = `${baseUrl}/HRM/Asset/Vehicle/details/${id}`;
        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const requestedByName = displayNameFromReq(req);
        const sections = requested;
        const sectionsHtml = sections.map((s) => `<li>${SECTION_LABEL[s] || s}</li>`).join('');
        const sectionLabels = sections.map((s) => SECTION_LABEL[s] || s).join(', ');
        const descText = trimDesc(asset.vehicleProfileActivationDescription);

        // --- Admin tier: forward to HR ---
        if (status === 'pending_admin') {
            if (!(await canProcessAdminStage(req))) {
                return res.status(403).json({
                    message:
                        'Only Admin Officer, Asset Controller, or a system superuser can approve at this stage.',
                });
            }

            const designatedHr = await getDepartmentHOD('hr');
            if (!designatedHr?._id) {
                return res.status(400).json({
                    message: 'No HR assignee is configured in the company flowchart for this workflow.',
                });
            }

            await clearPendingActivationDashboard(asset._id);

            await sendVehicleProfileActivationReviewRequestEmail({
                recipientEmployee: designatedHr,
                reviewerRoleLabel: 'HR',
                vehicleLabel,
                detailUrl,
                sectionsHtml,
                noteText: descText,
                requesterName: requestedByName,
            });

            await createPendingDashboardForAssignees({
                asset,
                assignees: [designatedHr],
                requestedByName,
                extra1: `[Fleet] ${vehicleLabel} — profile awaiting HR approval (${sectionLabels})`,
                extra2: descText,
                viewerRole: 'flowchart_hr',
                sections,
            });

            await AssetItem.updateOne(
                { _id: id },
                {
                    $set: {
                        vehicleProfileActivationStatus: 'submitted',
                        actionRequiredBy: designatedHr._id,
                    },
                    $unset: { vehicleProfileActivationHold: 1 },
                },
            );

            try {
                const AssetHistory = (await import('../models/AssetHistory.js')).default;
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Update',
                    performedBy: req.user?.employeeObjectId || req.user?._id || null,
                    comments: 'Admin Officer / Asset Controller approved — sent to HR for activation.',
                    details: { type: 'VehicleProfileActivationAdminApprove', routedTo: 'hr' },
                });
            } catch (_h) {
                /* non-fatal */
            }

            const refreshed = await AssetItem.findById(id)
                .populate('typeId', 'name')
                .populate('assignedTo', 'firstName lastName employeeId')
                .lean();
            return res.status(200).json({
                message: 'Approved and sent to HR. HR has been emailed and will see the dashboard task.',
                asset: refreshed,
                vehicleProfileActivationStatus: 'submitted',
                routedTo: 'hr',
            });
        }

        // --- HR stage: activate ---
        if (!(await canProcessHrStage(req))) {
            return res.status(403).json({
                message: 'Only the flowchart HR assignee can approve this request.',
            });
        }

        const origin = String(asset.vehicleProfileActivationOrigin || 'admin_or_super').toLowerCase();
        await activateVehicleProfile({ asset, id, req, origin });

        const refreshed = await AssetItem.findById(id)
            .populate('typeId', 'name')
            .populate('assignedTo', 'firstName lastName employeeId')
            .lean();
        return res.status(200).json({
            message:
                origin === 'employee'
                    ? 'Vehicle profile activated. The submitter and flowchart assignees have been emailed.'
                    : 'Vehicle profile activated. Admin Officer and Asset Controller have been emailed.',
            asset: refreshed,
            vehicleProfileActivationStatus: 'active',
            routedTo: 'active',
        });
    } catch (err) {
        console.error('approveVehicleProfileActivation:', err);
        return res.status(500).json({ message: err.message || 'Failed to approve vehicle profile activation.' });
    }
};

/**
 * POST /api/AssetItem/:id/hold-vehicle-profile-activation
 */
export const holdVehicleProfileActivation = async (req, res) => {
    try {
        const { id } = req.params;
        const approvedSections = Array.isArray(req.body?.approvedSections)
            ? req.body.approvedSections.map((s) => String(s || '').trim()).filter(Boolean)
            : [];
        const selectionProvided = req.body?.selectionProvided === true;
        const comment = String(req.body?.comment || '').trim();

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }

        const status = String(asset.vehicleProfileActivationStatus || '').toLowerCase();
        if (status !== 'submitted' && status !== 'pending_admin') {
            return res.status(400).json({ message: 'This vehicle is not awaiting profile activation review.' });
        }

        if (status === 'submitted') {
            if (!(await canProcessHrStage(req))) {
                return res.status(403).json({
                    message: 'Only the flowchart HR assignee can hold this request.',
                });
            }
        } else if (!(await canProcessAdminStage(req))) {
            return res.status(403).json({
                message:
                    'Only Admin Officer, Asset Controller, or a system superuser can hold this request.',
            });
        }

        const requested = [...new Set((asset.vehicleProfileActivationSections || []).map(String))].filter(
            (s) => ALLOWED_SECTIONS.has(s),
        );
        if (!selectionProvided) {
            return res.status(400).json({
                message:
                    'Confirm which sections you accept (checked); unchecked sections return to the submitter.',
            });
        }
        if (!requested.length) {
            return res.status(400).json({ message: 'There are no sections in this submission to hold against.' });
        }

        const invalid = approvedSections.filter((s) => !requested.includes(String(s)));
        if (invalid.length) {
            return res.status(400).json({
                message: 'Approved selection references sections that are not part of this request.',
            });
        }

        const approvedSet = new Set(approvedSections);
        const unapproved = requested.filter((s) => !approvedSet.has(s));
        if (!unapproved.length) {
            return res.status(400).json({
                message:
                    'Nothing left to hold — use Accept when every section in this request is acceptable.',
            });
        }

        const rowNotesBySectionId = sanitizeRowNotesBySectionId(req.body?.rowNotesBySectionId, unapproved);

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: {
                    vehicleProfileActivationHold: {
                        heldAt: new Date(),
                        unapprovedSections: unapproved,
                        comment: comment || '',
                        ...(rowNotesBySectionId ? { rowNotesBySectionId } : {}),
                    },
                },
            },
        );

        const submitterId = asset.vehicleProfileActivationSubmittedBy || null;
        const submitterEmp = submitterId
            ? await EmployeeBasic.findById(submitterId)
                  .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                  .lean()
            : null;

        const subjectForDash = vehicleSubjectForDashboard(asset);
        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const sectionLabels = unapproved.map((s) => SECTION_LABEL[s] || s);
        const holdExtra1 = `[Fleet] On hold — update: ${sectionLabels.join(', ')}`;
        const reviewerRole = status === 'submitted' ? 'HR' : 'Admin Officer / Asset Controller';

        try {
            const DashboardAction = (await import('../models/DashboardAction.js')).default;
            await DashboardAction.deleteMany({
                requestId: asset._id,
                requestType: 'Vehicle Profile Activation',
                status: 'Pending',
            });
        } catch (_e) {
            /* non-fatal */
        }

        const reviewerDisplayName = displayNameFromReq(req, reviewerRole);

        let keepAssignee = null;
        if (status === 'submitted') {
            keepAssignee = await getDepartmentHOD('hr');
        } else {
            const adminTier = await resolveAdminAndAssetController();
            keepAssignee = adminTier.adminOfficer || adminTier.assetController;
        }

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Profile Activation',
            assignedTo: keepAssignee?._id ? String(keepAssignee._id) : '',
            status: 'On Hold',
            skipPendingCompletion: true,
            subjectEmployee: { ...subjectForDash, _id: asset._id },
            vehicleProfileActivationNotifyAssignee: submitterEmp || undefined,
            requestedByName: reviewerDisplayName,
            actionedBy: req.user?.employeeObjectId || req.user?._id,
            comment: comment || sectionLabels.join(', '),
            extra1: holdExtra1,
            extra2: trimDesc(asset.vehicleProfileActivationDescription),
            extra3: JSON.stringify({
                activationSubject: 'vehicle',
                activationViewerRole: 'submitter',
                unapprovedSections: unapproved,
                vehicleMongoId: String(asset._id),
            }),
        });

        const baseUrl = resolveFrontendBaseUrl(req);
        const detailUrl = `${baseUrl}/HRM/Asset/Vehicle/details/${id}`;
        const notesObj = rowNotesBySectionId || {};
        const holdItems = unapproved.map((sid) => ({
            sectionId: sid,
            label: SECTION_LABEL[sid] || sid,
            note: notesObj[sid] || '',
        }));

        sendVehicleProfileActivationHoldEmail({
            submitterEmployee: submitterEmp,
            acName: reviewerDisplayName,
            vehicleLabel,
            detailUrl,
            holdItems,
            comment,
        }).catch(() => {});

        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: req.user?.employeeObjectId || req.user?._id || null,
                comments: `Vehicle profile activation on hold — sections: ${unapproved.join(', ')}.`,
                details: { type: 'VehicleProfileActivationHold', unapprovedSections: unapproved, comment },
            });
        } catch (_h) {
            /* non-fatal */
        }

        const refreshed = await AssetItem.findById(id)
            .populate('typeId', 'name')
            .populate('assignedTo', 'firstName lastName employeeId')
            .lean();
        return res.status(200).json({
            message: 'Request placed on hold. The submitter was notified by email and dashboard.',
            asset: refreshed,
        });
    } catch (err) {
        console.error('holdVehicleProfileActivation:', err);
        return res.status(500).json({ message: err.message || 'Failed to hold vehicle profile activation.' });
    }
};

/**
 * POST /api/AssetItem/:id/reject-vehicle-profile-activation
 */
export const rejectVehicleProfileActivation = async (req, res) => {
    try {
        const { id } = req.params;
        const reason = String(req.body?.reason || '').trim();
        if (!reason) {
            return res.status(400).json({ message: 'Rejection reason is required.' });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }

        const status = String(asset.vehicleProfileActivationStatus || '').toLowerCase();
        if (status !== 'submitted' && status !== 'pending_admin') {
            return res.status(400).json({ message: 'This vehicle is not awaiting profile activation review.' });
        }

        if (status === 'submitted') {
            if (!(await canProcessHrStage(req))) {
                return res.status(403).json({
                    message: 'Only the flowchart HR assignee can reject this request.',
                });
            }
        } else if (!(await canProcessAdminStage(req))) {
            return res.status(403).json({
                message:
                    'Only Admin Officer, Asset Controller, or a system superuser can reject this request.',
            });
        }

        const submitterId = asset.vehicleProfileActivationSubmittedBy || null;
        const submitterEmp = submitterId
            ? await EmployeeBasic.findById(submitterId)
                  .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                  .lean()
            : null;

        const reviewerDisplayName = displayNameFromReq(req, status === 'submitted' ? 'HR' : 'Administrator');

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: {
                    vehicleProfileActivationStatus: 'rejected',
                },
                $unset: {
                    vehicleProfileActivationHold: 1,
                    vehicleProfileActivationSubmittedAt: 1,
                    vehicleProfileActivationSubmittedBy: 1,
                    vehicleProfileActivationDescription: 1,
                    vehicleProfileActivationSections: 1,
                    vehicleProfileActivationOrigin: 1,
                },
            },
        );

        try {
            const DashboardAction = (await import('../models/DashboardAction.js')).default;
            await DashboardAction.updateMany(
                {
                    requestId: asset._id,
                    requestType: 'Vehicle Profile Activation',
                    status: { $in: ['Pending', 'On Hold'] },
                },
                {
                    status: 'Rejected',
                    actionedDate: new Date(),
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: reason,
                },
            );
        } catch (e) {
            console.error('[rejectVehicleProfileActivation] dashboard', e);
        }

        const subjectForDash = vehicleSubjectForDashboard(asset);
        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        if (submitterEmp?._id) {
            try {
                await syncDashboardAction({
                    requestId: asset._id,
                    requestType: 'Vehicle Profile Activation',
                    assignedTo: String(submitterEmp._id),
                    status: 'Rejected',
                    skipPendingCompletion: true,
                    subjectEmployee: { ...subjectForDash, _id: asset._id },
                    vehicleProfileActivationNotifyAssignee: submitterEmp,
                    requestedByName: reviewerDisplayName,
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: reason,
                    extra2: reason.slice(0, 500),
                    extra3: JSON.stringify({
                        activationSubject: 'vehicle',
                        activationViewerRole: 'submitter',
                        vehicleMongoId: String(asset._id),
                        outcome: 'reject',
                    }),
                });
            } catch (_syncErr) {
                console.error('[rejectVehicleProfileActivation] sync error:', _syncErr);
            }
        }

        const baseUrl = resolveFrontendBaseUrl(req);
        const detailUrl = `${baseUrl}/HRM/Asset/Vehicle/details/${id}`;
        sendVehicleProfileActivationOutcomeEmail({
            submitterEmployee: submitterEmp,
            acName: reviewerDisplayName,
            vehicleLabel,
            detailUrl,
            status: 'rejected',
            reason,
        }).catch(() => {});

        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: req.user?.employeeObjectId || req.user?._id || null,
                comments: `Vehicle profile activation rejected: ${reason}`,
                details: { type: 'VehicleProfileActivationReject', reason },
            });
        } catch (_h) {
            /* non-fatal */
        }

        const refreshed = await AssetItem.findById(id)
            .populate('typeId', 'name')
            .populate('assignedTo', 'firstName lastName employeeId')
            .lean();
        return res.status(200).json({
            message: 'Vehicle profile activation request rejected.',
            asset: refreshed,
            vehicleProfileActivationStatus: 'rejected',
        });
    } catch (err) {
        console.error('rejectVehicleProfileActivation:', err);
        return res.status(500).json({ message: err.message || 'Failed to reject vehicle profile activation.' });
    }
};
