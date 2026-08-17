import EmployeeHubRequest from '../models/EmployeeHubRequest.js';
import {
    HUB_DASHBOARD_TYPE,
    hubRequestDisplayLabel,
} from './employeeHubRequestTypes.js';

function extra3For(row) {
    return JSON.stringify({
        hubRequest: true,
        kind: row.kind,
        assetType: String(row.assetType || '').trim(),
        requesterMongoId: String(row.requester || ''),
    });
}

export function mapHubRequestToInboxItem(row) {
    const id = String(row._id);
    const type = HUB_DASHBOARD_TYPE[row.kind] || 'Employee Leave Request';
    const label = hubRequestDisplayLabel(row.kind, row.assetType);
    return {
        dashboardActionId: id,
        requestType: type,
        requestedDate: row.createdAt,
        requestedByName: row.requesterName || 'Employee',
        subjectName: row.requesterName || 'Employee',
        extra1: String(row.description || '').slice(0, 180),
        extra2: label,
        extra3: extra3For(row),
        status: row.status || 'Pending',
        requestObjectId: id,
        primaryFineId: id,
        primaryAssetId: id,
        hubRequest: true,
        assetType: String(row.assetType || '').trim(),
        employeeMongoId: String(row.requester || ''),
        employeeId: row.requesterEmpId || '',
        message: `${label} request: ${String(row.description || '').slice(0, 80)}`,
        fine: {
            _id: id,
            fineId: `HUB-FINE-${id.slice(-6)}`,
            baseFineId: `HUB-FINE-${id.slice(-6)}`,
            fineType: 'Employee request',
            fineStatus: 'Pending HR',
        },
        loan: {
            _id: id,
            loanId: `HUB-${row.kind === 'loan' ? 'LOAN' : 'ADV'}-${id.slice(-6)}`,
            type: row.kind === 'loan' ? 'Loan' : 'Advance',
            amount: 0,
            status: 'Pending',
            approvalStatus: 'Pending',
        },
    };
}

export async function listPendingHubInboxItems({
    assigneeIds = [],
    kinds = [],
    assetScope = '',
} = {}) {
    const ids = (assigneeIds || []).map((id) => String(id)).filter(Boolean);
    if (!ids.length) return [];

    const query = {
        status: 'Pending',
        assignedTo: { $in: ids },
    };
    const scope = String(assetScope || '').trim().toLowerCase();
    if (scope === 'vehicle') {
        query.$or = [
            { kind: 'vehicle' },
            { kind: 'assets', assetType: 'Vehicle' },
        ];
    } else if (scope === 'tools') {
        // Tools + Utility Bill share the tools-scope feed; Vehicle stays on the vehicle bell.
        query.$or = [
            { kind: 'utility' },
            { kind: 'assets', assetType: { $ne: 'Vehicle' } },
        ];
    } else {
        if (!kinds.length) return [];
        query.kind = { $in: kinds };
    }

    const rows = await EmployeeHubRequest.find(query)
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();
    return (rows || []).map(mapHubRequestToInboxItem);
}
