import nodemailer from 'nodemailer';
import AssetItem from '../models/AssetItem.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';
import { resolveEmployeeEmail } from '../utils/resolveEmployeeEmail.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import { resolveProfileActivationSubmitterId } from '../utils/resolveProfileActivationSubmitterId.js';

const normType = (t) => String(t || '').toLowerCase().trim();

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

/**
 * POST /api/AssetItem/:id/submit-vehicle-profile-activation
 * Email + dashboard task for flowchart Asset Controller; stores submitted state on asset.
 */
export const submitVehicleProfileActivation = async (req, res) => {
    try {
        const { id } = req.params;
        const { description = '', includedSections = [] } = req.body || {};
        const sections = Array.isArray(includedSections)
            ? [...new Set(includedSections.map((s) => String(s || '').trim()).filter(Boolean))]
            : [];

        const allowed = new Set(['basic', 'registration', 'insurance', 'warranty', 'documents']);
        for (const s of sections) {
            if (!allowed.has(s)) {
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
            return res.status(400).json({ message: 'Vehicle profile activation is only available for fleet vehicle assets.' });
        }

        if (String(asset.vehicleProfileActivationStatus || 'none') === 'submitted') {
            return res.status(400).json({ message: 'This vehicle is already submitted for profile activation review.' });
        }

        const docs = asset.documents || [];
        const registrationDoc = docs.find((d) => normType(d.type) === 'registration');
        const insuranceDoc = docs.find((d) => normType(d.type) === 'insurance');
        const warrantyDoc = docs.find((d) => normType(d.type) === 'warranty');

        if (!registrationDoc?.expiryDate) {
            return res.status(400).json({ message: 'Registration with an expiry date must be on file before submitting.' });
        }
        if (!insuranceDoc?.expiryDate) {
            return res.status(400).json({ message: 'Insurance with an expiry date must be on file before submitting.' });
        }
        if (asset.warrantyEnabled) {
            const hasWarrantyExpiry = !!(warrantyDoc?.expiryDate || asset.warrantyExpiryDate);
            if (!hasWarrantyExpiry) {
                return res.status(400).json({ message: 'Warranty is enabled for this vehicle — add warranty coverage with an end date before submitting.' });
            }
        }

        const submitterId = await resolveProfileActivationSubmitterId(req);
        if (!submitterId) {
            return res.status(400).json({
                message:
                    'Your portal login must be linked to an Employee record before you can submit. Check user → employee mapping.',
            });
        }

        const ac = await getDepartmentHOD('assetcontroller');
        if (!ac?._id) {
            return res.status(400).json({ message: 'No Asset Controller is configured in the company flowchart.' });
        }
        const { email: acEmail } = resolveEmployeeEmail(ac);
        if (!acEmail || !String(acEmail).trim()) {
            return res.status(400).json({ message: 'Asset Controller does not have a resolvable email address.' });
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
        const acName = `${ac.firstName || ''} ${ac.lastName || ''}`.trim() || 'Asset Controller';
        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        const baseUrl = process.env.FRONTEND_URL || origin || 'http://localhost:3000';
        const detailUrl = `${baseUrl}/HRM/Asset/Vehicle/details/${id}`;
        const descText = String(description || '').trim();
        const sectionsHtml = sections.map((s) => `<li>${s}</li>`).join('');

        const html = `
            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 640px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                <div style="background-color: #059669; color: white; padding: 20px; text-align: center;">
                    <h2 style="margin: 0;">Vehicle profile — activation review</h2>
                </div>
                <div style="padding: 28px;">
                    <p>Hello <strong>${acName}</strong>,</p>
                    <p>A colleague completed the vehicle profile checklist and submitted it for <strong>Asset Controller</strong> review.</p>
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
            to: acEmail,
            subject: `Vehicle profile review: ${vehicleLabel}`,
            html,
        });

        const requestedByName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            req.user?.employeeId ||
            '';

        const subjectForDash = {
            firstName: asset.name || 'Vehicle',
            lastName: `(${asset.assetId || ''})`.trim(),
            employeeId: asset.assetId || '',
            designation: asset.typeId?.name || '',
        };

        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Profile Activation',
            assignedTo: String(ac._id),
            status: 'Pending',
            subjectEmployee: subjectForDash,
            requestedByName,
            extra1: `[Fleet] ${vehicleLabel} — profile submitted (${sections.join(', ')})`,
            extra2: descText || '',
            extra3: JSON.stringify({
                activationSubject: 'vehicle',
                activationViewerRole: 'asset_controller',
                includedSections: sections,
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
            }
        );

        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: submitterId,
                comments: `Vehicle profile submitted for activation review (${sections.join(', ')}).`,
                details: { type: 'VehicleProfileActivationSubmit', sections, description: descText },
            });
        } catch (hErr) {
            console.error('[submitVehicleProfileActivation] history log failed:', hErr?.message || hErr);
        }

        return res.status(200).json({
            message: 'Submitted for review. The Asset Controller has been emailed and will see a task on the dashboard.',
            vehicleProfileActivationStatus: 'submitted',
        });
    } catch (err) {
        console.error('submitVehicleProfileActivation:', err);
        return res.status(500).json({ message: err.message || 'Failed to submit vehicle profile activation.' });
    }
};
