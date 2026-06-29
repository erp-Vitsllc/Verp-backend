import nodemailer from 'nodemailer';
import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { resolveEmployeeEmail } from '../utils/resolveEmployeeEmail.js';
import { resolveFrontendBaseUrl } from '../utils/resolveFrontendBaseUrl.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import { resolveProfileActivationSubmitterId } from '../utils/resolveProfileActivationSubmitterId.js';
import { sendVehicleProfileEditOutcomeEmail } from '../utils/sendVehicleProfileEditEmails.js';
import { applyAllVehiclePendingProfileEdits, applyVehiclePendingProfileEditEntry } from '../utils/applyVehiclePendingProfileEdits.js';
import { VEHICLE_PROFILE_ACTIVATION_SECTION_IDS } from '../utils/vehicleProfileCompletion.js';
import { userCanManageFleetVehicleHandover } from '../utils/assetApprovalHelpers.js';

const PROTECTED_SECTIONS = new Set(VEHICLE_PROFILE_ACTIVATION_SECTION_IDS);

const SECTION_LABEL = {
    basic: 'Basic details',
    registration: 'Mulkia (registration card)',
    insurance: 'Insurance card',
    profile_picture: 'Profile picture',
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

const vehicleProfileIsActive = (asset) =>
    String(asset?.vehicleProfileActivationStatus || '').toLowerCase() === 'active';

export const canProcessVehicleProfileEdit = async (req) => {
    const isHr = await isUserInFlowchart(req.user, 'hr').catch(() => false);
    if (isHr) return true;
    return userCanManageFleetVehicleHandover(req);
};

const vehicleSubjectForDashboard = (asset) => ({
    firstName: asset.name || 'Vehicle',
    lastName: `(${asset.assetId || ''})`.trim(),
    employeeId: asset.assetId || '',
    designation: asset.typeId?.name || '',
});

/**
 * POST /api/AssetItem/:id/submit-vehicle-profile-edit
 * Queue edits while profile is active; HR must approve before changes apply.
 */
export const submitVehicleProfileEdit = async (req, res) => {
    try {
        const { id } = req.params;
        const { sectionId, action = 'edit', steps = [], documentId = null } = req.body || {};
        const section = String(sectionId || '').trim();
        const act = String(action || 'edit').trim();

        if (!PROTECTED_SECTIONS.has(section)) {
            return res.status(400).json({ message: `Invalid section: ${sectionId}` });
        }
        if (!['edit', 'renew', 'not_renew'].includes(act)) {
            return res.status(400).json({ message: 'Invalid action.' });
        }
        if (!Array.isArray(steps) || steps.length === 0) {
            return res.status(400).json({ message: 'No edit steps provided.' });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }
        if (!vehicleProfileIsActive(asset)) {
            return res.status(400).json({
                message: 'HR approval for edits is only required after the vehicle profile is active.',
            });
        }

        const submitterId = await resolveProfileActivationSubmitterId(req);
        if (!submitterId) {
            return res.status(400).json({
                message: 'Your portal login must be linked to an Employee record before you can submit edits.',
            });
        }

        const designatedHr = await getDepartmentHOD('hr');
        if (!designatedHr?._id) {
            return res.status(400).json({ message: 'No HR assignee is configured in the flowchart.' });
        }
        const { email: hrEmail } = resolveEmployeeEmail(designatedHr);
        if (!hrEmail?.trim()) {
            return res.status(400).json({ message: 'Flowchart HR has no email address.' });
        }

        const pendingEntry = {
            sectionId: section,
            action: act,
            steps,
            documentId: documentId || null,
            createdAt: new Date(),
        };

        const existingPending = Array.isArray(asset.vehiclePendingProfileEdits)
            ? asset.vehiclePendingProfileEdits
            : [];
        const wasPending = String(asset.vehicleProfileEditReviewStatus || '').toLowerCase() === 'pending_hr';

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: {
                    vehicleProfileEditReviewStatus: 'pending_hr',
                    vehicleProfileEditSubmittedAt: new Date(),
                    vehicleProfileEditSubmittedBy: submitterId,
                },
                $push: { vehiclePendingProfileEdits: pendingEntry },
            },
        );

        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const sectionLabel = SECTION_LABEL[section] || section;
        const actionLabel = act === 'renew' ? 'renewal' : act === 'not_renew' ? 'not renew' : 'edit';

        if (!wasPending) {
            const emailUser = process.env.EMAIL_USER?.trim();
            const emailPass = process.env.EMAIL_PASS?.trim();
            if (emailUser && emailPass) {
                const transporter = nodemailer.createTransport({
                    host: 'smtp.office365.com',
                    port: 587,
                    secure: false,
                    auth: { user: emailUser, pass: emailPass },
                });
                const hrName = `${designatedHr.firstName || ''} ${designatedHr.lastName || ''}`.trim() || 'HR';
                const detailUrl = `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}`;
                await transporter.sendMail({
                    from: `"VeRP Portal" <${emailUser}>`,
                    to: hrEmail,
                    subject: `Vehicle profile edit review: ${vehicleLabel}`,
                    html: `
                        <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
                            <h2 style="color:#1d4ed8;">Vehicle profile edit — HR review</h2>
                            <p>Hello <strong>${hrName}</strong>,</p>
                            <p>A user submitted a <strong>${actionLabel}</strong> for <strong>${sectionLabel}</strong> on activated vehicle <strong>${vehicleLabel}</strong>.</p>
                            <p>Please review and approve or reject in VeRP.</p>
                            <p><a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:8px;">Open vehicle</a></p>
                        </div>
                    `,
                }).catch(() => {});
            }
        }

        const requestedByName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            req.user?.employeeId ||
            '';

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Profile Edit',
            assignedTo: String(designatedHr._id),
            status: 'Pending',
            subjectEmployee: vehicleSubjectForDashboard(asset),
            requestedByName,
            extra1: `[Fleet] ${vehicleLabel} — ${sectionLabel} ${actionLabel} pending HR`,
            extra2: '',
            extra3: JSON.stringify({
                activationSubject: 'vehicle',
                activationViewerRole: 'flowchart_hr',
                vehicleMongoId: String(asset._id),
                sectionId: section,
                action: act,
            }),
        });

        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: submitterId,
                comments: `Submitted ${sectionLabel} ${actionLabel} for HR approval (active profile).`,
                details: { type: 'VehicleProfileEditSubmit', sectionId: section, action: act },
            });
        } catch {
            /* non-fatal */
        }

        return res.status(200).json({
            message: 'Changes submitted for HR review. They will apply after approval.',
            vehicleProfileEditReviewStatus: 'pending_hr',
        });
    } catch (err) {
        console.error('submitVehicleProfileEdit:', err);
        return res.status(500).json({ message: err.message || 'Failed to submit profile edit.' });
    }
};

