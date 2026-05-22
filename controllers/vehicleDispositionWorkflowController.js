import AssetItem from '../models/AssetItem.js';
import Company from '../models/Company.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import { uploadDocumentToS3 } from '../utils/s3Upload.js';
import { syncDashboardAction } from '../utils/syncDashboard.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { getManagementHOD } from '../utils/getManagementHOD.js';
import { resolveProfileActivationSubmitterId } from '../utils/resolveProfileActivationSubmitterId.js';
import {
    sendVehicleDispositionCompanyEmail,
    sendVehicleDispositionFinanceTaskEmail,
    sendVehicleDispositionHrRequestEmail,
    sendVehicleDispositionOutcomeEmail,
} from '../utils/sendVehicleDispositionEmails.js';

const STAGE = {
    HR: 'pending_hr',
    FINANCE: 'pending_finance',
    COMPLETE: 'complete',
    REJECTED: 'rejected',
};

const REQUEST_TYPE = 'Vehicle Disposition Request';

const parseMoneyInt = (v) => {
    const n = Number(String(v ?? '').replace(/\D/g, '') || 0);
    return Number.isFinite(n) ? n : 0;
};

/** Sold: balance in hand = |(loan + registration expense + other expense) − sold value|. */
const computeSoldBalanceInHand = ({ soldValue, currentLoanAmount, registrationExpense, otherExpense }) => {
    const raw =
        parseMoneyInt(currentLoanAmount) +
        parseMoneyInt(registrationExpense) +
        parseMoneyInt(otherExpense) -
        parseMoneyInt(soldValue);
    return Math.abs(Math.round(raw));
};

const isFleetVehicleAsset = (asset) => {
    if (!asset) return false;
    const plate = String(asset.plateNumber || '').trim();
    if (plate) return true;
    const tn = String(asset.typeId?.name || '').toLowerCase();
    return tn.includes('vehicle') || tn.includes('car') || tn.includes('fleet') || tn.includes('truck');
};

const vehicleLabel = (asset) => `${asset.name || 'Vehicle'} (${asset.assetId || asset._id})`;

const vehicleSubjectForDashboard = (asset) => ({
    firstName: asset.name || 'Vehicle',
    lastName: `(${asset.assetId || ''})`.trim(),
    employeeId: asset.assetId || '',
    designation: asset.typeId?.name || '',
});

const detailUrlFor = (req, assetId, dispositionRole = null) => {
    const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
    const baseUrl = process.env.FRONTEND_URL || origin || 'http://localhost:3000';
    const roleQs =
        dispositionRole && ['hr', 'accounts', 'management'].includes(String(dispositionRole).toLowerCase())
            ? `&dispositionRole=${encodeURIComponent(String(dispositionRole).toLowerCase())}`
            : '';
    return `${baseUrl}/HRM/Asset/Vehicle/details/${assetId}?dispositionReview=1${roleQs}`;
};

const dispositionMeta = (assetId, viewerRole) =>
    JSON.stringify({
        dispositionSubject: 'vehicle',
        dispositionViewerRole: viewerRole,
        vehicleMongoId: String(assetId),
    });

const targetStatusLabel = (s) => (String(s || '').toLowerCase() === 'sold' ? 'Sold' : 'Total loss');

const canProcessHr = async (req) => isUserInFlowchart(req.user, 'hr').catch(() => false);

const canProcessAccounts = async (req) => isUserInFlowchart(req.user, 'accounts').catch(() => false);

const canProcessManagement = async (req) => {
    const mgmt = await getManagementHOD();
    if (!mgmt?._id) return false;
    const actorId = req.user?.employeeObjectId || req.user?._id;
    if (!actorId) return false;
    if (String(mgmt._id) === String(actorId)) return true;
    if (mgmt.employeeId && req.user?.employeeId) {
        return String(mgmt.employeeId).trim().toLowerCase() === String(req.user.employeeId).trim().toLowerCase();
    }
    return isUserInFlowchart(req.user, 'management').catch(() => false);
};

