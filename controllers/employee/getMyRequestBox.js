import mongoose from 'mongoose';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeHubRequest from '../../models/EmployeeHubRequest.js';
import Attendance from '../../models/Attendance.js';
import Loan from '../../models/Loan.js';
import AssetItem from '../../models/AssetItem.js';
import { hubRequestDisplayLabel } from '../../utils/employeeHubRequestTypes.js';

const SERVICE_BOXES = {
    oil: 'Oil Service',
    tyre: 'Tire Change',
    mechanical: 'Mechanical Work',
    body: 'Body Work',
    accident: 'Accident Repair',
    carwash: 'Car Wash',
};

const SERVICE_STEPS = [
    'Created',
    'HR Approval',
    'Schedule',
    'Ready to Service',
    'On Service',
    'Complete Service',
    'Accounts Approve',
    'Make Payment',
];

const LOG_LABELS = {
    service_created: 'Request created',
    service_updated: 'Request updated',
    service_scheduled: 'Service scheduled',
    on_service: 'Vehicle on service',
    date_change: 'Service date changed',
    schedule_submitted: 'Schedule submitted',
    schedule_resubmitted: 'Schedule updated',
    initiate_edited: 'Request edited',
    service_completed: 'Service completed',
    hr_approved: 'HR approved',
    accounts_approved: 'Accounts approved',
    zoho_bill_created: 'Bill created',
};

function isPendingStatus(raw) {
    const status = String(raw || '').trim().toLowerCase();
    if (!status) return false;
    if (status.includes('reject') || status.includes('cancel') || status === 'draft' || status === 'paid') return false;
    if (status === 'complete' || status === 'completed' || status.includes('approv')) return false;
    return status.includes('pending') || status.includes('hold') || status === 'submitted';
}

async function resolveSelf(req) {
    if (req.user?.employeeObjectId && mongoose.Types.ObjectId.isValid(req.user.employeeObjectId)) {
        const byOid = await EmployeeBasic.findById(req.user.employeeObjectId).select('_id employeeId firstName lastName').lean();
        if (byOid) return byOid;
    }
    if (req.user?.employeeId) {
        return EmployeeBasic.findOne({ employeeId: req.user.employeeId }).select('_id employeeId firstName lastName').lean();
    }
    return null;
}

