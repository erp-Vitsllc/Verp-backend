/**
 * When an Active vehicle profile drops below 100% completion, notify Admin (+ HR)
 * on the dashboard bell and email. Does NOT demote vehicleProfileActivationStatus.
 */

import nodemailer from 'nodemailer';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { pickEffectiveEmail } from './pickEffectiveEmail.js';
import {
    computeVehicleProfileCompletionPercent,
} from './vehicleProfileCompletion.js';

export const VEHICLE_PROFILE_INCOMPLETE_REQUEST_TYPE = 'Vehicle Profile Incomplete';

function createTransport() {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function vehicleLabel(asset) {
    const id = asset?.assetId || asset?._id || 'Vehicle';
    const name = asset?.name || asset?.plateNumber || '';
    return name ? `${name} (${id})` : String(id);
}

function buildDetailUrl(assetId) {
    const base = String(process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '');
    if (!base || !assetId) return '';
    return `${base}/HRM/Asset/Vehicle/details/${assetId}?tab=basic`;
}

async function resolveAssigneeUserId(employee) {
    if (!employee?._id) return null;
    return employee._id;
}

async function closeIncompleteActions(assetId) {
    await DashboardAction.updateMany(
        {
            requestId: assetId,
            requestType: VEHICLE_PROFILE_INCOMPLETE_REQUEST_TYPE,
            status: 'Pending',
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment: 'Profile completion restored to 100%.',
            },
        },
    );
}

async function ensureAssigneeAction({
    assignedTo,
    assignedToEmpId,
    asset,
    pendingLabels,
    profilePct,
    extra3,
}) {
    if (!assignedTo) return;
    const extra1 = `Profile incomplete (${profilePct}%): ${pendingLabels.join(', ')}`;
    const extra2 = vehicleLabel(asset);

    const existing = await DashboardAction.findOne({
        assignedTo,
        requestId: asset._id,
        requestType: VEHICLE_PROFILE_INCOMPLETE_REQUEST_TYPE,
        status: 'Pending',
    })
        .select('_id extra1 extra3')
        .lean();

    if (existing) {
        const changed =
            String(existing.extra1 || '') !== extra1 ||
            String(existing.extra3 || '') !== String(extra3 || '');
        if (changed) {
            await DashboardAction.updateOne(
                { _id: existing._id },
                { $set: { extra1, extra2, ...(extra3 ? { extra3 } : {}) } },
            );
            return { created: false, updated: true, extra1 };
        }
        return { created: false, updated: false, extra1 };
    }

    await DashboardAction.create({
        assignedTo,
        ...(assignedToEmpId ? { assignedToEmpId } : {}),
        requestId: asset._id,
        requestType: VEHICLE_PROFILE_INCOMPLETE_REQUEST_TYPE,
        status: 'Pending',
        subjectEmployeeId: asset.assetId || '',
        subjectName: asset.name || 'Vehicle',
        requestedByName: 'System',
        extra1,
        extra2,
        ...(extra3 ? { extra3 } : {}),
    });
    return { created: true, updated: false, extra1 };
}