const pushHistory = (wf, entry) => {
    if (!wf.history) wf.history = [];
    wf.history.push({
        stage: entry.stage || wf.stage,
        action: entry.action,
        note: entry.note || '',
        byName: entry.byName || '',
        at: new Date(),
    });
};

const clearDispositionDashboard = async (assetId, assigneeId = null) => {
    const q = { requestId: assetId, requestType: REQUEST_TYPE, status: 'Pending' };
    if (assigneeId) q.assignedTo = assigneeId;
    await DashboardAction.deleteMany(q);
};

const isValidFinanceCompletionDate = (v) => {
    if (v == null) return false;
    const d = v instanceof Date ? v : new Date(v);
    return !Number.isNaN(d.getTime());
};

const isValidFinanceCompletionBy = (v) => {
    if (v == null) return false;
    const s = String(v).trim();
    return s.length > 0 && s !== 'null' && s !== 'undefined';
};

/** After HR, either Accounts or Management may submit once — that single submit finalizes Sold / Total loss and clears all disposition bells. */
const financeFinalizeMatchQuery = () => ({
    vehicleDispositionStatus: 'active',
    'vehicleDispositionWorkflow.stage': STAGE.FINANCE,
    $or: [
        {
            'vehicleDispositionWorkflow.accountsCompletedAt': { $exists: true, $type: 'date' },
            'vehicleDispositionWorkflow.accountsCompletedBy': { $exists: true, $ne: null },
        },
        {
            'vehicleDispositionWorkflow.managementCompletedAt': { $exists: true, $type: 'date' },
            'vehicleDispositionWorkflow.managementCompletedBy': { $exists: true, $ne: null },
        },
    ],
});

const canFinalizeDispositionFromWorkflow = (wf) => {
    if (!wf || wf.stage !== STAGE.FINANCE) return false;
    return (
        (isValidFinanceCompletionDate(wf.accountsCompletedAt) && isValidFinanceCompletionBy(wf.accountsCompletedBy)) ||
        (isValidFinanceCompletionDate(wf.managementCompletedAt) && isValidFinanceCompletionBy(wf.managementCompletedBy))
    );
};

const validateFinanceStakeholders = async () => {
    const accountsHOD = await getDepartmentHOD('accounts');
    const managementHOD = await getManagementHOD();
    const missing = [];
    if (!accountsHOD?._id) missing.push('Accounts');
    if (!managementHOD?._id) missing.push('Management');
    if (missing.length) {
        return {
            ok: false,
            message: `Cannot proceed. Missing flowchart setup: ${missing.join(', ')}.`,
        };
    }
    return { ok: true, accountsHOD, managementHOD };
};

const resolveCompanyEmailForAsset = async (asset) => {
    const companyId = asset?.assignedCompany?._id || asset?.assignedCompany;
    if (!companyId) return { email: null, name: '' };
    const company = await Company.findById(companyId).select('name email companyId').lean();
    return { email: company?.email ? String(company.email).trim() : null, name: company?.name || '' };
};