/**
 * POST /api/AssetItem/:id/approve-vehicle-profile-edit
 */
export const approveVehicleProfileEdit = async (req, res) => {
    try {
        const { id } = req.params;
        if (!(await canProcessVehicleProfileEdit(req))) {
            return res.status(403).json({ message: 'Only flowchart HR can approve profile edits.' });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }
        if (String(asset.vehicleProfileEditReviewStatus || '').toLowerCase() !== 'pending_hr') {
            return res.status(400).json({ message: 'No pending profile edits to approve.' });
        }
        const pending = Array.isArray(asset.vehiclePendingProfileEdits) ? asset.vehiclePendingProfileEdits : [];
        if (!pending.length) {
            return res.status(400).json({ message: 'No pending profile edits to approve.' });
        }

        await applyAllVehiclePendingProfileEdits(asset);

        const submitterId = asset.vehicleProfileEditSubmittedBy || null;
        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

        asset.vehicleProfileEditReviewStatus = 'none';
        asset.vehicleProfileEditSubmittedAt = null;
        asset.vehicleProfileEditSubmittedBy = null;
        asset.vehiclePendingProfileEdits = [];
        await asset.save();

        try {
            const DashboardAction = (await import('../models/DashboardAction.js')).default;
            await DashboardAction.updateMany(
                {
                    requestId: asset._id,
                    requestType: 'Vehicle Profile Edit',
                    status: 'Pending',
                },
                {
                    status: 'Approved',
                    actionedDate: new Date(),
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: 'Vehicle profile edit approved',
                },
            );
        } catch {
            /* non-fatal */
        }

        const submitterEmp = submitterId
            ? await EmployeeBasic.findById(submitterId)
                  .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                  .lean()
            : null;
        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const detailUrl = `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}`;
        sendVehicleProfileEditOutcomeEmail({
            submitterEmployee: submitterEmp,
            reviewerName: reviewerDisplayName,
            vehicleLabel,
            detailUrl,
            status: 'approved',
        }).catch(() => {});

        if (submitterId) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Profile Edit',
                assignedTo: String(submitterId),
                status: 'Approved',
                subjectEmployee: vehicleSubjectForDashboard(asset),
                requestedByName: reviewerDisplayName,
                extra1: `[Fleet] ${vehicleLabel} — profile edit approved`,
                extra2: '',
                extra3: JSON.stringify({
                    activationSubject: 'vehicle',
                    activationViewerRole: 'submitter',
                    vehicleMongoId: String(asset._id),
                    outcome: 'approve',
                }),
            });
        }

        const refreshed = await AssetItem.findById(id)
            .populate('typeId', 'name')
            .populate('assignedTo', 'firstName lastName employeeId')
            .lean();

        return res.status(200).json({
            message: 'Profile edits approved and applied.',
            asset: refreshed,
            vehicleProfileEditReviewStatus: 'none',
        });
    } catch (err) {
        console.error('approveVehicleProfileEdit:', err);
        return res.status(500).json({ message: err.message || 'Failed to approve profile edit.' });
    }
};

/**
 * POST /api/AssetItem/:id/reject-vehicle-profile-edit
 */
