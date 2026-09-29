import DashboardAction from '../../models/DashboardAction.js';
import Fine from '../../models/Fine.js';
import { purgeOrphanDashboardActionRows } from '../../utils/clearDashboardActionsForRequest.js';
import {
    backfillFineApprovalInboxForViewer,
    fineInboxIsGroup,
    fineNeedsAccountsPaymentInbox,
    fineStillNeedsApprovalInbox,
    fineStillNeedsInbox,
    identitiesMatch,
    realFineEmployeeIds,
    repairSkippedFineAccountsStage,
    resolveCurrentStageAssignee,
} from '../../utils/fineStageAuth.js';
import { openAccountsPaymentInbox } from '../../utils/fineAccountsPaymentFlow.js';
import { getDepartmentHOD } from '../../utils/getDepartmentHOD.js';
import {
    buildAssigneeClauses,
    resolveDashboardAssigneeContext,
} from '../../utils/resolveDashboardAssigneeContext.js';
import { listPendingHubInboxItems } from '../../utils/employeeHubRequestInbox.js';

const FINE_INBOX_TYPES = ['Fine', 'Group Fine Request'];

function viewerIdentity(ctx) {
    return {
        _id: ctx.employee?._id || ctx.portalUser?._id,
        employeeId: ctx.employeeIdCode || ctx.portalUser?.employeeId,
        employeeObjectId: ctx.employee?._id || ctx.portalUser?.employeeObjectId,
    };
}

function idInViewer(ctx, value) {
    const id = value?._id || value;
    if (!id) return false;
    const key = String(id);
    if ((ctx.relevantIds || []).some((item) => String(item) === key)) return true;
    return identitiesMatch(viewerIdentity(ctx), { _id: id, employeeId: value?.employeeId });
}

function fineBaseId(fineId = '') {
    const parts = String(fineId).split('-');
    if (parts.length > 3) return parts.slice(0, 3).join('-');
    return String(fineId || '');
}

/** Letter suffix marks sibling rows (-A/-B). Company on its own row is not a second person. */
async function groupBasesWithMultiplePeople(fines = []) {
    const bases = new Set();
    for (const fine of fines) {
        const fineId = String(fine?.fineId || '');
        if (/-[A-Z]$/.test(fineId)) bases.add(fineBaseId(fineId));
    }
    const grouped = new Set();
    for (const base of bases) {
        const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rows = await Fine.find({ fineId: new RegExp(`^${escaped}-[A-Z]$`) })
            .select('assignedEmployees')
            .lean();
        if (realFineEmployeeIds(rows).length > 1) grouped.add(base);
    }
    return grouped;
}