/** Apply Sold / Total loss after the first finance submit (Accounts or Management). */
const tryFinalizeDispositionAtomic = async (req, assetId, actorName) => {
    const snapshot = await AssetItem.findById(assetId).lean();
    const wf = snapshot?.vehicleDispositionWorkflow;
    if (!snapshot || !wf || !canFinalizeDispositionFromWorkflow(wf)) return { finalized: false, asset: null };
    if (String(snapshot.vehicleDispositionStatus || 'active').toLowerCase() !== 'active') {
        return { finalized: false, asset: null };
    }

    const historyEntry = {
        stage: STAGE.COMPLETE,
        action: 'complete',
        note: 'Disposition applied (single finance approval)',
        byName: actorName,
        at: new Date(),
    };

    const target = String(wf.targetStatus || '').toLowerCase();

    const finalizeSet = {
        vehicleDispositionStatus: target,
        'vehicleDispositionWorkflow.stage': STAGE.COMPLETE,
        currentLoanAmount: Number(wf.currentLoanAmount || 0),
        balanceInHand: Number(wf.balanceInHand || 0),
    };
    if (wf.registrationExpiryDate) {
        finalizeSet.registrationExpiryDate = wf.registrationExpiryDate;
    }
    if (target === 'sold') {
        finalizeSet.soldValue = wf.soldValue != null ? Number(wf.soldValue) : null;
        finalizeSet.totalLossValue = null;
        finalizeSet.registrationExpense =
            wf.registrationExpense != null && !Number.isNaN(Number(wf.registrationExpense))
                ? Number(wf.registrationExpense)
                : null;
        finalizeSet.otherExpense =
            wf.otherExpense != null && !Number.isNaN(Number(wf.otherExpense)) ? Number(wf.otherExpense) : null;
    } else {
        finalizeSet.totalLossValue = wf.totalLossValue != null ? Number(wf.totalLossValue) : null;
        finalizeSet.soldValue = null;
        finalizeSet.registrationExpense =
            wf.registrationExpense != null && !Number.isNaN(Number(wf.registrationExpense))
                ? Number(wf.registrationExpense)
                : null;
        finalizeSet.otherExpense =
            wf.otherExpense != null && !Number.isNaN(Number(wf.otherExpense)) ? Number(wf.otherExpense) : null;
        if (wf.accidentReportAttachment) {
            finalizeSet.accidentReportAttachment = wf.accidentReportAttachment;
        }
    }

    const asset = await AssetItem.findOneAndUpdate(
        {
            _id: assetId,
            ...financeFinalizeMatchQuery(),
        },
        {
            $set: finalizeSet,
            $push: { 'vehicleDispositionWorkflow.history': historyEntry },
        },
        { new: true },
    ).populate('typeId', 'name assignedCompany');

    if (!asset) return { finalized: false, asset: null };

    await clearDispositionDashboard(asset._id);

    const wfFinal = asset.vehicleDispositionWorkflow;
    const url = detailUrlFor(req, asset._id);
    const label = vehicleLabel(asset);
    const targetLabel = targetStatusLabel(target);
    const { email: companyEmail, name: companyName } = await resolveCompanyEmailForAsset(asset);
    const summaryLines = [
        { label: 'Status', value: targetLabel },
        ...(target === 'sold' && wfFinal.soldValue != null ? [{ label: 'Sold value (AED)', value: String(wfFinal.soldValue) }] : []),
        ...(target === 'total loss' && wfFinal.totalLossValue != null
            ? [{ label: 'Total loss value (AED)', value: String(wfFinal.totalLossValue) }]
            : []),
        { label: 'Current loan (AED)', value: String(wfFinal.currentLoanAmount ?? 0) },
        ...(wfFinal.registrationExpense != null
            ? [{ label: 'Registration expense (AED)', value: String(wfFinal.registrationExpense ?? 0) }]
            : []),
        ...(wfFinal.otherExpense != null
            ? [{ label: 'Other expenses (AED)', value: String(wfFinal.otherExpense ?? 0) }]
            : []),
        { label: 'Balance in hand (AED)', value: String(wfFinal.balanceInHand ?? 0) },
    ];
    if (companyEmail) {
        sendVehicleDispositionCompanyEmail({
            companyEmail,
            companyName,
            vehicleLabel: label,
            targetLabel,
            detailUrl: url,
            summaryLines,
        }).catch(() => {});
    }

    const requester = wfFinal.requestedBy
        ? await EmployeeBasic.findById(wfFinal.requestedBy)
              .select('firstName lastName companyEmail workEmail personalEmail email')
              .lean()
        : null;
    if (requester) {
        sendVehicleDispositionOutcomeEmail({
            recipient: requester,
            vehicleLabel: label,
            detailUrl: url,
            status: 'completed',
            comment: `Vehicle is now marked as ${targetLabel}.`,
        }).catch(() => {});
    }

    return { finalized: true, asset };
};

