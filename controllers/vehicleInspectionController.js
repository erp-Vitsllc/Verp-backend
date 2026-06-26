import nodemailer from 'nodemailer';
import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { resolveEmployeeEmail } from '../utils/resolveEmployeeEmail.js';
import { resolveFrontendBaseUrl } from '../utils/resolveFrontendBaseUrl.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import { resolveProfileActivationSubmitterId } from '../utils/resolveProfileActivationSubmitterId.js';
import {
    isFleetVehicleAssetFields,
    isFleetVehicleProfileActive,
    FLEET_PROFILE_INACTIVE_ASSIGNMENT_MSG,
} from '../utils/assetApprovalHelpers.js';

export const VEHICLE_INSPECTION_DOC_TYPE = 'Vehicle Inspection';

const isFleetVehicleAsset = (asset) => {
    if (!asset) return false;
    return isFleetVehicleAssetFields({
        plateNumber: asset.plateNumber,
        typeName: asset.typeId?.name || '',
    });
};

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

const canSubmitVehicleInspection = async (req, asset) => {
    if (!isFleetVehicleProfileActive(asset)) return false;
    const submitterId = await resolveProfileActivationSubmitterId(req);
    return !!submitterId;
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
        .catch(() => {});
};

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
        .catch(() => {});
};

/**
 * POST /api/AssetItem/:id/submit-vehicle-inspection-request
 */
