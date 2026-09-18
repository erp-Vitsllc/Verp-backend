import DashboardAction from '../../models/DashboardAction.js';
import Fine from '../../models/Fine.js';
import { purgeOrphanDashboardActionRows } from '../../utils/clearDashboardActionsForRequest.js';
import {
    fineStillNeedsApprovalInbox,
    getExpectedRoleForFineStatus,
    getPendingWorkflowStep,
    repairSkippedFineAccountsStage,
} from '../../utils/fineStageAuth.js';
import { syncDashboardAction } from '../../utils/syncDashboard.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import {
    buildAssigneeClauses,
    resolveDashboardAssigneeContext,
} from '../../utils/resolveDashboardAssigneeContext.js';
import { listPendingHubInboxItems } from '../../utils/employeeHubRequestInbox.js';

const FINE_INBOX_TYPES = ['Fine', 'Group Fine Request'];

/**
 * Pending fine dashboard actions for the logged-in user, or for ?targetUserId= (team view).
 * @route GET /api/Fine/dashboard/pending-inbox
 */
export const getPendingFineDashboardInbox = async (req, res) => {
    try {
        const ctx = await resolveDashboardAssigneeContext(req);
        if (!ctx.ok) {
            return res.status(ctx.status || 401).json({ message: ctx.message || 'Unauthorized' });
        }

        const assigneeClauses = buildAssigneeClauses(ctx.relevantIds, ctx.employeeIdCode);

        const skippedAccounts = await Fine.find({
            fineStatus: { $in: ['Pending Authorization', 'Pending Management'] },
        })
            .select('_id fineId fineStatus workflow hrApprovedBy accountsApprovedBy assignedEmployees')
            .limit(80);

        const repairedBases = new Set();
        for (const row of skippedAccounts) {
            const parts = String(row.fineId || '').split('-');
            const baseId = parts.length > 3 ? parts.slice(0, 3).join('-') : row.fineId;
            if (repairedBases.has(baseId)) continue;
            repairedBases.add(baseId);
            try {
                await repairSkippedFineAccountsStage(row);
            } catch (repairErr) {
                console.error(
                    '[getPendingFineDashboardInbox] Accounts-stage repair failed:',
                    row.fineId,
                    repairErr?.message || repairErr,
                );
            }
        }

        const pendingStatuses = [
            'Pending',
            'Pending HR',
            'Pending Review',
            'Pending Accounts',
            'Pending Finance',
            'Pending Authorization',
            'Pending Management',
        ];
        if (ctx.relevantIds?.length) {
            const workflowAssigned = await Fine.find({
                fineStatus: { $in: pendingStatuses },
                workflow: {
                    $elemMatch: {
                        status: 'Pending',
                        assignedTo: { $in: ctx.relevantIds },
                    },
                },
            }).limit(100);

            for (const fine of workflowAssigned) {
                if (!fineStillNeedsApprovalInbox(fine)) continue;
                const expectedRole = getExpectedRoleForFineStatus(fine.fineStatus, fine.workflow || []);
                const pendingStep = getPendingWorkflowStep(fine.workflow, expectedRole);
                if (!pendingStep?.assignedTo) continue;
                try {
                    const targetEmp = fine.assignedEmployees?.find(
                        (e) => e.employeeId && e.employeeId !== 'VEGA-HR-0000',
                    ) || fine.assignedEmployees?.[0];
                    const subjectEmp = targetEmp?.employeeId
                        ? await EmployeeBasic.findOne({ employeeId: targetEmp.employeeId })
                        : null;
                    await syncDashboardAction({
                        requestId: fine._id,
                        requestType: 'Fine',
                        assignedTo: pendingStep.assignedTo,
                        status: 'Pending',
                        subjectEmployee: subjectEmp,
                        extra1: fine.fineType,
                        extra2: `AED ${fine.fineAmount || 0}`,
                    });
                } catch (backfillErr) {
                    console.error(
                        '[getPendingFineDashboardInbox] Inbox backfill failed:',
                        fine.fineId,
                        backfillErr?.message || backfillErr,
                    );
                }
            }
        }

        if (assigneeClauses.length === 0) {
            const hubItems = await listPendingHubInboxItems({
                assigneeIds: ctx.relevantIds,
                kinds: ['fine'],
            });
            return res.json({ count: hubItems.length, items: hubItems });
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
                  .select('_id fineId fineType fineStatus assignedEmployees category workflow')
                  .lean()
            : [];
        const fineById = Object.fromEntries(fines.map((f) => [String(f._id), f]));
        const liveRows = await purgeOrphanDashboardActionRows(rows, fineById);

        const idsToDismiss = [];
        const seenRequestIds = new Set();
        const actionableRows = [];
        for (const da of liveRows) {
            const fine = fineById[String(da.requestId)];
            if (!fineStillNeedsApprovalInbox(fine)) {
                if (da._id) idsToDismiss.push(da._id);
                continue;
            }
            const requestKey = String(da.requestId);
            if (seenRequestIds.has(requestKey)) {
                if (da._id) idsToDismiss.push(da._id);
                continue;
            }
            seenRequestIds.add(requestKey);
            actionableRows.push(da);
        }

        if (idsToDismiss.length) {
            await DashboardAction.updateMany(
                { _id: { $in: idsToDismiss }, status: 'Pending' },
                {
                    $set: {
                        status: 'Dismissed',
                        actionedDate: new Date(),
                        comment: 'Closed: fine has no pending approval stage',
                    },
                },
            );
        }

        const getBaseFineId = (fid = '') => {
            const parts = String(fid).split('-');
            if (parts.length > 3) return parts.slice(0, 3).join('-');
            return fid;
        };

        const items = actionableRows.map((da) => {
            const fine = fineById[String(da.requestId)];
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
                fine: {
                    _id: fine._id,
                    fineId: fine.fineId,
                    baseFineId: getBaseFineId(fine.fineId),
                    fineType: fine.fineType,
                    fineStatus: fine.fineStatus,
                },
            };
        });

        const hubItems = await listPendingHubInboxItems({
            assigneeIds: ctx.relevantIds,
            kinds: ['fine'],
        });

        const merged = [...hubItems, ...items];
        res.json({ count: merged.length, items: merged });
    } catch (error) {
        console.error('getPendingFineDashboardInbox:', error);
        res.status(500).json({ message: 'Failed to load fine notifications' });
    }
};
