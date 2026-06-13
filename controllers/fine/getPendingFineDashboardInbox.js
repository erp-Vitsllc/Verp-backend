import DashboardAction from '../../models/DashboardAction.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import Fine from '../../models/Fine.js';

const FINE_INBOX_TYPES = ['Fine', 'Group Fine Request'];

/**
 * Pending fine dashboard actions assigned to the logged-in user.
 * @route GET /api/Fine/dashboard/pending-inbox
 */
export const getPendingFineDashboardInbox = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });

        const manager = await EmployeeBasic.findOne({
            $or: [
                ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
                ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : []),
            ],
        })
            .select('_id employeeId')
            .lean();

        const relevantIds = [manager?._id, currentUser.employeeObjectId, currentUser?._id].filter(Boolean);
        const targetEmployeeId = currentUser.employeeId || manager?.employeeId;

        const assigneeClauses = [
            ...(relevantIds.length ? [{ assignedTo: { $in: relevantIds } }] : []),
            ...(targetEmployeeId ? [{ assignedToEmpId: targetEmployeeId }] : []),
        ];

        if (assigneeClauses.length === 0) {
            return res.json({ count: 0, items: [] });
        }

        const rows = await DashboardAction.find({
            status: 'Pending',
            requestType: { $in: FINE_INBOX_TYPES },
            $or: assigneeClauses,
        })
            .sort({ requestedDate: -1 })
            .limit(200)
            .lean();

        const fineIds = [...new Set(rows.map((r) => String(r.requestId)).filter(Boolean))];
        const fines = fineIds.length
            ? await Fine.find({ _id: { $in: fineIds } })
                  .select('_id fineId fineType fineStatus assignedEmployees category')
                  .lean()
            : [];
        const fineById = Object.fromEntries(fines.map((f) => [String(f._id), f]));

        const getBaseFineId = (fid = '') => {
            const parts = String(fid).split('-');
            if (parts.length > 3) return parts.slice(0, 3).join('-');
            return fid;
        };

        const items = rows.map((da) => {
            const fine = fineById[String(da.requestId)] || null;
            const isGroup = da.requestType === 'Group Fine Request';
            const subjectLabel =
                da.subjectName ||
                fine?.assignedEmployees?.[0]?.employeeName ||
                'Fine request';

            return {
                dashboardActionId: da._id,
                requestType: da.requestType,
                requestedDate: da.requestedDate,
                requestedByName: da.requestedByName,
                subjectName: subjectLabel,
                extra1: da.extra1 || fine?.fineType || '',
                extra2: da.extra2 || '',
                extra3: da.extra3,
                requestObjectId: da.requestId,
                primaryFineId: da.requestId,
                isGroup,
                fine: fine
                    ? {
                          _id: fine._id,
                          fineId: fine.fineId,
                          baseFineId: getBaseFineId(fine.fineId),
                          fineType: fine.fineType,
                          fineStatus: fine.fineStatus,
                      }
                    : null,
            };
        });

        res.json({ count: items.length, items });
    } catch (error) {
        console.error('getPendingFineDashboardInbox:', error);
        res.status(500).json({ message: 'Failed to load fine notifications' });
    }
};
