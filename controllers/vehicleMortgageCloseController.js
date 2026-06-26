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
import { persistStoredAttachmentValue } from '../utils/s3Upload.js';

export const VEHICLE_MORTGAGE_DOC_TYPE = 'Mortgage';

const isFleetVehicleAsset = (asset) =>
    isFleetVehicleAssetFields({
        plateNumber: asset?.plateNumber,
        typeName: asset?.typeId?.name || '',
    });

const vehicleSubjectForDashboard = (asset) => ({
    firstName: asset.name || 'Vehicle',
    lastName: `(${asset.assetId || ''})`.trim(),
    employeeId: asset.assetId || '',
    designation: asset.typeId?.name || '',
});

export const hasActiveVehicleMortgageData = (asset) => {
    if (!asset) return false;
    const rows = [
        asset.mortgageBankName,
        asset.mortgageVehicleName,
        asset.mortgageStartDate,
        asset.mortgageEndDate,
        asset.mortgageSecurityCheckAttachment,
        asset.mortgageScheduleListAttachment,
        asset.mortgageBankDocument,
    ];
    if (rows.some((v) => v != null && String(v).trim() !== '')) return true;
    if (Number(asset.mortgageAmount || 0) > 0) return true;
    if (Number(asset.loanAmount || 0) > 0) return true;
    if (Number(asset.downPayment || 0) > 0) return true;
    if (Number(asset.interestRate || 0) > 0) return true;
    if (Number(asset.loanTenureMonths || 0) > 0) return true;
    if (Number(asset.monthlyPayment || 0) > 0) return true;
    if (Number(asset.balancePayment || 0) > 0) return true;
    if (Number(asset.processCharge || 0) > 0) return true;
    if (Array.isArray(asset.mortgageExtraAttachments) && asset.mortgageExtraAttachments.length > 0) {
        return true;
    }
    return false;
};

const buildMortgageSnapshot = (asset) => ({
    mortgageBankName: asset.mortgageBankName || '',
    mortgageVehicleName: asset.mortgageVehicleName || '',
    mortgageAmount: asset.mortgageAmount ?? 0,
    loanAmount: asset.loanAmount ?? 0,
    downPayment: asset.downPayment ?? 0,
    totalInterest: asset.totalInterest ?? 0,
    totalPayable: asset.totalPayable ?? 0,
    interestRate: asset.interestRate ?? 0,
    loanTenureMonths: asset.loanTenureMonths ?? 0,
    mortgageStartDate: asset.mortgageStartDate || null,
    mortgageEndDate: asset.mortgageEndDate || null,
    monthlyPayment: asset.monthlyPayment ?? 0,
    balancePayment: asset.balancePayment ?? 0,
    processCharge: asset.processCharge ?? 0,
    mortgageBank: asset.mortgageBank || asset.mortgageBankName || '',
    mortgageBankDocument: asset.mortgageBankDocument || null,
    mortgageSecurityCheckAttachment: asset.mortgageSecurityCheckAttachment || null,
    mortgageScheduleListAttachment: asset.mortgageScheduleListAttachment || null,
    mortgageExtraAttachments: Array.isArray(asset.mortgageExtraAttachments)
        ? asset.mortgageExtraAttachments
        : [],
});

const clearedMortgageFields = () => ({
    mortgageBankName: '',
    mortgageVehicleName: '',
    mortgageAmount: 0,
    loanAmount: 0,
    downPayment: 0,
    totalInterest: 0,
    totalPayable: 0,
    interestRate: 0,
    loanTenureMonths: 0,
    mortgageStartDate: null,
    mortgageEndDate: null,
    monthlyPayment: 0,
    balancePayment: 0,
    processCharge: 0,
    mortgageBank: '',
    mortgageBankDocument: null,
    mortgageSecurityCheckAttachment: null,
    mortgageScheduleListAttachment: null,
    mortgageExtraAttachments: [],
});