/**
 * POST /api/AssetItem/:id/submit-vehicle-disposition-request
 */
export const submitVehicleDispositionRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body || {};
        const targetStatus = String(body.targetStatus || '').toLowerCase().trim();
        if (!['sold', 'total loss'].includes(targetStatus)) {
            return res.status(400).json({ message: 'Target status must be sold or total loss.' });
        }

        const asset = await AssetItem.findById(id).populate('typeId', 'name assignedCompany');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!isFleetVehicleAsset(asset)) {
            return res.status(400).json({ message: 'Disposition workflow is only for fleet vehicles.' });
        }

        const profileStatus = String(asset.vehicleProfileActivationStatus || 'inactive').toLowerCase();
        if (profileStatus !== 'active') {
            return res.status(400).json({ message: 'Vehicle profile must be activated before requesting Sold or Total loss.' });
        }
        if (String(asset.vehicleDispositionStatus || 'active').toLowerCase() !== 'active') {
            return res.status(400).json({ message: 'Vehicle is already marked Sold or Total loss.' });
        }

        const existingStage = String(asset.vehicleDispositionWorkflow?.stage || '').toLowerCase();
        if (existingStage === STAGE.HR || existingStage === STAGE.FINANCE) {
            return res.status(400).json({ message: 'A disposition request is already in progress for this vehicle.' });
        }

        const hrHOD = await getDepartmentHOD('hr');
        if (!hrHOD?._id) {
            return res.status(400).json({ message: 'No HR assignee is configured in the company flowchart.' });
        }

        const financeCheck = await validateFinanceStakeholders();
        if (!financeCheck.ok) return res.status(400).json({ message: financeCheck.message });

        const submitterId = await resolveProfileActivationSubmitterId(req);
        if (!submitterId) {
            return res.status(400).json({ message: 'Your login must be linked to an employee record to submit this request.' });
        }

        let accidentKey = asset.accidentReportAttachment || null;
        if (targetStatus === 'total loss' && body.accidentReportDocument?.data) {
            const ar = body.accidentReportDocument;
            const uploadResult = await uploadDocumentToS3(ar.data, 'asset-documents', ar.name || 'accident-report');
            accidentKey = uploadResult.publicId;
        }

        const soldValue =
            targetStatus === 'sold' ? Number(String(body.soldValue || '').replace(/\D/g, '') || 0) : null;
        const totalLossValue =
            targetStatus === 'total loss'
                ? Number(String(body.totalLossValue || '').replace(/\D/g, '') || 0)
                : null;

        if (targetStatus === 'sold' && !soldValue) {
            return res.status(400).json({ message: 'Sold value is required.' });
        }
        if (targetStatus === 'total loss' && !totalLossValue) {
            return res.status(400).json({ message: 'Total loss value is required.' });
        }

        const requesterName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            req.user?.employeeId ||
            '';

        const loanAmt = parseMoneyInt(body.currentLoanAmount);
        const registrationExpense = parseMoneyInt(body.registrationExpense);
        const otherExpense = parseMoneyInt(body.otherExpense);
        const payoutValue = targetStatus === 'sold' ? soldValue : totalLossValue;
        const balanceInHand = computeSoldBalanceInHand({
            soldValue: payoutValue,
            currentLoanAmount: loanAmt,
            registrationExpense,
            otherExpense,
        });

        asset.vehicleDispositionWorkflow = {
            targetStatus,
            stage: STAGE.HR,
            requestedAt: new Date(),
            requestedBy: submitterId,
            requestedByName: requesterName,
            note: String(body.note || '').trim().slice(0, 2000),
            soldValue,
            totalLossValue,
            currentLoanAmount: loanAmt,
            balanceInHand,
            registrationExpiryDate: null,
            registrationExpense,
            otherExpense,
            accidentReportAttachment: accidentKey,
            accountsCompletedAt: null,
            accountsCompletedBy: null,
            managementCompletedAt: null,
            managementCompletedBy: null,
            history: [
                {
                    stage: STAGE.HR,
                    action: 'submit',
                    note: body.note || '',
                    byName: requesterName,
                    at: new Date(),
                },
            ],
        };
        asset.markModified('vehicleDispositionWorkflow');
        await asset.save();

        await clearDispositionDashboard(asset._id);

        const label = vehicleLabel(asset);
        const targetLabel = targetStatusLabel(targetStatus);
        const url = detailUrlFor(req, id);

        await syncDashboardAction({
            requestId: asset._id,
            requestType: REQUEST_TYPE,
            assignedTo: String(hrHOD._id),
            status: 'Pending',
            subjectEmployee: vehicleSubjectForDashboard(asset),
            requestedByName: requesterName,
            extra1: `[Fleet] ${label} — ${targetLabel} (HR review)`,
            extra2: String(body.note || '').trim(),
            extra3: dispositionMeta(asset._id, 'hr'),
        });

        sendVehicleDispositionHrRequestEmail({
            hrEmployee: hrHOD,
            vehicleLabel: label,
            detailUrl: url,
            targetLabel,
            requesterName,
        }).catch(() => {});

        return res.status(200).json({
            message: 'Disposition request sent to HR for review.',
            vehicleDispositionWorkflow: asset.vehicleDispositionWorkflow,
        });
    } catch (err) {
        console.error('[submitVehicleDispositionRequest]', err);
        return res.status(500).json({ message: err.message || 'Failed to submit disposition request.' });
    }
};