export const submitVehicleInspectionRequest = async (req, res) => {
    try {
        const { id } = req.params;

        const asset = await AssetItem.findById(id).populate('typeId', 'name').populate('assignedTo', '_id').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }
        if (!isFleetVehicleProfileActive(asset)) {
            return res.status(400).json({ message: FLEET_PROFILE_INACTIVE_ASSIGNMENT_MSG });
        }
        if (!(await canSubmitVehicleInspection(req, asset))) {
            return res.status(403).json({
                message:
                    'Your portal login must be linked to an Employee record and the vehicle profile must be active.',
            });
        }

        const inspectionStatus = String(asset.vehicleInspectionStatus || '').toLowerCase();
        if (inspectionStatus === 'pending_hr') {
            return res.status(400).json({ message: 'A vehicle inspection request is already pending HR approval.' });
        }
        if (hasVehicleInspectionHistory(asset)) {
            return res.status(400).json({ message: 'A vehicle inspection record already exists for this vehicle.' });
        }

        const submitterId = await resolveProfileActivationSubmitterId(req);
        if (!submitterId) {
            return res.status(400).json({
                message: 'Your portal login must be linked to an Employee record before you can submit a request.',
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

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: {
                    vehicleInspectionStatus: 'pending_hr',
                    vehicleInspectionSubmittedAt: new Date(),
                    vehicleInspectionSubmittedBy: submitterId,
                },
            },
        );

        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const detailUrl = `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}?tab=handover&inspectionReview=1`;
        const hrName = `${designatedHr.firstName || ''} ${designatedHr.lastName || ''}`.trim() || 'HR';

        await sendHrInspectionRequestEmail({ req, hrEmail, hrName, vehicleLabel, detailUrl });

        const requestedByName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            req.user?.employeeId ||
            '';

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Inspection',
            assignedTo: String(designatedHr._id),
            status: 'Pending',
            subjectEmployee: vehicleSubjectForDashboard(asset),
            requestedByName,
            extra1: `[Fleet] ${vehicleLabel} — vehicle inspection create request`,
            extra2: '',
            extra3: JSON.stringify({
                activationSubject: 'vehicle',
                activationViewerRole: 'flowchart_hr',
                vehicleMongoId: String(asset._id),
                inspectionReview: true,
            }),
        });

        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: submitterId,
                comments: 'Submitted vehicle inspection create request for HR approval.',
                details: { type: 'VehicleInspectionSubmit' },
            });
        } catch {
            /* non-fatal */
        }

        return res.status(200).json({
            message: 'Inspection request submitted. HR will be notified and must approve before the record is created.',
            vehicleInspectionStatus: 'pending_hr',
        });
    } catch (err) {
        console.error('submitVehicleInspectionRequest:', err);
        return res.status(500).json({ message: err.message || 'Failed to submit inspection request.' });
    }
};

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
        if (hasVehicleInspectionHistory(asset)) {
            return res.status(400).json({ message: 'A vehicle inspection record already exists for this vehicle.' });
        }

        const submitterId = asset.vehicleInspectionSubmittedBy || null;
        const reviewerId = await resolveProfileActivationSubmitterId(req);
        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

        const inspectionDoc = {
            type: VEHICLE_INSPECTION_DOC_TYPE,
            issueDate: new Date(),
            description: JSON.stringify({
                source: 'hr_approved_request',
                placeholder: true,
                note: 'Inspection form is under development. Record created after HR approval.',
            }),
        };

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
                },
                $push: { documents: inspectionDoc },
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
        const detailUrl = `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}?tab=handover`;

        const submitterEmp = submitterId
            ? await EmployeeBasic.findById(submitterId)
                  .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                  .lean()
            : null;

        sendInspectionOutcomeEmail({
            submitterEmployee: submitterEmp,
            reviewerName: reviewerDisplayName,
            vehicleLabel,
            detailUrl,
            status: 'approved',
        }).catch(() => {});

        if (submitterId) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Inspection',
                assignedTo: String(submitterId),
                status: 'Approved',
                subjectEmployee: vehicleSubjectForDashboard(asset),
                requestedByName: reviewerDisplayName,
                extra1: `[Fleet] ${vehicleLabel} — vehicle inspection approved`,
                extra2: '',
                extra3: JSON.stringify({
                    activationSubject: 'vehicle',
                    activationViewerRole: 'submitter',
                    vehicleMongoId: String(asset._id),
                    outcome: 'approve',
                }),
            });
        }

        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: reviewerId,
                comments: 'HR approved vehicle inspection create request; inspection record created.',
                details: { type: 'VehicleInspectionApprove' },
            });
        } catch {
            /* non-fatal */
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

        const submitterId = asset.vehicleInspectionSubmittedBy || null;
        const reviewerId = await resolveProfileActivationSubmitterId(req);
        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: { vehicleInspectionStatus: 'none' },
                $unset: {
                    vehicleInspectionSubmittedAt: 1,
                    vehicleInspectionSubmittedBy: 1,
                    vehicleInspectionApprovedAt: 1,
                    vehicleInspectionApprovedBy: 1,
                },
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
                { $set: { status: 'Rejected' } },
            );
        } catch {
            /* non-fatal */
        }

        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const detailUrl = `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}?tab=handover`;

        const submitterEmp = submitterId
            ? await EmployeeBasic.findById(submitterId)
                  .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                  .lean()
            : null;

        sendInspectionOutcomeEmail({
            submitterEmployee: submitterEmp,
            reviewerName: reviewerDisplayName,
            vehicleLabel,
            detailUrl,
            status: 'rejected',
        }).catch(() => {});

        if (submitterId) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Inspection',
                assignedTo: String(submitterId),
                status: 'Rejected',
                subjectEmployee: vehicleSubjectForDashboard(asset),
                requestedByName: reviewerDisplayName,
                extra1: `[Fleet] ${vehicleLabel} — vehicle inspection rejected`,
                extra2: '',
                extra3: JSON.stringify({
                    activationSubject: 'vehicle',
                    activationViewerRole: 'submitter',
                    vehicleMongoId: String(asset._id),
                    outcome: 'reject',
                }),
            });
        }

        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: reviewerId,
                comments: 'HR rejected vehicle inspection create request.',
                details: { type: 'VehicleInspectionReject' },
            });
        } catch {
            /* non-fatal */
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