async function sendIncompleteEmail({ toEmployee, asset, pendingLabels, profilePct, reason }) {
    const to = pickEffectiveEmail(toEmployee);
    if (!to) return;
    const transporter = createTransport();
    if (!transporter) return;
    const emailUser = process.env.EMAIL_USER?.trim();
    const label = vehicleLabel(asset);
    const url = buildDetailUrl(asset._id);
    const list = pendingLabels.map((l) => `<li>${escapeHtml(l)}</li>`).join('');
    const reasonLine = reason
        ? `<p style="color:#64748b;font-size:13px;">Trigger: ${escapeHtml(reason)}</p>`
        : '';

    await transporter.sendMail({
        from: `"VeRP Portal" <${emailUser}>`,
        to,
        subject: `${label}: vehicle profile incomplete (${profilePct}%)`,
        html: `
            <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b;line-height:1.6;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <div style="background:#b91c1c;color:#fff;padding:22px;">
                    <h1 style="margin:0;font-size:20px;">Vehicle profile incomplete</h1>
                </div>
                <div style="padding:28px;">
                    <p>Active vehicle <strong>${escapeHtml(label)}</strong> is below 100% profile completion.</p>
                    <p><strong>Progress:</strong> ${profilePct}%</p>
                    <p><strong>Missing:</strong></p>
                    <ul>${list}</ul>
                    ${reasonLine}
                    <p>Profile status stays <strong>Active</strong>. Please restore the missing cards / inspection.</p>
                    ${url ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;margin-top:12px;padding:10px 16px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:8px;">Open vehicle</a></p>` : ''}
                </div>
            </div>
        `,
    });
}

/**
 * Sync incomplete notifications for one asset. Safe no-op when not an active fleet profile.
 * @param {object} asset - AssetItem lean or doc
 * @param {{ reason?: string, sendEmail?: boolean }} [options]
 */
export async function syncVehicleProfileIncompleteNotifications(asset, options = {}) {
    if (!asset?._id) return { ok: false, skipped: true };
    const profileActive =
        String(asset.vehicleProfileActivationStatus || '').toLowerCase() === 'active';
    if (!profileActive) {
        await closeIncompleteActions(asset._id);
        return { ok: true, skipped: true, reason: 'not_active' };
    }

    const { profilePct, pendingChecks } = computeVehicleProfileCompletionPercent(asset);
    const pendingLabels = pendingChecks.map((c) => c.label);
    const reason = String(options.reason || '').trim();
    const shouldEmail = options.sendEmail !== false;

    if (profilePct >= 100 || pendingLabels.length === 0) {
        await closeIncompleteActions(asset._id);
        return { ok: true, profilePct, pending: [], closed: true };
    }

    const [admin, hr, management] = await Promise.all([
        getDepartmentHOD('admincontroller'),
        getDepartmentHOD('hr'),
        getDepartmentHOD('management'),
    ]);

    const missingInspection = pendingLabels.includes('Vehicle Inspection');
    const extra3 = JSON.stringify({
        activationSubject: 'vehicle',
        vehicleMongoId: String(asset._id),
        profilePct,
        pending: pendingLabels,
        missingInspection,
        focusCard: missingInspection ? 'inspection' : 'basicDetails',
        vehicleTab: missingInspection ? 'handover' : 'basic',
    });

    const recipients = [admin, hr].filter(Boolean);
    let anyCreated = false;
    let anyUpdated = false;

    for (const person of recipients) {
        const assignedTo = await resolveAssigneeUserId(person);
        const result = await ensureAssigneeAction({
            assignedTo,
            assignedToEmpId: person.employeeId,
            asset,
            pendingLabels,
            profilePct,
            extra3,
        });
        if (result?.created) anyCreated = true;
        if (result?.updated) anyUpdated = true;
    }

    // Inspection-specific bell so Admin can start Create Inspection from inbox.
    if (missingInspection && admin) {
        const assignedTo = await resolveAssigneeUserId(admin);
        if (assignedTo) {
            const inspExtra1 = `Create / restore Vehicle Inspection — ${vehicleLabel(asset)}`;
            const exists = await DashboardAction.findOne({
                assignedTo,
                requestId: asset._id,
                requestType: 'Vehicle Inspection',
                status: 'Pending',
                extra1: inspExtra1,
            })
                .select('_id')
                .lean();
            if (!exists) {
                await DashboardAction.create({
                    assignedTo,
                    assignedToEmpId: admin.employeeId,
                    requestId: asset._id,
                    requestType: 'Vehicle Inspection',
                    status: 'Pending',
                    subjectEmployeeId: asset.assetId || '',
                    subjectName: asset.name || 'Vehicle',
                    requestedByName: 'System',
                    extra1: inspExtra1,
                    extra2: `Profile ${profilePct}% — inspection required`,
                    extra3: JSON.stringify({
                        activationSubject: 'vehicle',
                        vehicleMongoId: String(asset._id),
                        vehicleTab: 'handover',
                        inspectionReview: '0',
                    }),
                });
                anyCreated = true;
            }
        }
    }

    if (shouldEmail && (anyCreated || anyUpdated)) {
        const emailPeople = [admin, hr, management].filter(Boolean);
        const seen = new Set();
        for (const person of emailPeople) {
            const key = String(person.employeeId || person._id || '');
            if (!key || seen.has(key)) continue;
            seen.add(key);
            try {
                await sendIncompleteEmail({
                    toEmployee: person,
                    asset,
                    pendingLabels,
                    profilePct,
                    reason,
                });
            } catch (err) {
                console.warn(
                    '[syncVehicleProfileIncompleteNotifications] email failed',
                    err?.message || err,
                );
            }
        }
    }

    return { ok: true, profilePct, pending: pendingLabels, anyCreated, anyUpdated };
}
