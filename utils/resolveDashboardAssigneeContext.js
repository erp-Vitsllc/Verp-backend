import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import { isJwtSystemSuperUser } from './systemSuperUser.js';

/**
 * Resolve who pending-inbox / Command Center should be built for.
 * - No targetUserId → logged-in user
 * - targetUserId → that EmployeeBasic, only if viewer is self, system admin, or an ancestor manager
 *
 * @returns {{
 *   ok: boolean,
 *   status?: number,
 *   message?: string,
 *   employee: object|null,
 *   portalUser: object|null,
 *   relevantIds: any[],
 *   employeeIdCode: string|null,
 *   isTargeted: boolean,
 * }}
 */
export async function resolveDashboardAssigneeContext(req) {
    const currentUser = req.user;
    if (!currentUser) {
        return {
            ok: false,
            status: 401,
            message: 'Unauthorized',
            employee: null,
            portalUser: null,
            relevantIds: [],
            employeeIdCode: null,
            isTargeted: false,
        };
    }

    const targetUserId = String(req.query.targetUserId || '').trim();
    const isTargeted = Boolean(targetUserId);

    if (!isTargeted) {
        const employee = await EmployeeBasic.findOne({
            $or: [
                ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
                ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : []),
            ],
        })
            .select('_id employeeId firstName lastName companyEmail')
            .lean();

        const relevantIds = [employee?._id, currentUser.employeeObjectId, currentUser?._id].filter(Boolean);
        return {
            ok: true,
            employee,
            portalUser: currentUser,
            relevantIds,
            employeeIdCode: currentUser.employeeId || employee?.employeeId || null,
            isTargeted: false,
        };
    }

    const targetEmployee = await EmployeeBasic.findById(targetUserId)
        .select('_id employeeId firstName lastName companyEmail primaryReportee')
        .lean();

    if (!targetEmployee) {
        return {
            ok: false,
            status: 404,
            message: 'Employee not found',
            employee: null,
            portalUser: null,
            relevantIds: [],
            employeeIdCode: null,
            isTargeted: true,
        };
    }

    const viewerEmployee = await EmployeeBasic.findOne({
        $or: [
            ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
            ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : []),
        ],
    })
        .select('_id employeeId')
        .lean();

    const isSelf =
        (viewerEmployee?._id && String(viewerEmployee._id) === String(targetEmployee._id)) ||
        (currentUser.employeeId &&
            targetEmployee.employeeId &&
            String(currentUser.employeeId) === String(targetEmployee.employeeId)) ||
        (currentUser.employeeObjectId && String(currentUser.employeeObjectId) === String(targetEmployee._id));

    const isAdmin = isJwtSystemSuperUser(currentUser);

    let canView = isSelf || isAdmin;
    if (!canView && viewerEmployee?._id) {
        // Target must sit in the viewer's reportee tree (any depth).
        const inTree = await EmployeeBasic.aggregate([
            { $match: { _id: viewerEmployee._id } },
            {
                $graphLookup: {
                    from: 'employeebasics',
                    startWith: '$_id',
                    connectFromField: '_id',
                    connectToField: 'primaryReportee',
                    as: 'team',
                    maxDepth: 20,
                },
            },
            {
                $project: {
                    hit: {
                        $gt: [
                            {
                                $size: {
                                    $filter: {
                                        input: '$team',
                                        as: 't',
                                        cond: {
                                            $eq: [
                                                { $toString: '$$t._id' },
                                                String(targetEmployee._id),
                                            ],
                                        },
                                    },
                                },
                            },
                            0,
                        ],
                    },
                },
            },
        ]);
        canView = Boolean(inTree?.[0]?.hit);
    }

    if (!canView) {
        return {
            ok: false,
            status: 403,
            message: 'Not allowed to view this employee inbox',
            employee: null,
            portalUser: null,
            relevantIds: [],
            employeeIdCode: null,
            isTargeted: true,
        };
    }

    const portalUser = await User.findOne({ employeeId: targetEmployee.employeeId })
        .select({ _id: 1, employeeId: 1, employeeObjectId: 1, name: 1, role: 1, isAdmin: 1 })
        .lean();

    const relevantIds = [targetEmployee._id, portalUser?._id, portalUser?.employeeObjectId].filter(Boolean);

    return {
        ok: true,
        employee: targetEmployee,
        portalUser: portalUser || { _id: targetEmployee._id, employeeId: targetEmployee.employeeId },
        relevantIds,
        employeeIdCode: targetEmployee.employeeId || null,
        isTargeted: true,
    };
}

export function buildAssigneeClauses(relevantIds = [], employeeIdCode = null) {
    return [
        ...(relevantIds.length ? [{ assignedTo: { $in: relevantIds } }] : []),
        ...(employeeIdCode ? [{ assignedToEmpId: employeeIdCode }] : []),
    ];
}