function iso(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

function text(value) {
    return String(value ?? '').trim();
}

function detail(label, value) {
    const next = text(value);
    if (!next) return null;
    return { label, value: next };
}

function personName(emp) {
    return `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim();
}

function parseRemark(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return {};
    }
}

function serviceStepIndex(stage) {
    const key = String(stage || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (!key || key === 'pending' || key === 'created' || key === 'service_due' || key === 'draft' || key === 'submitted') return 0;
    if (key.includes('payment') || key === 'billed' || key === 'accounts_payment') return 7;
    if (key.includes('account') || key === 'pending_accounts' || key === 'accounts_quote') return 6;
    if (key.includes('complete_due') || key === 'overdue' || key === 'complete_service') return 5;
    if (key === 'complete' || key === 'completed') return SERVICE_STEPS.length;
    if (key.includes('on_service')) return 4;
    if (key.includes('ready')) return 3;
    if (key.includes('schedule_hr')) return 1;
    if (key.includes('schedule') || key === 'scheduled_service') return 2;
    if (key.includes('hr') || key === 'pending_hr') return 1;
    return 0;
}

function trackingFromStage(stage) {
    const index = serviceStepIndex(stage);
    return SERVICE_STEPS.map((label, step) => ({
        label,
        state: index >= SERVICE_STEPS.length ? 'done' : step < index ? 'done' : step === index ? 'current' : 'upcoming',
        at: null,
        by: '',
        note: '',
    }));
}

function stageName(stage) {
    const index = serviceStepIndex(stage);
    if (index >= SERVICE_STEPS.length) return 'Completed';
    return SERVICE_STEPS[index];
}

function serviceMatches(box, service) {
    const type = text(service?.serviceType).toLowerCase();
    if (box === 'oil') return type.includes('oil');
    if (box === 'tyre') return type.includes('tyre') || type.includes('tire');
    if (box === 'mechanical') return type.includes('mechanical');
    if (box === 'carwash') return type.includes('wash');
    if (box === 'accident') return type.includes('accident');
    if (box === 'body') return type.includes('body') && !type.includes('wash');
    return false;
}

function currentStage(service, asset) {
    const remark = parseRemark(service?.remark);
    const id = String(service?._id || '');
    const active = asset?.activeServiceWorkflow;
    const activeStage = active && String(active.serviceRecordId || '') === id ? active.stage : '';
    return text(activeStage || service?.workflowSnapshot?.stage || remark.workflowStage || remark.oilStage || remark.requestStatus || 'pending');
}

function serviceIsOpen(service, asset) {
    const stage = currentStage(service, asset).toLowerCase();
    if (stage.includes('reject') || stage.includes('cancel')) return false;
    if (stage === 'complete' || stage === 'completed') return false;
    return true;
}

function collectUpdates(service, asset) {
    const remark = parseRemark(service?.remark);
    const logs = [...(remark.oilActivityLog || []), ...(remark.tireActivityLog || [])];
    const id = String(service?._id || '');
    const history = [];
    if (asset?.activeServiceWorkflow && String(asset.activeServiceWorkflow.serviceRecordId || '') === id) {
        history.push(...(asset.activeServiceWorkflow.history || []));
    }
    history.push(...(service?.workflowSnapshot?.history || []));
    const updates = [];
    for (const row of logs) {
        updates.push({
            label: LOG_LABELS[row.type] || text(row.type).replace(/_/g, ' ') || 'Update',
            at: iso(row.at),
            by: text(row.byName),
            note: text(row.note),
        });
    }
    if (!updates.length) {
        for (const row of history) {
            updates.push({
                label: text(row.action || row.stage).replace(/_/g, ' ') || 'Update',
                at: iso(row.at),
                by: text(row.byName),
                note: text(row.note),
            });
        }
    }
    return updates.filter((row) => row.label);
}

function leaveKindLabel(row) {
    const kind = text(row.leaveRequestKind || row.requestedStatusLabel);
    if (kind === 'future_annual' || kind === 'annual_leave') return 'Annual leave';
    if (kind === 'leave' || kind === 'authorized') return 'Authorized leave';
    if (row.requestedStatusLabel) return text(row.requestedStatusLabel);
    return kind.replace(/_/g, ' ') || 'Leave';
}

function moneyTracking(workflow) {
    const rows = Array.isArray(workflow) ? workflow : [];
    if (!rows.length) return [];
    let seenCurrent = false;
    return rows.map((step) => {
        const status = text(step.status).toLowerCase();
        let state = 'upcoming';
        if (status === 'approved' || status === 'rejected') state = 'done';
        else if (!seenCurrent) {
            state = 'current';
            seenCurrent = true;
        }
        return {
            label: text(step.role) || 'Approval',
            state,
            at: iso(step.actionedAt || step.assignedAt),
            by: '',
            note: text(step.comment),
        };
    });
}

async function hubItems(self, box) {
    const kinds = box === 'all' ? ['salary', 'certificate', 'assets'] : [box];
    const rows = await EmployeeHubRequest.find({ requester: self._id, kind: { $in: kinds } })
        .sort({ createdAt: -1 })
        .limit(40)
        .populate('assignedTo', 'firstName lastName')
        .lean();
    return (rows || [])
        .filter((row) => isPendingStatus(row.status))
        .map((row) => {
            const waiting = personName(row.assignedTo);
            return {
                id: String(row._id),
                box: row.kind,
                title: hubRequestDisplayLabel(row.kind, row.assetType),
                status: text(row.status) || 'Pending',
                requestedDate: iso(row.createdAt),
                actionedDate: iso(row.decidedAt),
                details: [
                    detail('Type', row.assetType),
                    detail('Reason', row.reason),
                    detail('Description', row.description),
                    detail('Requested date', row.requestedDate),
                    detail('Addressed to', row.addressTo),
                    detail('Tools', Array.isArray(row.tools) ? row.tools.join('\n') : ''),
                    detail('SIM card', row.simCard),
                    detail('Calls per month', row.callsPerMonth),
                    detail('Waiting on', waiting),
                    detail('Note', row.decisionNote),
                ].filter(Boolean),
                tracking: [],
                updates: [],
            };
        });
}

async function leaveItems(self) {
    const rows = await Attendance.find({ employeeMongoId: String(self._id), leaveRequestStatus: 'pending' })
        .sort({ leaveRequestedAt: -1, updatedAt: -1 })
        .limit(120)
        .lean();
    const seen = new Set();
    const items = [];
    for (const row of rows || []) {
        const key = String(row.leaveRequestGroupId || row._id);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!isPendingStatus(row.leaveRequestStatus)) continue;
        const from = text(row.leaveRequestFromDate || row.date);
        const to = text(row.leaveRequestToDate || from);
        items.push({
            id: key,
            box: 'leave',
            title: leaveKindLabel(row),
            status: 'Pending',
            requestedDate: iso(row.leaveRequestedAt || row.createdAt),
            actionedDate: null,
            details: [
                detail('From', from),
                detail('To', to),
                detail('Day', [row.leaveRequestDayPart, row.leaveRequestSession].filter(Boolean).join(' ')),
                detail('Work', row.leaveRequestTimeIn && row.leaveRequestTimeOut
                    ? `${row.leaveRequestTimeIn}–${row.leaveRequestTimeOut}`
                    : ''),
                detail('Reason', row.leaveRequestReason),
            ].filter(Boolean),
            tracking: [],
            updates: [],
        });
    }
    return items;
}

async function moneyItems(self, box) {
    const employeeMatch = [{ employeeObjectId: self._id }];
    if (self.employeeId) employeeMatch.push({ employeeId: String(self.employeeId) });
    const type = box === 'advance' ? 'Advance' : 'Loan';
    const rows = await Loan.find({
        $and: [{ $or: employeeMatch }, { type }],
    })
        .select('type loanId amount duration monthStart reason status approvalStatus appliedDate createdAt workflow')
        .sort({ createdAt: -1 })
        .limit(40)
        .lean();
    return (rows || [])
        .filter((row) => isPendingStatus(row.approvalStatus || row.status))
        .map((row) => ({
            id: String(row._id),
            box,
            title: type,
            status: text(row.approvalStatus || row.status) || 'Pending',
            requestedDate: iso(row.appliedDate || row.createdAt),
            actionedDate: null,
            details: [
                detail('Request no', row.loanId),
                detail('Amount', row.amount != null ? `AED ${row.amount}` : ''),
                detail('Deduction months', row.duration != null ? String(row.duration) : ''),
                detail('Start month', row.monthStart),
                detail('Reason', row.reason),
            ].filter(Boolean),
            tracking: moneyTracking(row.workflow),
            updates: [],
        }));
}

async function serviceItems(self, box) {
    const assets = await AssetItem.find({ 'services.requestedBy': self._id })
        .select('assetId name plateNumber plateEmirate services activeServiceWorkflow')
        .lean();
    const items = [];
    for (const asset of assets || []) {
        const plate = [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(' ').trim();
        const vehicle = plate || asset.assetId || asset.name || 'Vehicle';
        for (const service of asset.services || []) {
            if (String(service.requestedBy || '') !== String(self._id)) continue;
            const matched = box === 'all'
                ? Object.keys(SERVICE_BOXES).find((key) => serviceMatches(key, service))
                : (serviceMatches(box, service) ? box : '');
            if (!matched) continue;
            if (!serviceIsOpen(service, asset)) continue;
            const remark = parseRemark(service.remark);
            const stage = currentStage(service, asset);
            const photos = Array.isArray(service.photos) ? service.photos.length : 0;
            items.push({
                id: String(service._id),
                box: matched,
                serviceId: String(service._id),
                vehicleId: String(asset._id),
                serviceReqNo: text(service.serviceReqNo),
                title: text(service.serviceReqNo) || SERVICE_BOXES[matched] || 'Service',
                status: stageName(stage),
                requestedDate: iso(service.date || service.createdAt),
                actionedDate: null,
                details: [
                    detail('Request no', service.serviceReqNo),
                    detail('Service', service.serviceType || SERVICE_BOXES[matched]),
                    detail('Vehicle', vehicle),
                    detail('Asset', asset.assetId),
                    detail('Stage', stageName(stage)),
                    detail('Description', service.description),
                    detail('Current KM', remark.currentKm ?? service.currentKm),
                    detail('Oil type', remark.oilServiceTypeText),
                    detail('Tyres', remark.tireNumber),
                    detail('Car wash', remark.carWashType),
                    detail('Wash month', remark.carWashMonth),
                    detail('Photos', photos ? String(photos) : ''),
                    detail('Invoice', remark.invoiceName),
                ].filter(Boolean),
                tracking: trackingFromStage(stage),
                updates: collectUpdates(service, asset),
            });
        }
    }
    items.sort((a, b) => new Date(b.requestedDate || 0).getTime() - new Date(a.requestedDate || 0).getTime());
    return items.slice(0, 30);
}

/**
 * GET /api/Employee/dashboard/my-request-box?box=oil
 * Pending requests for one My Requests box, with service tracking when it is a service.
 */
export async function getMyRequestBox(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }
        const box = text(req.query?.box).toLowerCase();
        const allowed = new Set(['all', 'oil', 'tyre', 'mechanical', 'body', 'accident', 'carwash', 'leave', 'advance', 'loan', 'salary', 'certificate', 'assets']);
        if (!allowed.has(box)) {
            return res.status(400).json({ message: 'Choose a request box.' });
        }
        const self = await resolveSelf(req);
        if (!self?._id) return res.status(200).json({ box, items: [] });

        if (box === 'all') {
            const [services, leave, loans, advances, hubs] = await Promise.all([
                serviceItems(self, 'all'),
                leaveItems(self),
                moneyItems(self, 'loan'),
                moneyItems(self, 'advance'),
                hubItems(self, 'all'),
            ]);
            return res.status(200).json({
                box,
                items: [...services, ...leave, ...loans, ...advances, ...hubs],
            });
        }

        let items = [];
        if (SERVICE_BOXES[box]) items = await serviceItems(self, box);
        else if (box === 'leave') items = await leaveItems(self);
        else if (box === 'loan' || box === 'advance') items = await moneyItems(self, box);
        else items = await hubItems(self, box);

        return res.status(200).json({ box, items });
    } catch (error) {
        console.error('[getMyRequestBox]', error);
        return res.status(500).json({ message: error.message || 'Failed to load this request.' });
    }
}