export const rejectVehicleProfileEdit = async (req, res) => {
    try {
        const { id } = req.params;
        const reason = String(req.body?.reason || '').trim();

        if (!(await canProcessVehicleProfileEdit(req))) {
            return res.status(403).json({ message: 'Only flowchart HR can reject profile edits.' });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (String(asset.vehicleProfileEditReviewStatus || '').toLowerCase() !== 'pending_hr') {
            return res.status(400).json({ message: 'No pending profile edits to reject.' });
        }

        const submitterId = asset.vehicleProfileEditSubmittedBy || null;
        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: {
                    vehicleProfileEditReviewStatus: 'rejected',
                    vehiclePendingProfileEdits: [],
                },
                $unset: {
                    vehicleProfileEditSubmittedAt: 1,
                    vehicleProfileEditSubmittedBy: 1,
                },
            },
        );

        try {
            const DashboardAction = (await import('../models/DashboardAction.js')).default;
            await DashboardAction.updateMany(
                {
                    requestId: asset._id,
                    requestType: 'Vehicle Profile Edit',
                    status: 'Pending',
                },
                {
                    status: 'Rejected',
                    actionedDate: new Date(),
                    actionedBy: req.user?.employeeObjectId || req.user?._id,
                    comment: reason || 'Vehicle profile edit rejected',
                },
            );
        } catch {
            /* non-fatal */
        }

        const submitterEmp = submitterId
            ? await EmployeeBasic.findById(submitterId)
                  .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                  .lean()
            : null;
        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const detailUrl = `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}`;

        sendVehicleProfileEditOutcomeEmail({
            submitterEmployee: submitterEmp,
            reviewerName: reviewerDisplayName,
            vehicleLabel,
            detailUrl,
            status: 'rejected',
            reason,
        }).catch(() => {});

        if (submitterId) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Profile Edit',
                assignedTo: String(submitterId),
                status: 'Rejected',
                subjectEmployee: vehicleSubjectForDashboard(asset),
                requestedByName: reviewerDisplayName,
                extra1: `[Fleet] ${vehicleLabel} — profile edit rejected`,
                extra2: reason,
                extra3: JSON.stringify({
                    activationSubject: 'vehicle',
                    activationViewerRole: 'submitter',
                    vehicleMongoId: String(asset._id),
                    outcome: 'reject',
                }),
            });
        }

        return res.status(200).json({
            message: 'Profile edit request rejected.',
            vehicleProfileEditReviewStatus: 'rejected',
        });
    } catch (err) {
        console.error('rejectVehicleProfileEdit:', err);
        return res.status(500).json({ message: err.message || 'Failed to reject profile edit.' });
    }
};

/**
 * POST /api/AssetItem/:id/apply-vehicle-profile-section
 * HR applies registration / insurance / mulkia edits or renewals immediately on an active profile.
 */
export const applyVehicleProfileSection = async (req, res) => {
    try {
        const { id } = req.params;
        const { sectionId, action = 'edit', steps = [], documentId = null } = req.body || {};

        const section = String(sectionId || '').trim();
        if (!PROTECTED_SECTIONS.has(section)) {
            return res.status(400).json({ message: `Invalid section: ${sectionId}` });
        }
        const act = String(action || 'edit').trim();
        if (!['edit', 'renew', 'not_renew'].includes(act)) {
            return res.status(400).json({ message: 'Invalid action.' });
        }
        if (!Array.isArray(steps) || steps.length === 0) {
            return res.status(400).json({ message: 'No edit steps provided.' });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }

        const profileActive = vehicleProfileIsActive(asset);
        if (profileActive && !(await canProcessVehicleProfileEdit(req))) {
            return res.status(403).json({
                message: 'Only HR or an authorized fleet administrator can apply changes directly.',
            });
        }

        await applyVehiclePendingProfileEditEntry(asset, {
            sectionId: section,
            action: act,
            steps,
            documentId,
        });

        const reviewerId = req.user?.employeeObjectId || req.user?._id || null;
        await asset.save();

        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            const sectionLabel = SECTION_LABEL[section] || section;
            const actionLabel = act === 'renew' ? 'renewal' : act === 'not_renew' ? 'not renew' : 'edit';
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: reviewerId,
                comments: `HR applied ${sectionLabel} ${actionLabel} directly on active profile.`,
                details: { type: 'VehicleProfileEditDirect', sectionId: section, action: act },
            });
        } catch {
            /* non-fatal */
        }

        const refreshed = await AssetItem.findById(id)
            .populate('typeId', 'name')
            .populate('assignedTo', 'firstName lastName employeeId')
            .lean();

        return res.status(200).json({
            message:
                act === 'renew'
                    ? 'Renewal applied. The previous document was moved to Old Documents.'
                    : 'Changes applied successfully.',
            asset: refreshed,
        });
    } catch (err) {
        console.error('applyVehicleProfileSection:', err);
        return res.status(500).json({ message: err.message || 'Failed to apply profile section.' });
    }
};

export { vehicleProfileIsActive, PROTECTED_SECTIONS };