export const canProcessVehicleMortgageClose = async (req) => isUserInFlowchart(req.user, 'hr').catch(() => false);

const canSubmitVehicleMortgageClose = async (req, asset) => {
    if (!isFleetVehicleProfileActive(asset)) return false;
    const submitterId = await resolveProfileActivationSubmitterId(req);
    return !!submitterId;
};

const sendHrMortgageCloseEmail = async ({ req, hrEmail, hrName, vehicleLabel, detailUrl }) => {
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
            subject: `Vehicle mortgage close request: ${vehicleLabel}`,
            html: `
                <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
                    <h2 style="color:#1d4ed8;">Mortgage close — HR approval</h2>
                    <p>Hello <strong>${hrName}</strong>,</p>
                    <p>A user requested to close the mortgage on <strong>${vehicleLabel}</strong>.</p>
                    <p>After approval, the mortgage will move to Old Documents and be removed from live records.</p>
                    <p><a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:8px;">Open vehicle</a></p>
                </div>
            `,
        })
        .catch(() => {});
};

const sendMortgageCloseOutcomeEmail = async ({
    submitterEmployee,
    reviewerName,
    vehicleLabel,
    detailUrl,
    status,
}) => {
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
            subject: `Vehicle mortgage close ${approved ? 'approved' : 'rejected'}: ${vehicleLabel}`,
            html: `
                <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:0 auto;">
                    <h2 style="color:${approved ? '#059669' : '#dc2626'};">Mortgage close ${approved ? 'approved' : 'rejected'}</h2>
                    <p>Hello <strong>${submitterName}</strong>,</p>
                    <p>HR (${reviewerName}) has <strong>${approved ? 'approved' : 'rejected'}</strong> your mortgage close request for <strong>${vehicleLabel}</strong>.</p>
                    ${approved ? '<p>The mortgage has been archived to Old Documents and removed from live records.</p>' : ''}
                    <p><a href="${detailUrl}" style="background:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:8px;">Open vehicle</a></p>
                </div>
            `,
        })
        .catch(() => {});
};

/**
 * POST /api/AssetItem/:id/submit-vehicle-mortgage-close
 */
export const submitVehicleMortgageClose = async (req, res) => {
    try {
        const { id } = req.params;
        const clearanceAttachment = req.body?.clearanceAttachment || null;

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Not a fleet vehicle asset.' });
        }
        if (!isFleetVehicleProfileActive(asset)) {
            return res.status(400).json({ message: FLEET_PROFILE_INACTIVE_ASSIGNMENT_MSG });
        }
        if (!hasActiveVehicleMortgageData(asset)) {
            return res.status(400).json({ message: 'No active mortgage details to close.' });
        }
        if (String(asset.vehicleMortgageCloseStatus || '').toLowerCase() === 'pending_hr') {
            return res.status(400).json({ message: 'A mortgage close request is already pending HR approval.' });
        }
        if (!(await canSubmitVehicleMortgageClose(req, asset))) {
            return res.status(403).json({
                message:
                    'Your portal login must be linked to an Employee record and the vehicle profile must be active.',
            });
        }

        const submitterId = await resolveProfileActivationSubmitterId(req);
        const designatedHr = await getDepartmentHOD('hr');
        if (!designatedHr?._id) {
            return res.status(400).json({ message: 'No HR assignee is configured in the flowchart.' });
        }
        const { email: hrEmail } = resolveEmployeeEmail(designatedHr);
        if (!hrEmail?.trim()) {
            return res.status(400).json({ message: 'Flowchart HR has no email address.' });
        }

        let storedClearance = null;
        if (clearanceAttachment && typeof clearanceAttachment === 'object' && clearanceAttachment.data) {
            storedClearance = await persistStoredAttachmentValue(
                clearanceAttachment,
                'asset-documents',
                clearanceAttachment.name || 'clearance-letter',
            );
        }

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: {
                    vehicleMortgageCloseStatus: 'pending_hr',
                    vehicleMortgageCloseSubmittedAt: new Date(),
                    vehicleMortgageCloseSubmittedBy: submitterId,
                    vehicleMortgageCloseClearanceAttachment: storedClearance,
                },
            },
        );

        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const detailUrl = `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}?tab=basic&mortgageCloseReview=1`;
        const hrName = `${designatedHr.firstName || ''} ${designatedHr.lastName || ''}`.trim() || 'HR';

        await sendHrMortgageCloseEmail({ req, hrEmail, hrName, vehicleLabel, detailUrl });

        const requestedByName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            req.user?.employeeId ||
            '';

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Mortgage Close',
            assignedTo: String(designatedHr._id),
            status: 'Pending',
            subjectEmployee: vehicleSubjectForDashboard(asset),
            requestedByName,
            extra1: `[Fleet] ${vehicleLabel} — mortgage close request`,
            extra2: '',
            extra3: JSON.stringify({
                activationSubject: 'vehicle',
                activationViewerRole: 'flowchart_hr',
                vehicleMongoId: String(asset._id),
                mortgageCloseReview: true,
            }),
        });

        return res.status(200).json({
            message: 'Mortgage close request submitted. HR will be notified.',
            vehicleMortgageCloseStatus: 'pending_hr',
        });
    } catch (err) {
        console.error('submitVehicleMortgageClose:', err);
        return res.status(500).json({ message: err.message || 'Failed to submit mortgage close request.' });
    }
};

