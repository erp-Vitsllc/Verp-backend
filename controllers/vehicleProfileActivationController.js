import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl, emailFrontendUrl } from '../utils/resolveFrontendBaseUrl.js';
import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { resolveEmployeeEmail } from '../utils/resolveEmployeeEmail.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import { resolveProfileActivationSubmitterId } from '../utils/resolveProfileActivationSubmitterId.js';
import { clearVehicleProfileActivationHoldDashboardRows } from '../utils/clearVehicleProfileActivationHoldDashboardRows.js';
import {
    sendVehicleProfileActivationHoldEmail,
    sendVehicleProfileActivationOutcomeEmail,
} from '../utils/sendVehicleProfileActivationEmails.js';
import {
    assertVehicleProfileActivationReady,
    VEHICLE_PROFILE_ACTIVATION_SECTION_IDS,
} from '../utils/vehicleProfileCompletion.js';

const normType = (t) => String(t || '').toLowerCase().trim();

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

const canProcessVehicleProfileActivation = async (req) =>
    isUserInFlowchart(req.user, 'hr').catch(() => false);

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

/**
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

        const asset = await AssetItem.findById(id).populate('typeId', 'name').populate('assignedTo', 'firstName lastName employeeId').lean();

        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Vehicle profile activation is only available for fleet vehicle assets.' });
        }

        const status = String(asset.vehicleProfileActivationStatus || 'inactive').toLowerCase();
        if (status === 'active') {
            return res.status(400).json({ message: 'This vehicle profile is already activated.' });
        }

        const hold = asset.vehicleProfileActivationHold || null;
        const heldSectionList = Array.isArray(hold?.unapprovedSections) ? hold.unapprovedSections.map(String) : [];
        const isResubmitAfterHold = status === 'submitted' && heldSectionList.length > 0;
        const isFreshAfterReject = status === 'rejected';

        if (status === 'submitted' && !isResubmitAfterHold) {
            return res.status(400).json({ message: 'This vehicle is already submitted for profile activation review.' });
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
                return res.status(403).json({ message: 'Only the employee who submitted this request can resubmit after a hold.' });
            }
            const missing = heldSectionList.filter((s) => !sections.includes(String(s)));
            if (missing.length) {
                return res.status(400).json({
                    message: `This resubmission must include every section that was on hold: ${missing.join(', ')}.`,
                });
            }
        }

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

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) {
            return res.status(500).json({ message: 'Email credentials are not configured on the server.' });
        }

        const transporter = nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const hrGreetingName = `${designatedHr.firstName || ''} ${designatedHr.lastName || ''}`.trim() || 'HR';
        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        const baseUrl = resolveFrontendBaseUrl(req);
        const detailUrl = `${baseUrl}/HRM/Asset/Vehicle/details/${id}`;
        const descText = String(description || '').trim();
        const sectionsHtml = sections.map((s) => `<li>${SECTION_LABEL[s] || s}</li>`).join('');

        const html = `
            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 640px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                <div style="background-color: #059669; color: white; padding: 20px; text-align: center;">
                    <h2 style="margin: 0;">Vehicle profile — activation review</h2>
                </div>
                <div style="padding: 28px;">
                    <p>Hello <strong>${hrGreetingName}</strong>,</p>
                    <p>A colleague ${isResubmitAfterHold || isFreshAfterReject ? '<strong>re-submitted</strong> ' : ''}completed the vehicle profile checklist and sent it for <strong>your review</strong> as <strong>HR</strong> (flowchart).</p>
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 18px 0;">
                        <p style="margin:0;"><strong>Vehicle:</strong> ${vehicleLabel}</p>
                        <p style="margin:8px 0 0 0;"><strong>Sections in this request:</strong></p>
                        <ul style="margin:8px 0 0 18px;">${sectionsHtml}</ul>
                        ${descText ? `<p style="margin:12px 0 0 0;"><strong>Note from submitter:</strong><br/>${descText.replace(/\n/g, '<br/>')}</p>` : ''}
                    </div>
                    <p style="text-align:center;margin:28px 0;">
                        <a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 26px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">Open vehicle in VeRP</a>
                    </p>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to: hrEmail,
            subject: `${isResubmitAfterHold || isFreshAfterReject ? 'Re-submitted: ' : ''}Vehicle profile review: ${vehicleLabel}`,
            html,
        });

        const requestedByName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            req.user?.employeeId ||
            '';

        const subjectForDash = vehicleSubjectForDashboard(asset);

        if (isResubmitAfterHold || isFreshAfterReject) {
            await clearVehicleProfileActivationHoldDashboardRows(asset._id);
            const DashboardAction = (await import('../models/DashboardAction.js')).default;
            await DashboardAction.deleteMany({
                requestId: asset._id,
                requestType: 'Vehicle Profile Activation',
            });
        }

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Profile Activation',
            assignedTo: String(designatedHr._id),
            status: 'Pending',
            subjectEmployee: subjectForDash,
            requestedByName,
            extra1: `[Fleet] ${vehicleLabel} — profile submitted (${sections.map((s) => SECTION_LABEL[s] || s).join(', ')})`,
            extra2: descText || '',
            extra3: JSON.stringify({
                activationSubject: 'vehicle',
                activationViewerRole: 'flowchart_hr',
                includedSections: sections,
                vehicleMongoId: String(asset._id),
            }),
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
                comments: `${isResubmitAfterHold || isFreshAfterReject ? 'Re-submitted' : 'Submitted'} vehicle profile for activation review (${sections.join(', ')}).`,
                details: { type: 'VehicleProfileActivationSubmit', sections, description: descText, resubmitAfterHold: !!(isResubmitAfterHold || isFreshAfterReject) },
            });
        } catch (hErr) {
            console.error('[submitVehicleProfileActivation] history log failed:', hErr?.message || hErr);
        }

        return res.status(200).json({
            message:
                'Submitted for review. HR has been emailed and will see the task on their dashboard.',
            vehicleProfileActivationStatus: 'submitted',
        });
    } catch (err) {
        console.error('submitVehicleProfileActivation:', err);
        return res.status(500).json({ message: err.message || 'Failed to submit vehicle profile activation.' });
    }
};

/**
 * POST /api/AssetItem/:id/approve-vehicle-profile-activation
 */
