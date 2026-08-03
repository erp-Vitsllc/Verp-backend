import UtilityEntryStatusChange from '../../models/UtilityEntryStatusChange.js';
import UtilityBillPaymentDay from '../../models/UtilityBillPaymentDay.js';
import UtilityEntry from '../../models/UtilityEntry.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import DashboardAction from '../../models/DashboardAction.js';
import mongoose from 'mongoose';
import { getDepartmentHOD, isUserInFlowchart } from '../../utils/getDepartmentHOD.js';
import { syncDashboardAction } from '../../utils/syncDashboard.js';
import { sendUtilityEntryStatusEmail } from '../../utils/sendUtilityEntryStatusEmail.js';
import { clearUtilityContractExpiryNotifications } from '../../utils/processUtilityContractExpiryReminders.js';

export const REQUEST_TYPE = 'Utility Entry Status Change';

function empDisplayName(emp) {
    if (!emp) return '';
    return `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeId || 'User';
}

function attachmentPayload(attachment) {
    if (attachment?.name && attachment?.dataUrl) {
        return {
            name: String(attachment.name).slice(0, 240),
            mime: String(attachment.mime || '').slice(0, 120),
            dataUrl: String(attachment.dataUrl),
        };
    }
    return null;
}

async function resolveRequesterEmployee(user) {
    if (!user) return null;
    const select =
        'firstName lastName employeeId companyEmail workEmail personalEmail email status';
    if (user.employeeObjectId && mongoose.Types.ObjectId.isValid(user.employeeObjectId)) {
        const emp = await EmployeeBasic.findById(user.employeeObjectId).select(select).lean();
        if (emp) return emp;
    }
    const rawId = user.employeeId;
    if (rawId) {
        if (mongoose.Types.ObjectId.isValid(rawId)) {
            const byOid = await EmployeeBasic.findById(rawId).select(select).lean();
            if (byOid) return byOid;
        }
        const byCode = await EmployeeBasic.findOne({ employeeId: String(rawId).trim() })
            .select(select)
            .lean();
        if (byCode) return byCode;
    }
    if (user.email) {
        return EmployeeBasic.findOne({
            $or: [
                { companyEmail: user.email },
                { workEmail: user.email },
                { email: user.email },
            ],
        })
            .select(select)
            .lean();
    }
    return null;
}

async function isActorHrOrAdmin(actor, reqUser) {
    const hr = await getDepartmentHOD('hr');
    const role = String(reqUser?.role || reqUser?.userType || '').toLowerCase();
    const isAdminUser = role.includes('admin') || role.includes('super');
    const isHrById = Boolean(hr?._id && actor?._id && String(hr._id) === String(actor._id));
    const isHrByFlow = await isUserInFlowchart(reqUser, 'hr').catch(() => false);
    const isHr = isHrById || isHrByFlow;
    return { hr, isHr, isAdminUser, allowed: isHr || isAdminUser };
}

function reviewPath(requestId) {
    return `/HRM/Asset/UtilityBills?statusChangeId=${encodeURIComponent(String(requestId))}&review=1`;
}

function actionLabel(requestedStatus) {
    return requestedStatus === 'Active' ? 'Activate' : 'Deactivate';
}

async function syncStatusChangeDashboard({
    request,
    assignedTo,
    status = 'Pending',
    actionedBy = null,
    comment = '',
}) {
    const requestId = String(request._id);
    await DashboardAction.updateMany(
        { requestId, requestType: REQUEST_TYPE, status: 'Pending' },
        {
            status: status === 'Rejected' ? 'Rejected' : 'Approved',
            actionedDate: new Date(),
            actionedBy: actionedBy || null,
            comment: comment || '',
        },
    );

    if (status !== 'Pending' || !assignedTo) return;

    const label = actionLabel(request.requestedStatus);
    await syncDashboardAction({
        requestId,
        requestType: REQUEST_TYPE,
        status: 'Pending',
        assignedTo,
        actionedBy,
        comment,
        subjectEmployee: null,
        requestedByName: request.requestedByName || '',
        extra1: `${request.utilityType || 'Utility'} — ${label} · Acc ${request.accountNo || '—'}`,
        extra2: `HR approval · ${request.currentStatus} → ${request.requestedStatus}`,
        extra3: JSON.stringify({
            statusChangeId: requestId,
            entryId: request.entryId,
            utilityType: request.utilityType,
            requestedStatus: request.requestedStatus,
            detailsPath: `/HRM/Asset/UtilityBills/details/${encodeURIComponent(String(request.entryId))}`,
            reviewPath: reviewPath(requestId),
        }),
    });
}

/** POST /api/UtilityBill/status-change */
export async function createUtilityEntryStatusChange(req, res) {
    try {
        const {
            entryId,
            utilityType,
            accountNo,
            provider,
            currentStatus,
            requestedStatus,
            reason,
            attachment,
        } = req.body || {};

        const id = String(entryId || '').trim();
        if (!id) return res.status(400).json({ message: 'entryId is required' });

        const nextStatus = String(requestedStatus || '').trim();
        if (nextStatus !== 'Active' && nextStatus !== 'Inactive') {
            return res.status(400).json({ message: 'requestedStatus must be Active or Inactive' });
        }

        const reasonText = String(reason || '').trim();
        if (reasonText.length < 3) {
            return res.status(400).json({ message: 'Reason is required (min 3 characters)' });
        }

        const attach = attachmentPayload(attachment);

        const existingPending = await UtilityEntryStatusChange.findOne({
            entryId: id,
            status: 'Pending',
        }).lean();
        if (existingPending) {
            return res.status(409).json({
                message: 'A status change request is already pending HR approval for this record.',
                request: existingPending,
            });
        }

        const hr = await getDepartmentHOD('hr');
        if (!hr?._id) {
            return res.status(400).json({ message: 'HR flowchart user is not configured.' });
        }

        const requester = await resolveRequesterEmployee(req.user);
        const fromStatus =
            String(currentStatus || '').trim() === 'Inactive' ? 'Inactive' : 'Active';

        const doc = await UtilityEntryStatusChange.create({
            entryId: id,
            utilityType: String(utilityType || '').trim(),
            accountNo: String(accountNo || '').trim(),
            provider: String(provider || '').trim(),
            currentStatus: fromStatus,
            requestedStatus: nextStatus,
            reason: reasonText,
            attachment: attach || undefined,
            status: 'Pending',
            requestedBy: requester?._id || null,
            requestedByName: empDisplayName(requester) || String(req.user?.name || '').trim(),
            pendingWith: hr._id,
            pendingWithName: empDisplayName(hr),
        });

        await syncStatusChangeDashboard({
            request: doc,
            assignedTo: hr._id,
            status: 'Pending',
        });

        sendUtilityEntryStatusEmail({
            recipient: hr,
            request: doc.toObject ? doc.toObject() : doc,
            kind: 'pending_hr',
        }).catch((e) => console.error('[createUtilityEntryStatusChange] email', e?.message || e));

        return res.status(201).json({
            success: true,
            message: `${actionLabel(nextStatus)} request sent to HR for approval.`,
            request: doc,
        });
    } catch (err) {
        console.error('[createUtilityEntryStatusChange]', err);
        return res.status(500).json({ message: err?.message || 'Failed to create status change request' });
    }
}

/** GET /api/UtilityBill/status-change/:id */
export async function getUtilityEntryStatusChange(req, res) {
    try {
        const doc = await UtilityEntryStatusChange.findById(req.params.id).lean();
        if (!doc) return res.status(404).json({ message: 'Request not found' });

        const actor = await resolveRequesterEmployee(req.user);
        const hrGate = await isActorHrOrAdmin(actor, req.user);
        const canRespond = doc.status === 'Pending' && hrGate.allowed;

        return res.status(200).json({
            request: doc,
            canRespond,
        });
    } catch (err) {
        console.error('[getUtilityEntryStatusChange]', err);
        return res.status(500).json({ message: err?.message || 'Failed to load request' });
    }
}

/** GET /api/UtilityBill/status-change?entryId= */
export async function listUtilityEntryStatusChanges(req, res) {
    try {
        const entryId = String(req.query.entryId || '').trim();
        const filter = {};
        if (entryId) filter.entryId = entryId;
        if (req.query.status) filter.status = String(req.query.status);

        const list = await UtilityEntryStatusChange.find(filter)
            .sort({ createdAt: -1 })
            .limit(entryId ? 20 : 100)
            .lean();

        return res.status(200).json({ requests: list });
    } catch (err) {
        console.error('[listUtilityEntryStatusChanges]', err);
        return res.status(500).json({ message: err?.message || 'Failed to list requests' });
    }
}

/** PUT /api/UtilityBill/status-change/:id/respond */
export async function respondUtilityEntryStatusChange(req, res) {
    try {
        const doc = await UtilityEntryStatusChange.findById(req.params.id);
        if (!doc) return res.status(404).json({ message: 'Request not found' });
        if (doc.status !== 'Pending') {
            return res.status(400).json({ message: `Request is already ${doc.status}` });
        }

        const decision = String(req.body?.decision || '').toLowerCase();
        if (decision !== 'approve' && decision !== 'reject') {
            return res.status(400).json({ message: 'decision must be approve or reject' });
        }

        const actor = await resolveRequesterEmployee(req.user);
        const hrGate = await isActorHrOrAdmin(actor, req.user);
        if (!hrGate.allowed) {
            return res.status(403).json({ message: 'Only HR (or Admin) can approve this request.' });
        }

        const hrComment = String(req.body?.comment || '').trim();
        doc.status = decision === 'approve' ? 'Approved' : 'Rejected';
        doc.actionedBy = actor?._id || null;
        doc.actionedByName = empDisplayName(actor);
        doc.actionedAt = new Date();
        doc.hrComment = hrComment;
        doc.pendingWith = null;
        doc.pendingWithName = '';
        await doc.save();

        if (decision === 'approve') {
            await UtilityEntry.findByIdAndUpdate(doc.entryId, {
                $set: { status: doc.requestedStatus, pendingStatusChange: null },
            });
            await UtilityBillPaymentDay.findOneAndUpdate(
                { entryId: doc.entryId },
                { $set: { status: doc.requestedStatus } },
                { upsert: false },
            );
            if (doc.requestedStatus === 'Inactive') {
                await clearUtilityContractExpiryNotifications(
                    doc.entryId,
                    'Utility account deactivated',
                ).catch((e) =>
                    console.error(
                        '[respondUtilityEntryStatusChange] clear contract expiry',
                        e?.message || e,
                    ),
                );
            }
        }

        await syncStatusChangeDashboard({
            request: doc,
            assignedTo: null,
            status: doc.status,
            actionedBy: actor?._id || null,
            comment: hrComment || (decision === 'approve' ? 'Approved' : 'Rejected'),
        });

        if (doc.requestedBy) {
            const requester = await EmployeeBasic.findById(doc.requestedBy)
                .select('firstName lastName companyEmail workEmail personalEmail email employeeId')
                .lean();
            if (requester) {
                sendUtilityEntryStatusEmail({
                    recipient: requester,
                    request: doc.toObject(),
                    kind: decision === 'approve' ? 'approved' : 'rejected',
                }).catch((e) =>
                    console.error('[respondUtilityEntryStatusChange] email', e?.message || e),
                );
            }
        }

        return res.status(200).json({
            success: true,
            message:
                decision === 'approve'
                    ? `${actionLabel(doc.requestedStatus)} approved. Status updated.`
                    : `${actionLabel(doc.requestedStatus)} request rejected.`,
            request: doc,
            applyLocalStatus: decision === 'approve' ? doc.requestedStatus : null,
            entryId: doc.entryId,
        });
    } catch (err) {
        console.error('[respondUtilityEntryStatusChange]', err);
        return res.status(500).json({ message: err?.message || 'Failed to respond to request' });
    }
}