/**
 * POST /api/AssetItem/:id/approve-vehicle-mortgage-close
 */
export const approveVehicleMortgageClose = async (req, res) => {
    try {
        const { id } = req.params;

        if (!(await canProcessVehicleMortgageClose(req))) {
            return res.status(403).json({ message: 'Only flowchart HR can approve mortgage close requests.' });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (String(asset.vehicleMortgageCloseStatus || '').toLowerCase() !== 'pending_hr') {
            return res.status(400).json({ message: 'No pending mortgage close request to approve.' });
        }
        if (!hasActiveVehicleMortgageData(asset)) {
            return res.status(400).json({ message: 'No active mortgage details to archive.' });
        }

        const submitterId = asset.vehicleMortgageCloseSubmittedBy || null;
        const reviewerId = await resolveProfileActivationSubmitterId(req);
        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

        const snapshot = buildMortgageSnapshot(asset);
        const clearance = asset.vehicleMortgageCloseClearanceAttachment || null;
        const closedAt = new Date();

        const mortgageDoc = {
            type: VEHICLE_MORTGAGE_DOC_TYPE,
            issueDate: snapshot.mortgageStartDate || closedAt,
            expiryDate: snapshot.mortgageEndDate || null,
            issueAuthority: snapshot.mortgageBankName || snapshot.mortgageBank || '',
            attachment: clearance || snapshot.mortgageBankDocument || snapshot.mortgageSecurityCheckAttachment || null,
            description: JSON.stringify({
                source: 'hr_approved_mortgage_close',
                isRenewed: true,
                notRenewed: true,
                closedAt: closedAt.toISOString(),
                clearanceAttachment: clearance,
                snapshot,
            }),
        };

        asset.documents = Array.isArray(asset.documents) ? asset.documents : [];
        asset.documents.push(mortgageDoc);

        Object.assign(asset, clearedMortgageFields());
        asset.vehicleMortgageCloseStatus = 'none';
        asset.vehicleMortgageCloseSubmittedAt = null;
        asset.vehicleMortgageCloseSubmittedBy = null;
        asset.vehicleMortgageCloseClearanceAttachment = null;

        await asset.save();

        try {
            const DashboardAction = (await import('../models/DashboardAction.js')).default;
            await DashboardAction.updateMany(
                {
                    requestId: asset._id,
                    requestType: 'Vehicle Mortgage Close',
                    status: 'Pending',
                },
                { $set: { status: 'Approved' } },
            );
        } catch {
            /* non-fatal */
        }

        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const detailUrl = `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}?tab=document`;

        const submitterEmp = submitterId
            ? await EmployeeBasic.findById(submitterId)
                  .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                  .lean()
            : null;

        sendMortgageCloseOutcomeEmail({
            submitterEmployee: submitterEmp,
            reviewerName: reviewerDisplayName,
            vehicleLabel,
            detailUrl,
            status: 'approved',
        }).catch(() => {});

        if (submitterId) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Mortgage Close',
                assignedTo: String(submitterId),
                status: 'Approved',
                subjectEmployee: vehicleSubjectForDashboard(asset),
                requestedByName: reviewerDisplayName,
                extra1: `[Fleet] ${vehicleLabel} — mortgage close approved`,
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
            message: 'Mortgage closed. Archived to Old Documents and removed from live records.',
            asset: refreshed,
            vehicleMortgageCloseStatus: 'none',
        });
    } catch (err) {
        console.error('approveVehicleMortgageClose:', err);
        return res.status(500).json({ message: err.message || 'Failed to approve mortgage close.' });
    }
};

