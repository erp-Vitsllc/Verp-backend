import EmployeeBasic from '../models/EmployeeBasic.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { sendAssetAssignmentEmail } from './sendAssetAssignmentEmail.js';
import {
    buildAssignmentHandoverEmailAttachments,
    hodDisplayFromEmployee,
} from './buildAssignmentHandoverEmailAttachments.js';

/**
 * Notify target assignee, asset controller, and transfer sender with the same handover PDF
 * used for bulk asset assignment emails (no changes to bulk assign flow).
 */
export async function sendAssetTransferHandoverEmails({
    req,
    asset,
    assetIds,
    targetEmployee,
    senderEmployeeId,
    /** When transferring to company coordinator flow, optional company display */
    targetCompany = null,
    assignedToType = 'Employee',
    companyCoordinator = null,
    skipRecipientIds = [],
}) {
    if (!asset || !req) return { sent: 0, attachments: [] };

    const ids = [...new Set((assetIds || [asset._id]).map(String).filter(Boolean))];
    if (!ids.length) return { sent: 0, attachments: [] };

    const skip = new Set((skipRecipientIds || []).map(String).filter(Boolean));

    const sender = senderEmployeeId
        ? await EmployeeBasic.findById(senderEmployeeId)
            .select('firstName lastName employeeId signature department companyEmail workEmail email')
            .lean()
            .catch(() => null)
        : null;

    let targetFull = targetEmployee;
    if (targetEmployee && (targetEmployee._id || targetEmployee.employeeId) && !targetEmployee.department) {
        targetFull = await EmployeeBasic.findById(targetEmployee._id || targetEmployee)
            .select('firstName lastName employeeId department primaryReportee companyEmail workEmail email')
            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail')
            .lean()
            .catch(() => targetEmployee);
    }

    const assigneeName =
        assignedToType === 'Company' && targetCompany
            ? targetCompany.name || 'Company'
            : `${targetFull?.firstName || ''} ${targetFull?.lastName || ''}`.trim() || 'Employee';
    const employeeCode =
        assignedToType === 'Company' && targetCompany
            ? targetCompany.companyId || '—'
            : targetFull?.employeeId || '—';

    let attachments = [];
    try {
        attachments = await buildAssignmentHandoverEmailAttachments(req, ids, {
            assigneeName,
            employeeCode,
            department:
                assignedToType === 'Company'
                    ? '—'
                    : (targetFull?.department && String(targetFull.department).trim()) || '—',
            hodName: assignedToType === 'Company' ? '—' : hodDisplayFromEmployee(targetFull),
            assigner: sender,
            assignerName: sender
                ? `${sender.firstName || ''} ${sender.lastName || ''}`.trim()
                : '—',
            filenameBase: 'asset-transfer-handover',
        });
    } catch (pdfErr) {
        console.error('[sendAssetTransferHandoverEmails] Handover PDF failed (non-fatal):', pdfErr?.message || pdfErr);
    }

    const assetForEmail = asset.categoryId?.name
        ? asset
        : await (async () => {
              const AssetItem = (await import('../models/AssetItem.js')).default;
              return AssetItem.findById(asset._id).populate('categoryId', 'name').lean();
          })();

    const employeeForTemplate =
        assignedToType === 'Company' && targetCompany
            ? { firstName: targetCompany.name || 'Company', lastName: '', isCompany: true }
            : targetFull;

    const recipients = [];

    const pushRecipient = (emp, role) => {
        if (!emp?._id) return;
        const id = String(emp._id);
        if (skip.has(id)) return;
        if (recipients.some((r) => String(r.emp._id) === id)) return;
        recipients.push({ emp, role });
    };

    if (targetFull && assignedToType === 'Employee') {
        pushRecipient(targetFull, 'target');
        const reportee = targetFull.primaryReportee;
        if (reportee && typeof reportee === 'object' && reportee._id) {
            const hasCompany = !!(String(targetFull.companyEmail || '').trim() || String(targetFull.workEmail || '').trim());
            if (!hasCompany) pushRecipient(reportee, 'target_reportee');
        }
    }

    const assetController = await getDepartmentHOD('assetcontroller');
    if (assetController) pushRecipient(assetController, 'asset_controller');

    if (companyCoordinator) pushRecipient(companyCoordinator, 'asset_controller');

    if (sender) pushRecipient(sender, 'sender');

    let sent = 0;
    for (const { emp, role } of recipients) {
        try {
            const ok = await sendAssetAssignmentEmail({
                asset: assetForEmail || asset,
                employee: employeeForTemplate,
                recipient: emp,
                attachments,
                notificationContext: 'transfer',
                transferRecipientRole: role === 'target_reportee' ? 'target_reportee' : role,
            });
            if (ok) sent += 1;
        } catch (mailErr) {
            console.error(
                `[sendAssetTransferHandoverEmails] Failed for ${role} (${emp?.employeeId || emp?._id}):`,
                mailErr?.message || mailErr,
            );
        }
    }

    return { sent, attachments };
}
