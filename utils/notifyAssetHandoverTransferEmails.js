import EmployeeBasic from '../models/EmployeeBasic.js';
import AssetItem from '../models/AssetItem.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendAssetAssignmentEmail } from './sendAssetAssignmentEmail.js';
import { buildAssignmentHandoverEmailAttachments } from './buildAssignmentHandoverEmailAttachments.js';

/**
 * HR / responsibility handover: same bulk-assignment handover PDF + transfer emails to
 * new assignee, asset controller, and sender (assigner).
 */
export async function notifyAssetHandoverTransferEmails({
    req,
    assetIds = [],
    asset,
    assets = [],
    assigneeEmployee,
    assignerEmployee = null,
    isBulk = false,
    assetCount = 1,
    filenameBase = 'asset-transfer-handover',
    handoverCtx = {},
    skipRecipientIds = [],
}) {
    if (!req || !asset) return { sent: 0, attachments: [] };

    const ids = [...new Set((assetIds || [asset._id]).map(String).filter(Boolean))];
    if (!ids.length) return { sent: 0, attachments: [] };

    const skip = new Set((skipRecipientIds || []).map(String).filter(Boolean));

    let attachments = [];
    try {
        attachments = await buildAssignmentHandoverEmailAttachments(req, ids, {
            assigneeName: handoverCtx.assigneeName || '—',
            employeeCode: handoverCtx.employeeCode || '—',
            department: handoverCtx.department || '—',
            hodName: handoverCtx.hodName || '—',
            assigner: handoverCtx.assigner || assignerEmployee,
            assignerName: handoverCtx.assignerName || '—',
            handoverDate: handoverCtx.handoverDate || new Date(),
            showAssigneeSignature: handoverCtx.showAssigneeSignature ?? false,
            filenameBase,
        });
    } catch (pdfErr) {
        console.error('[notifyAssetHandoverTransferEmails] Handover PDF failed (non-fatal):', pdfErr?.message || pdfErr);
    }

    const assetForEmail = asset.categoryId?.name
        ? asset
        : await AssetItem.findById(asset._id).populate('categoryId', 'name').lean();

    const assetsForTable =
        Array.isArray(assets) && assets.length > 0
            ? assets
            : assetForEmail
              ? [assetForEmail]
              : [];

    const assignee = assigneeEmployee;
    const recipients = [];

    const pushRecipient = (emp, role) => {
        if (!emp?._id) return;
        const id = String(emp._id);
        if (skip.has(id)) return;
        if (recipients.some((r) => String(r.emp._id) === id)) return;
        recipients.push({ emp, role });
    };

    if (assignee) {
        pushRecipient(assignee, 'target');
        const reportee = assignee.primaryReportee;
        if (reportee && typeof reportee === 'object' && reportee._id) {
            const hasCompany = !!(
                String(assignee.companyEmail || '').trim() || String(assignee.workEmail || '').trim()
            );
            if (!hasCompany) pushRecipient(reportee, 'target_reportee');
        }
    }

    const assetController = await getDepartmentHOD('assetcontroller');
    if (assetController) pushRecipient(assetController, 'asset_controller');

    if (assignerEmployee) pushRecipient(assignerEmployee, 'sender');

    let sent = 0;
    const count = assetCount || assetsForTable.length || 1;

    for (const { emp, role } of recipients) {
        try {
            const ok = await sendAssetAssignmentEmail({
                asset: assetForEmail || asset,
                assets: isBulk ? assetsForTable : [],
                employee: assignee,
                recipient: emp,
                isBulk: isBulk && count > 1,
                assetCount: count,
                attachments,
                notificationContext: 'transfer',
                transferRecipientRole: role === 'target_reportee' ? 'target_reportee' : role,
            });
            if (ok) sent += 1;
        } catch (mailErr) {
            console.error(
                `[notifyAssetHandoverTransferEmails] Failed for ${role} (${emp?.employeeId || emp?._id}):`,
                mailErr?.message || mailErr,
            );
        }
    }

    return { sent, attachments };
}