/**
 * POST /api/AssetItem/:id/reject-vehicle-mortgage-close
 */
export const rejectVehicleMortgageClose = async (req, res) => {
    try {
        const { id } = req.params;

        if (!(await canProcessVehicleMortgageClose(req))) {
            return res.status(403).json({ message: 'Only flowchart HR can reject mortgage close requests.' });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name').lean();
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (String(asset.vehicleMortgageCloseStatus || '').toLowerCase() !== 'pending_hr') {
            return res.status(400).json({ message: 'No pending mortgage close request to reject.' });
        }

        const submitterId = asset.vehicleMortgageCloseSubmittedBy || null;
        const reviewerDisplayName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

        await AssetItem.updateOne(
            { _id: id },
            {
                $set: { vehicleMortgageCloseStatus: 'none' },
                $unset: {
                    vehicleMortgageCloseSubmittedAt: 1,
                    vehicleMortgageCloseSubmittedBy: 1,
                    vehicleMortgageCloseClearanceAttachment: 1,
                },
            },
        );

        try {
            const DashboardAction = (await import('../models/DashboardAction.js')).default;
            await DashboardAction.updateMany(
                {
                    requestId: asset._id,
                    requestType: 'Vehicle Mortgage Close',
                    status: 'Pending',
                },
                { $set: { status: 'Rejected' } },
            );
        } catch {
            /* non-fatal */
        }

        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || id})`;
        const detailUrl = `${resolveFrontendBaseUrl(req)}/HRM/Asset/Vehicle/details/${id}?tab=basic`;

        const submitterEmp = submitterId
            ? await EmployeeBasic.findById(submitterId)
                  .select('_id employeeId firstName lastName companyEmail workEmail email personalEmail')
                  .lean()
            : null;

        sendMortgageCloseOutcomeEmail({
            submitterEmployee: submitterEmp,
            reviewerName: reviewerDisplayName,
            vehicleLabel,
            detailUrl,
            status: 'rejected',
        }).catch(() => {});

        if (submitterId) {
            await syncDashboardAction({
                requestId: asset._id,
                requestType: 'Vehicle Mortgage Close',
                assignedTo: String(submitterId),
                status: 'Rejected',
                subjectEmployee: vehicleSubjectForDashboard(asset),
                requestedByName: reviewerDisplayName,
                extra1: `[Fleet] ${vehicleLabel} — mortgage close rejected`,
                extra2: '',
                extra3: JSON.stringify({
                    activationSubject: 'vehicle',
                    activationViewerRole: 'submitter',
                    vehicleMongoId: String(asset._id),
                    outcome: 'reject',
                }),
            });
        }

        return res.status(200).json({
            message: 'Mortgage close request rejected.',
            vehicleMortgageCloseStatus: 'none',
        });
    } catch (err) {
        console.error('rejectVehicleMortgageClose:', err);
        return res.status(500).json({ message: err.message || 'Failed to reject mortgage close.' });
    }
};
