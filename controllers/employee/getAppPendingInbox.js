import mongoose from 'mongoose';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import DashboardAction from '../../models/DashboardAction.js';
import { loadLoginThroughForCheck } from '../../utils/loginThrough.js';
import {
    appInboxChannel,
    isActionableAppInboxRow,
    presentAppInboxRow,
} from '../../utils/appPendingInbox.js';

async function resolveSelf(req) {
    if (req.user?.employeeObjectId && mongoose.Types.ObjectId.isValid(req.user.employeeObjectId)) {
        const byOid = await EmployeeBasic.findById(req.user.employeeObjectId)
            .select('_id employeeId loginThrough')
            .lean();
        if (byOid) return byOid;
    }
    if (req.user?.employeeId) {
        return EmployeeBasic.findOne({ employeeId: req.user.employeeId })
            .select('_id employeeId loginThrough')
            .lean();
    }
    return null;
}

/**
 * Pending requests for an employee who has App on and Web off.
 * Same rule as an asset assignment: the request is waiting in the app.
 * @route GET /api/Employee/dashboard/app-inbox
 */
export async function getAppPendingInbox(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }
        if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

        const self = await resolveSelf(req);
        if (!self?._id) return res.status(200).json({ count: 0, items: [], channel: null });

        const source = await loadLoginThroughForCheck(self);
        const channel = appInboxChannel(source);
        if (channel !== 'app') {
            return res.status(200).json({ count: 0, items: [], channel: null });
        }

        const assigneeIds = [self._id, req.user._id, req.user.employeeObjectId].filter(Boolean);
        const employeeCode = String(self.employeeId || req.user.employeeId || '').trim();
        const rows = await DashboardAction.find({
            status: 'Pending',
            $or: [
                { assignedTo: { $in: assigneeIds } },
                ...(employeeCode ? [{ assignedToEmpId: employeeCode }] : []),
            ],
        })
            .select('requestId requestType status subjectName requestedByName requestedDate extra1 extra2 extra3 createdAt')
            .sort({ requestedDate: -1, createdAt: -1 })
            .limit(80)
            .lean();

        const items = (rows || []).filter(isActionableAppInboxRow).map(presentAppInboxRow);
        return res.status(200).json({ count: items.length, items, channel: 'app' });
    } catch (error) {
        console.error('[getAppPendingInbox]', error);
        return res.status(500).json({ message: error.message || 'Failed to load app inbox.' });
    }
}