/**
 * POST /api/AssetItem/:id/respond-vehicle-disposition-hr
 * body: { action: 'approve' | 'reject', comment?: string }
 */
export const respondVehicleDispositionHr = async (req, res) => {
    try {
        if (!(await canProcessHr(req))) {
            return res.status(403).json({ message: 'Only the flowchart HR assignee can approve or reject this request.' });
        }

        const { id } = req.params;
        const action = String(req.body?.action || '').toLowerCase();
        const comment = String(req.body?.comment || '').trim();

        const asset = await AssetItem.findById(id).populate('typeId', 'name assignedCompany');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const wf = asset.vehicleDispositionWorkflow;
        if (!wf || wf.stage !== STAGE.HR) {
            return res.status(400).json({ message: 'This vehicle is not awaiting HR disposition review.' });
        }

        const actorName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            'HR';

        const hrHOD = await getDepartmentHOD('hr');
        await syncDashboardAction({
            requestId: asset._id,
            requestType: REQUEST_TYPE,
            status: action === 'approve' ? 'Approved' : 'Rejected',
            assignedTo: hrHOD?._id,
            actionedBy: req.user?.employeeObjectId || req.user?._id,
            comment,
            subjectEmployee: vehicleSubjectForDashboard(asset),
            requestedByName: wf.requestedByName || '',
            extra3: dispositionMeta(asset._id, 'hr'),
        });
        await clearDispositionDashboard(asset._id, hrHOD?._id);

        const label = vehicleLabel(asset);
        const url = detailUrlFor(req, id);
        const targetLabel = targetStatusLabel(wf.targetStatus);

        if (action === 'reject') {
            wf.stage = STAGE.REJECTED;
            pushHistory(wf, { stage: STAGE.REJECTED, action: 'reject', note: comment, byName: actorName });
            asset.markModified('vehicleDispositionWorkflow');
            await asset.save();

            const requester = wf.requestedBy
                ? await EmployeeBasic.findById(wf.requestedBy)
                      .select('firstName lastName companyEmail workEmail personalEmail email')
                      .lean()
                : null;
            if (requester) {
                sendVehicleDispositionOutcomeEmail({
                    recipient: requester,
                    vehicleLabel: label,
                    detailUrl: url,
                    status: 'rejected',
                    comment,
                }).catch(() => {});
            }

            return res.json({ message: 'Disposition request rejected.', asset });
        }

        if (action !== 'approve') {
            return res.status(400).json({ message: 'Invalid action. Use approve or reject.' });
        }

        const financeCheck = await validateFinanceStakeholders();
        if (!financeCheck.ok) return res.status(400).json({ message: financeCheck.message });

        pushHistory(wf, { stage: STAGE.FINANCE, action: 'approve', note: comment, byName: actorName });
        await AssetItem.updateOne(
            { _id: asset._id },
            {
                $set: {
                    'vehicleDispositionWorkflow.stage': STAGE.FINANCE,
                    'vehicleDispositionWorkflow.history': wf.history,
                },
                $unset: {
                    'vehicleDispositionWorkflow.accountsCompletedAt': 1,
                    'vehicleDispositionWorkflow.accountsCompletedBy': 1,
                    'vehicleDispositionWorkflow.managementCompletedAt': 1,
                    'vehicleDispositionWorkflow.managementCompletedBy': 1,
                },
            },
        );
        const assetAfterHr = await AssetItem.findById(asset._id).populate('typeId', 'name assignedCompany');
        if (!assetAfterHr) {
            return res.status(500).json({ message: 'Failed to update disposition workflow after HR approval.' });
        }

        const { accountsHOD, managementHOD } = financeCheck;
        const requesterName = wf.requestedByName || actorName;
        const labelAfterHr = vehicleLabel(assetAfterHr);
        const targetLabelAfterHr = targetStatusLabel(assetAfterHr.vehicleDispositionWorkflow?.targetStatus);

        await syncDashboardAction({
            requestId: assetAfterHr._id,
            requestType: REQUEST_TYPE,
            assignedTo: String(accountsHOD._id),
            status: 'Pending',
            subjectEmployee: vehicleSubjectForDashboard(assetAfterHr),
            requestedByName: requesterName,
            extra1: `[Fleet] ${labelAfterHr} — ${targetLabelAfterHr} (Accounts)`,
            extra2: comment || '',
            extra3: dispositionMeta(assetAfterHr._id, 'accounts'),
        });
        await syncDashboardAction({
            requestId: assetAfterHr._id,
            requestType: REQUEST_TYPE,
            assignedTo: String(managementHOD._id),
            status: 'Pending',
            subjectEmployee: vehicleSubjectForDashboard(assetAfterHr),
            requestedByName: requesterName,
            extra1: `[Fleet] ${labelAfterHr} — ${targetLabelAfterHr} (Management)`,
            extra2: comment || '',
            extra3: dispositionMeta(assetAfterHr._id, 'management'),
        });

        for (const [recipient, roleLabel] of [
            [accountsHOD, 'Accounts'],
            [managementHOD, 'Management'],
        ]) {
            sendVehicleDispositionFinanceTaskEmail({
                recipient,
                vehicleLabel: labelAfterHr,
                detailUrl: detailUrlFor(
                    req,
                    assetAfterHr._id,
                    roleLabel === 'Accounts' ? 'accounts' : 'management',
                ),
                targetLabel: targetLabelAfterHr,
                roleLabel,
            }).catch(() => {});
        }

        return res.json({ message: 'HR approved. Accounts and Management have been notified — either may submit once to finalize.', asset: assetAfterHr });
    } catch (err) {
        console.error('[respondVehicleDispositionHr]', err);
        return res.status(500).json({ message: err.message || 'Failed to process HR response.' });
    }
};

