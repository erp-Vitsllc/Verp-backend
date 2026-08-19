/**
 * When a fleet vehicle is created (inactive), notify the flowchart Admin Officer
 * on the Vehicle module bell to complete the first inspection.
 */

import nodemailer from 'nodemailer';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { resolveAssetControllerEmployee, isFleetVehicleAsset } from './assetApprovalHelpers.js';
import { pickEffectiveEmail } from './pickEffectiveEmail.js';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';

export const NEW_VEHICLE_FIRST_INSPECTION_FLAG = 'newVehicleFirstInspection';

function vehicleLabel(asset) {
    const id = asset?.assetId || asset?._id || 'Vehicle';
    const name = asset?.name || asset?.plateNumber || '';
    return name ? `${name} (${id})` : String(id);
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function inspectionAlreadyStarted(asset) {
    const status = String(asset?.vehicleInspectionStatus || '').toLowerCase();
    return status === 'draft' || status === 'pending_hr' || status === 'active';
}

function buildExtra3(assetId) {
    return JSON.stringify({
        activationSubject: 'vehicle',
        isFleetVehicle: true,
        vehicleMongoId: String(assetId),
        vehicleTab: 'handover',
        inspectionReview: '0',
        [NEW_VEHICLE_FIRST_INSPECTION_FLAG]: true,
        activationViewerRole: 'inspection_assignee',
    });
}

async function resolveAdminOfficer() {
    const row = await getDepartmentHOD('admincontroller');
    if (!row) return null;
    return resolveAssetControllerEmployee(row);
}

async function sendNewVehicleInspectionEmail({ toEmployee, asset, detailUrl }) {
    const to = pickEffectiveEmail(toEmployee);
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!to || !emailUser || !emailPass) return;

    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });

    const plainLabel = vehicleLabel(asset);
    const label = escapeHtml(plainLabel);
    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to,
        subject: `${plainLabel}: first vehicle inspection required`,
        html: `
            <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <div style="background:#0f766e;color:#fff;padding:22px;">
                    <h1 style="margin:0;font-size:20px;">New vehicle — inspection required</h1>
                </div>
                <div style="padding:28px;">
                    <p>A new fleet vehicle <strong>${label}</strong> was created with an inactive profile.</p>
                    <p>Please complete the first vehicle inspection from the Vehicle module (Handover tab → Create Inspection). Inspection is required before profile activation.</p>
                    ${
                        detailUrl
                            ? `<p><a href="${detailUrl}" style="display:inline-block;margin-top:12px;padding:10px 16px;background:#0f766e;color:#fff;text-decoration:none;border-radius:8px;">Open vehicle handover</a></p>`
                            : ''
                    }
                </div>
            </div>
        `,
    });
}

/**
 * Close "new vehicle — create first inspection" inbox rows (not in-progress handover tasks).
 */
export async function closeNewVehicleFirstInspectionNotifications(
    assetId,
    { status = 'Approved', comment = 'First inspection started.', actionedBy = null } = {},
) {
    if (!assetId) return;
    const patch = {
        status,
        actionedDate: new Date(),
        comment,
    };
    if (actionedBy) patch.actionedBy = actionedBy;
    await DashboardAction.updateMany(
        {
            requestId: assetId,
            requestType: 'Vehicle Inspection',
            status: 'Pending',
            extra3: { $regex: `"${NEW_VEHICLE_FIRST_INSPECTION_FLAG}"\\s*:\\s*true`, $options: 'i' },
        },
        { $set: patch },
    );
}

/**
 * Create (or keep) the Admin Officer Vehicle-module task to inspect a newly created vehicle.
 */
export async function notifyAdminOfficerNewVehicleFirstInspection(asset, options = {}) {
    if (!asset?._id || !isFleetVehicleAsset(asset)) {
        return { ok: false, skipped: true };
    }
    if (String(asset.status || '').toLowerCase() === 'draft') {
        return { ok: true, skipped: true, reason: 'draft' };
    }
    if (inspectionAlreadyStarted(asset)) {
        await closeNewVehicleFirstInspectionNotifications(asset._id, {
            comment: 'Inspection already in progress or complete.',
        });
        return { ok: true, skipped: true, reason: 'inspection_started' };
    }

    const adminOfficer = await resolveAdminOfficer();
    if (!adminOfficer?._id) {
        return { ok: false, skipped: true, reason: 'no_admin_officer' };
    }

    const extra3 = buildExtra3(asset._id);
    const extra1 = `New vehicle — complete first inspection`;
    const extra2 = vehicleLabel(asset);

    const existing = await DashboardAction.findOne({
        requestId: asset._id,
        requestType: 'Vehicle Inspection',
        status: 'Pending',
        extra3: { $regex: `"${NEW_VEHICLE_FIRST_INSPECTION_FLAG}"\\s*:\\s*true`, $options: 'i' },
    })
        .select('_id assignedTo')
        .lean();

    if (existing) {
        if (String(existing.assignedTo) !== String(adminOfficer._id)) {
            await DashboardAction.updateOne(
                { _id: existing._id },
                {
                    $set: {
                        assignedTo: adminOfficer._id,
                        assignedToEmpId: adminOfficer.employeeId,
                        extra1,
                        extra2,
                        extra3,
                    },
                },
            );
        }
        return { ok: true, created: false };
    }

    await DashboardAction.create({
        assignedTo: adminOfficer._id,
        assignedToEmpId: adminOfficer.employeeId,
        requestId: asset._id,
        requestType: 'Vehicle Inspection',
        status: 'Pending',
        subjectEmployeeId: asset.assetId || '',
        subjectName: asset.name || 'Vehicle',
        requestedByName: options.requestedByName || 'System',
        extra1,
        extra2,
        extra3,
    });

    if (options.sendEmail !== false) {
        try {
            const base = resolveFrontendBaseUrl(options.req || null);
            const detailUrl = base
                ? `${base}/HRM/Asset/Vehicle/details/${asset._id}?tab=handover`
                : '';
            await sendNewVehicleInspectionEmail({
                toEmployee: adminOfficer,
                asset,
                detailUrl,
            });
        } catch (err) {
            console.warn(
                '[notifyAdminOfficerNewVehicleFirstInspection] email failed',
                err?.message || err,
            );
        }
    }

    return { ok: true, created: true };
}
