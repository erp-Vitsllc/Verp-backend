import mongoose from 'mongoose';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeHubRequest from '../../models/EmployeeHubRequest.js';
import { syncDashboardAction } from '../../utils/syncDashboard.js';
import {
    HUB_MENU_KINDS,
    HUB_ASSET_TYPES,
    HUB_DASHBOARD_TYPE,
    hubRequestDisplayLabel,
} from '../../utils/employeeHubRequestTypes.js';
import {
    sendEmployeeHubRequestEmails,
    sendEmployeeHubDecisionEmails,
} from '../../utils/sendEmployeeHubRequestEmails.js';
import { resolveEmployeeEmail } from '../../utils/resolveEmployeeEmail.js';

const SELECT_PERSON =
    '_id employeeId firstName lastName companyEmail workEmail email primaryReportee';

async function resolveSelf(req) {
    if (req.user?.employeeObjectId) {
        const byOid = await EmployeeBasic.findById(req.user.employeeObjectId).select(SELECT_PERSON).lean();
        if (byOid) return byOid;
    }
    if (req.user?.employeeId) {
        return EmployeeBasic.findOne({ employeeId: req.user.employeeId }).select(SELECT_PERSON).lean();
    }
    return null;
}

function personName(emp) {
    return `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim() || 'Employee';
}

function hubRequestLabel(kind, assetType = '') {
    return hubRequestDisplayLabel(kind, assetType);
}

function serialize(row) {
    if (!row) return null;
    return {
        id: String(row._id),
        kind: row.kind,
        assetType: row.assetType || '',
        label: hubRequestLabel(row.kind, row.assetType),
        description: row.description || '',
        attachmentName: row.attachmentName || '',
        status: row.status,
        requesterName: row.requesterName,
        requesterEmpId: row.requesterEmpId,
        requesterId: String(row.requester || ''),
        assignedTo: String(row.assignedTo || ''),
        decisionNote: row.decisionNote || '',
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
    };
}

/**
 * POST /api/Employee/dashboard/hub-request
 */
export async function createEmployeeHubRequest(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveSelf(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const kind = String(req.body?.kind || '').trim();
        const description = String(req.body?.description || '').trim();
        const attachmentName = String(req.body?.attachmentName || '').trim();
        const assetType = kind === 'assets' ? String(req.body?.assetType || '').trim() : '';

        if (!HUB_MENU_KINDS.includes(kind)) {
            return res.status(400).json({ message: 'Select a valid request type.' });
        }
        if (kind === 'assets' && !HUB_ASSET_TYPES.includes(assetType)) {
            return res.status(400).json({ message: 'Choose which asset this request is about.' });
        }
        if (!description) {
            return res.status(400).json({ message: 'Description is required.' });
        }

        const employee = await EmployeeBasic.findById(self._id)
            .select(SELECT_PERSON)
            .populate('primaryReportee', SELECT_PERSON)
            .lean();

        const manager = employee?.primaryReportee;
        if (!manager?._id) {
            return res.status(400).json({
                message: 'Primary reportee is required before sending a request.',
            });
        }

        const row = await EmployeeHubRequest.create({
            kind,
            assetType,
            description,
            attachmentName,
            requester: employee._id,
            requesterEmpId: employee.employeeId || '',
            requesterName: personName(employee),
            assignedTo: manager._id,
            assignedToEmpId: manager.employeeId || '',
            status: 'Pending',
        });

        const requestType = HUB_DASHBOARD_TYPE[kind];
        await syncDashboardAction({
            requestId: row._id,
            requestType,
            assignedTo: manager._id,
            status: 'Pending',
            subjectEmployee: employee,
            requestedByName: personName(employee),
            extra1: description.slice(0, 180),
            extra2: hubRequestLabel(kind, assetType),
            extra3: JSON.stringify({
                hubRequest: true,
                kind,
                assetType,
                requesterMongoId: String(employee._id),
            }),
        });

        sendEmployeeHubRequestEmails({
            manager,
            employee,
            kind,
            assetType,
            description,
            attachmentName,
            requestId: row._id,
        }).catch(() => null);

        return res.status(201).json({
            message: `${hubRequestLabel(kind, assetType)} request sent to ${personName(manager)}.`,
            request: serialize(row),
        });
    } catch (error) {
        console.error('[createEmployeeHubRequest]', error);
        return res.status(500).json({ message: error.message || 'Failed to send request.' });
    }
}

/**
 * GET /api/Employee/dashboard/hub-request/:id
 */
export async function getEmployeeHubRequest(req, res) {
    try {
        const self = await resolveSelf(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }
        const row = await EmployeeHubRequest.findById(req.params.id).lean();
        if (!row) return res.status(404).json({ message: 'Request not found.' });
        const isParty =
            String(row.requester) === String(self._id) ||
            String(row.assignedTo) === String(self._id);
        if (!isParty) {
            return res.status(403).json({ message: 'You cannot view this request.' });
        }
        return res.status(200).json({ request: serialize(row), canDecide: String(row.assignedTo) === String(self._id) && row.status === 'Pending' });
    } catch (error) {
        console.error('[getEmployeeHubRequest]', error);
        return res.status(500).json({ message: error.message || 'Failed to load request.' });
    }
}

/**
 * POST /api/Employee/dashboard/hub-request/:id/decide
 * Body: { decision: 'Approved' | 'Rejected', note?: string }
 */
export async function decideEmployeeHubRequest(req, res) {
    try {
        const self = await resolveSelf(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const decision = String(req.body?.decision || '').trim();
        if (decision !== 'Approved' && decision !== 'Rejected') {
            return res.status(400).json({ message: 'Decision must be Approved or Rejected.' });
        }

        const row = await EmployeeHubRequest.findById(req.params.id);
        if (!row) return res.status(404).json({ message: 'Request not found.' });
        if (String(row.assignedTo) !== String(self._id)) {
            return res.status(403).json({ message: 'Only the primary reportee can decide this request.' });
        }
        if (row.status !== 'Pending') {
            return res.status(400).json({ message: 'This request has already been actioned.' });
        }

        row.status = decision;
        row.decisionNote = String(req.body?.note || '').trim();
        row.decidedAt = new Date();
        row.decidedBy = self._id;
        await row.save();

        const requestType = HUB_DASHBOARD_TYPE[row.kind];
        const employee = await EmployeeBasic.findById(row.requester).select(SELECT_PERSON).lean();
        const manager = await EmployeeBasic.findById(row.assignedTo).select(SELECT_PERSON).lean();

        await syncDashboardAction({
            requestId: row._id,
            requestType,
            assignedTo: row.assignedTo,
            status: decision,
            subjectEmployee: employee,
            actionedBy: self._id,
            comment: row.decisionNote,
        });

        const { email: actorEmail } = resolveEmployeeEmail(self || manager || {});

        sendEmployeeHubDecisionEmails({
            manager,
            employee,
            kind: row.kind,
            assetType: row.assetType,
            decision,
            description: row.description,
            decisionNote: row.decisionNote,
            requestId: row._id,
            actorEmail,
        }).catch(() => null);

        return res.status(200).json({
            message: `${hubRequestLabel(row.kind, row.assetType)} request ${decision.toLowerCase()}.`,
            request: serialize(row),
        });
    } catch (error) {
        console.error('[decideEmployeeHubRequest]', error);
        return res.status(500).json({ message: error.message || 'Failed to decide request.' });
    }
}