/**
 * POST /api/AssetItem/:id/submit-vehicle-disposition-finance
 * body: { role: 'accounts' | 'management' }
 */
export const submitVehicleDispositionFinance = async (req, res) => {
    try {
        const role = String(req.body?.role || '').toLowerCase();
        if (!['accounts', 'management'].includes(role)) {
            return res.status(400).json({ message: 'role must be accounts or management.' });
        }

        if (role === 'accounts' && !(await canProcessAccounts(req))) {
            return res.status(403).json({ message: 'Only the flowchart Accounts assignee can submit this step.' });
        }
        if (role === 'management' && !(await canProcessManagement(req))) {
            return res.status(403).json({ message: 'Only Management can submit this step.' });
        }

        const { id } = req.params;
        const exists = await AssetItem.findById(id).select('vehicleDispositionWorkflow vehicleDispositionStatus').lean();
        if (!exists) return res.status(404).json({ message: 'Asset not found' });

        const wf0 = exists.vehicleDispositionWorkflow;
        if (!wf0 || wf0.stage !== STAGE.FINANCE) {
            return res.status(400).json({ message: 'This vehicle is not awaiting Accounts/Management disposition review.' });
        }
        if (String(exists.vehicleDispositionStatus || 'active').toLowerCase() !== 'active') {
            return res.status(400).json({ message: 'This vehicle disposition is already finalized.' });
        }

        const actorId = req.user?.employeeObjectId || req.user?._id;
        const actorName =
            req.user?.name ||
            [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() ||
            role;

        const now = new Date();
        const historyEntry = {
            stage: STAGE.FINANCE,
            action: role === 'accounts' ? 'accounts_submit' : 'management_submit',
            note: '',
            byName: actorName,
            at: now,
        };

        const stepNotDoneClause =
            role === 'accounts'
                ? {
                      $or: [
                          { 'vehicleDispositionWorkflow.accountsCompletedBy': null },
                          { 'vehicleDispositionWorkflow.accountsCompletedBy': { $exists: false } },
                      ],
                  }
                : {
                      $or: [
                          { 'vehicleDispositionWorkflow.managementCompletedBy': null },
                          { 'vehicleDispositionWorkflow.managementCompletedBy': { $exists: false } },
                      ],
                  };

        const stepQuery = {
            $and: [
                { _id: id },
                { vehicleDispositionStatus: 'active' },
                { 'vehicleDispositionWorkflow.stage': STAGE.FINANCE },
                stepNotDoneClause,
            ],
        };
        const stepUpdate =
            role === 'accounts'
                ? {
                      $set: {
                          'vehicleDispositionWorkflow.accountsCompletedAt': now,
                          'vehicleDispositionWorkflow.accountsCompletedBy': actorId,
                      },
                      $push: { 'vehicleDispositionWorkflow.history': historyEntry },
                  }
                : {
                      $set: {
                          'vehicleDispositionWorkflow.managementCompletedAt': now,
                          'vehicleDispositionWorkflow.managementCompletedBy': actorId,
                      },
                      $push: { 'vehicleDispositionWorkflow.history': historyEntry },
                  };

        const stepped = await AssetItem.findOneAndUpdate(stepQuery, stepUpdate, { new: true });
        if (!stepped) {
            return res.status(400).json({
                message:
                    'This step is already recorded or the disposition is already complete. Refresh the vehicle page.',
            });
        }

        const finalizeResult = await tryFinalizeDispositionAtomic(req, id, actorName);
        const finalized = finalizeResult.finalized;
        const finalizedAsset = finalizeResult.asset;

        const fresh = finalizedAsset
            ? finalizedAsset
            : await AssetItem.findById(id).populate('typeId', 'name assignedCompany');

        return res.json({
            message: finalized
                ? 'Submitted. Vehicle status has been updated and the company has been notified.'
                : 'Submitted, but finalization did not complete. Please refresh or contact support.',
            finalized,
            asset: fresh,
        });
    } catch (err) {
        console.error('[submitVehicleDispositionFinance]', err);
        return res.status(500).json({ message: err.message || 'Failed to submit finance step.' });
    }
};
