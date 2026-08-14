import EmployeeHubRequest from '../models/EmployeeHubRequest.js';
import {
    HUB_DASHBOARD_TYPE,
    HUB_KIND_LABEL,
} from './employeeHubRequestTypes.js';

function extra3For(row) {
    return JSON.stringify({
        hubRequest: true,
        kind: row.kind,
        requesterMongoId: String(row.requester || ''),
    });
}

export function mapHubRequestToInboxItem(row) {
    const id = String(row._id);
    const type = HUB_DASHBOARD_TYPE[row.kind] || 'Employee Leave Request';
    const label = HUB_KIND_LABEL[row.kind] || 'Request';
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
            loanId: `HUB-ADV-${id.slice(-6)}`,
            type: 'Advance',
            amount: 0,
            status: 'Pending',
            approvalStatus: 'Pending',
        },
    };
}

export async function listPendingHubInboxItems({ assigneeIds = [], kinds = [] } = {}) {
    const ids = (assigneeIds || []).map((id) => String(id)).filter(Boolean);
    if (!ids.length || !kinds.length) return [];
    const rows = await EmployeeHubRequest.find({
        status: 'Pending',
        kind: { $in: kinds },
        assignedTo: { $in: ids },
    })
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();
    return (rows || []).map(mapHubRequestToInboxItem);
}
