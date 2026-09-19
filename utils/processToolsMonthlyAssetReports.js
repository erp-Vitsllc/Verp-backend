import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import ToolsMonthlyReportLog from '../models/ToolsMonthlyReportLog.js';
import { getCalendarPartsInTz } from './scheduleDailyAtMidnight.js';
import { getEventChannels } from './notificationEmailPermission.js';
import {
    generateEmployeeAssetListFromTemplatePdf,
    resolveAssetListPrintMeta,
} from './generateEmployeeAssetListFromTemplatePdf.js';
import {
    isToolsAssetItem,
    sendToolsMonthlyReportWhatsApp,
    TOOLS_MONTHLY_REPORT_EVENT,
} from './sendToolsAssetWhatsAppReport.js';

function monthKeyFromParts(parts) {
    return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
}

async function loadAssignedToolsByEmployee() {
    const rows = await AssetItem.find({
        assignedToType: 'Employee',
        assignedTo: { $ne: null },
        status: 'Assigned',
        acceptanceStatus: 'Accepted',
        assetId: { $regex: /^VEGA-ASSET-/i },
        $or: [{ plateNumber: { $exists: false } }, { plateNumber: null }, { plateNumber: '' }],
    })
        .select(
            'name assetId assetValue quantity status assignedDate updatedAt accessories acceptanceStatus assignedTo assignedToType typeId plateNumber',
        )
        .populate('typeId', 'name')
        .lean();

    const byEmployee = new Map();
    for (const asset of rows) {
        if (!isToolsAssetItem(asset)) continue;
        const empId = String(asset.assignedTo?._id || asset.assignedTo || '');
        if (!empId) continue;
        if (!byEmployee.has(empId)) byEmployee.set(empId, []);
        byEmployee.get(empId).push(asset);
    }
    return byEmployee;
}

/**
 * On the 1st of each month (Asia/Dubai by default), send each employee a PDF of
 * tools assets assigned to them via their profile WhatsApp number.
 */
export async function processToolsMonthlyAssetReports(now = new Date()) {
    const parts = getCalendarPartsInTz(now);
    if (parts.day !== 1) {
        return { skipped: true, reason: 'not_first_of_month' };
    }

    const channels = await getEventChannels(TOOLS_MONTHLY_REPORT_EVENT);
    if (!channels.whatsapp) {
        return { skipped: true, reason: 'permission_off' };
    }

    const monthKey = monthKeyFromParts(parts);
    const byEmployee = await loadAssignedToolsByEmployee();
    const printMeta = resolveAssetListPrintMeta({ name: 'VERP' }, now);
    const monthLabel = `${String(parts.month).padStart(2, '0')}/${parts.year}`;

    let sent = 0;
    let skipped = 0;

    for (const [employeeMongoId, assets] of byEmployee.entries()) {
        if (!assets.length) continue;

        const employee = await EmployeeBasic.findById(employeeMongoId)
            .select('firstName lastName employeeId')
            .lean();
        if (!employee?.employeeId) {
            skipped += 1;
            continue;
        }

        const already = await ToolsMonthlyReportLog.findOne({
            monthKey,
            employeeId: employee.employeeId,
        }).lean();
        if (already) {
            skipped += 1;
            continue;
        }

        const pdfBuffer = await generateEmployeeAssetListFromTemplatePdf({
            employee,
            assets,
            listTitle: `Tools monthly report ${monthLabel}`,
            ...printMeta,
        });
        if (!pdfBuffer?.length) {
            skipped += 1;
            continue;
        }

        const result = await sendToolsMonthlyReportWhatsApp({
            employee,
            pdfBuffer,
            filename: `tools-monthly-report-${employee.employeeId}-${monthKey}.pdf`,
            caption: `Tools monthly report (${monthLabel}) — ${assets.length} assigned asset${assets.length === 1 ? '' : 's'}`,
        });

        if (!result.sent) {
            skipped += 1;
            continue;
        }

        try {
            await ToolsMonthlyReportLog.create({
                monthKey,
                employeeId: employee.employeeId,
                assetCount: assets.length,
                sentAt: new Date(),
            });
        } catch (logErr) {
            if (logErr?.code !== 11000) {
                console.error('[ToolsMonthlyAssetReports] log failed:', logErr?.message || logErr);
            }
        }
        sent += 1;
    }

    console.log(`[ToolsMonthlyAssetReports] ${monthKey} sent=${sent} skipped=${skipped}`);
    return { skipped: false, monthKey, sent, skipped };
}