async function viewerCanActOnFineNotification(ctx, fine, accountsHod) {
    if (!fine) return false;
    const viewer = viewerIdentity(ctx);

    if (fineNeedsAccountsPaymentInbox(fine)) {
        return identitiesMatch(viewer, {
            _id: accountsHod?._id,
            employeeId: accountsHod?.employeeId,
        });
    }

    if (!fineStillNeedsApprovalInbox(fine)) return false;

    const pending = (fine.workflow || []).find((step) => step?.status === 'Pending');
    if (pending?.assignedTo && idInViewer(ctx, pending.assignedTo)) return true;

    const assignee = await resolveCurrentStageAssignee(fine);
    if (!assignee) return false;
    if (ctx.employeeIdCode && assignee.employeeId && String(assignee.employeeId) === String(ctx.employeeIdCode)) {
        return true;
    }
    return (
        idInViewer(ctx, assignee.userId) ||
        idInViewer(ctx, assignee.employeeObjectId) ||
        identitiesMatch(viewer, {
            _id: assignee.userId || assignee.employeeObjectId,
            employeeId: assignee.employeeId,
            employeeObjectId: assignee.employeeObjectId,
        })
    );
}

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

        // Repairs stay. They must not hold the Fine bell — the saved inbox is returned first.
        void (async () => {
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

        try {
            await backfillFineApprovalInboxForViewer(ctx);
        } catch (backfillErr) {
            console.error(
                '[getPendingFineDashboardInbox] Inbox backfill failed:',
                backfillErr?.message || backfillErr,
            );
        }

        try {
            const accountsHod = await getDepartmentHOD('finance');
            const viewerIsAccounts = identitiesMatch(
                {
                    _id: ctx.employee?._id || ctx.portalUser?._id,
                    employeeId: ctx.employeeIdCode || ctx.portalUser?.employeeId,
                    employeeObjectId: ctx.employee?._id || ctx.portalUser?.employeeObjectId,
                },
                { _id: accountsHod?._id, employeeId: accountsHod?.employeeId },
            );
            if (viewerIsAccounts) {
                const unsettled = await Fine.find({
                    fineStatus: { $in: ['Approved', 'Active'] },
                    $and: [
                        {
                            $or: [
                                { accountsPaymentPath: { $exists: false } },
                                { accountsPaymentPath: null },
                                { accountsPaymentPath: '' },
                            ],
                        },
                        {
                            $or: [
                                { zohoBillId: { $exists: false } },
                                { zohoBillId: null },
                                { zohoBillId: '' },
                            ],
                        },
                        {
                            $or: [
                                { zohoBillNumber: { $exists: false } },
                                { zohoBillNumber: null },
                                { zohoBillNumber: '' },
                            ],
                        },
                        { vendorBillStatus: { $ne: 'Paid' } },
                    ],
                }).limit(80);
                const seenBases = new Set();
                for (const row of unsettled) {
                    const parts = String(row.fineId || '').split('-');
                    const baseId = parts.length > 3 ? parts.slice(0, 3).join('-') : row.fineId;
                    if (seenBases.has(baseId)) continue;
                    seenBases.add(baseId);
                    await openAccountsPaymentInbox(row, [row]);
                }
            }
        } catch (payBackfillErr) {
            console.error(
                '[getPendingFineDashboardInbox] Accounts payment inbox backfill failed:',
                payBackfillErr?.message || payBackfillErr,
            );
        }
        })().catch((err) => {
            console.error('[getPendingFineDashboardInbox] background repair:', err?.message || err);
        });

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
                  .select('_id fineId fineType fineStatus assignedEmployees category workflow submittedTo accountsPaymentPath zohoBillId zohoBillNumber vendorBillStatus')
                  .lean()
            : [];
        const fineById = Object.fromEntries(fines.map((f) => [String(f._id), f]));
        const liveRows = await purgeOrphanDashboardActionRows(rows, fineById);

        const accountsHod = await getDepartmentHOD('finance');
        const idsToDismiss = [];
        const seenRequestIds = new Set();
        const actionableRows = [];
        for (const da of liveRows) {
            const fine = fineById[String(da.requestId)];
            const viewerCanAct = await viewerCanActOnFineNotification(ctx, fine, accountsHod);
            if (!fineStillNeedsInbox(fine) || !viewerCanAct) {
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
                        comment: 'Closed: fine has no pending approval or Accounts payment stage',
                    },
                },
            );
        }

        const getBaseFineId = (fid = '') => {
            const parts = String(fid).split('-');
            if (parts.length > 3) return parts.slice(0, 3).join('-');
            return fid;
        };

        const groupedBases = await groupBasesWithMultiplePeople(
            actionableRows.map((da) => fineById[String(da.requestId)]).filter(Boolean),
        );

        const items = actionableRows.map((da) => {
            const fine = fineById[String(da.requestId)];
            const isGroup =
                fineInboxIsGroup(fine) || groupedBases.has(fineBaseId(fine?.fineId));
            const employeeName = (fine?.assignedEmployees || []).find((row) => {
                const id = String(row?.employeeId || '').trim();
                return id && id !== 'VEGA-HR-0000' && id !== 'VEGA_INTERNAL';
            })?.employeeName;
            const storedName = String(da.subjectName || '').trim();
            const subjectLabel =
                (!isGroup && /^Group Fine/i.test(storedName) ? employeeName : storedName) ||
                employeeName ||
                'Fine request';

            return {
                dashboardActionId: da._id,
                requestType: isGroup ? 'Group Fine Request' : 'Fine',
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
                    accountsPaymentPath: fine.accountsPaymentPath || '',
                    zohoBillId: fine.zohoBillId || '',
                    zohoBillNumber: fine.zohoBillNumber || '',
                    vendorBillStatus: fine.vendorBillStatus || '',
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