export const approveVehicleProfileActivation = async (req, res) => {
    try {
        const { id } = req.params;
        const approvedSections = Array.isArray(req.body?.approvedSections)
            ? req.body.approvedSections.map((s) => String(s || '').trim()).filter(Boolean)
            : [];
        const selectionProvided = req.body?.selectionProvided === true;

        if (!(await canProcessVehicleProfileActivation(req))) {
            return res.status(403).json({
                message: 'Only the flowchart HR assignee can approve this request.',
            });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }
        if (String(asset.vehicleProfileActivationStatus || '').toLowerCase() !== 'submitted') {
            return res.status(400).json({ message: 'This vehicle is not awaiting profile activation review.' });
        }

        const requested = [...new Set((asset.vehicleProfileActivationSections || []).map(String))].filter((s) => ALLOWED_SECTIONS.has(s));
        if (!selectionProvided) {
            return res.status(400).json({
                message: 'Confirm acceptance with the section checklist (all items must be checked to accept).',
            });
        }
        if (selectionProvided) {
            const sortedReq = [...requested].sort().join(',');
            const sortedApr = [...new Set(approvedSections)].sort().join(',');
            if (!requested.length || sortedReq !== sortedApr) {
                return res.status(400).json({
                    message: 'Accept requires every section in this request to be checked, or use Hold when only some are acceptable.',
                });
            }
        }

        const submitterId = asset.vehicleProfileActivationSubmittedBy || null;
        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: {
                    vehicleProfileActivationStatus: 'active',
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

        try {
            const DashboardAction = (await import('../models/DashboardAction.js')).default;
            await DashboardAction.updateMany(
                {
                    requestId: asset._id,
                    requestType: 'Vehicle Profile Activation',
                    status: { $in: ['Pending', 'On Hold'] },
                },
                {
                    status: 'Approved',
                    actionedDate: new Date(),
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: 'Vehicle profile activation approved',
                },
            );
        } catch (e) {
            console.error('[approveVehicleProfileActivation] dashboard', e);
        }

        const submitterEmp = submitterId
            ? await EmployeeBasic.findById(submitterId)
                  .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                  .lean()
            : null;
        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        const baseUrl = resolveFrontendBaseUrl(req);
        const detailUrl = `${baseUrl}/HRM/Asset/Vehicle/details/${id}`;
        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        sendVehicleProfileActivationOutcomeEmail({
            submitterEmployee: submitterEmp,
            acName: reviewerDisplayName,
            vehicleLabel,
            detailUrl,
            status: 'approved',
        }).catch(() => {});

        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: req.user?.employeeObjectId || req.user?._id || null,
                comments: 'Vehicle profile activation approved by HR.',
                details: { type: 'VehicleProfileActivationApprove' },
            });
        } catch (_h) {
            /* non-fatal */
        }

        const refreshed = await AssetItem.findById(id).populate('typeId', 'name').populate('assignedTo', 'firstName lastName employeeId').lean();
        return res.status(200).json({
            message: 'Vehicle profile activation approved.',
            asset: refreshed,
            vehicleProfileActivationStatus: 'active',
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

        if (!(await canProcessVehicleProfileActivation(req))) {
            return res.status(403).json({
                message: 'Only the flowchart HR assignee can hold this request.',
            });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }
        if (String(asset.vehicleProfileActivationStatus || '').toLowerCase() !== 'submitted') {
            return res.status(400).json({ message: 'This vehicle is not awaiting profile activation review.' });
        }

        const requested = [...new Set((asset.vehicleProfileActivationSections || []).map(String))].filter((s) => ALLOWED_SECTIONS.has(s));
        if (!selectionProvided) {
            return res.status(400).json({
                message: 'Confirm which sections you accept (checked); unchecked sections return to the submitter.',
            });
        }
        if (!requested.length) {
            return res.status(400).json({ message: 'There are no sections in this submission to hold against.' });
        }

        const invalid = approvedSections.filter((s) => !requested.includes(String(s)));
        if (invalid.length) {
            return res.status(400).json({ message: 'Approved selection references sections that are not part of this request.' });
        }

        const approvedSet = new Set(approvedSections);
        const unapproved = requested.filter((s) => !approvedSet.has(s));
        if (!unapproved.length) {
            return res.status(400).json({
                message: 'Nothing left to hold — use Accept when every section in this request is acceptable.',
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

        const designatedHr = await getDepartmentHOD('hr');
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

        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Profile Activation',
            assignedTo: designatedHr?._id ? String(designatedHr._id) : '',
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

        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
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

        const refreshed = await AssetItem.findById(id).populate('typeId', 'name').populate('assignedTo', 'firstName lastName employeeId').lean();
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

        if (!(await canProcessVehicleProfileActivation(req))) {
            return res.status(403).json({
                message: 'Only the flowchart HR assignee can reject this request.',
            });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }
        if (String(asset.vehicleProfileActivationStatus || '').toLowerCase() !== 'submitted') {
            return res.status(400).json({ message: 'This vehicle is not awaiting profile activation review.' });
        }

        const submitterId = asset.vehicleProfileActivationSubmittedBy || null;
        const submitterEmp = submitterId
            ? await EmployeeBasic.findById(submitterId)
                  .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                  .lean()
            : null;

        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

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

        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
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

        const refreshed = await AssetItem.findById(id).populate('typeId', 'name').populate('assignedTo', 'firstName lastName employeeId').lean();
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
