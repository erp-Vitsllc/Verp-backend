import EmployeeBasic from '../models/EmployeeBasic.js';
import { buildFineFormSummary } from './buildFineFormSummary.js';
import { isLossDamageFineType } from './buildAssetLossFineEmailFields.js';
import { isAssetLossFineReportApplicable } from './sendAssetLossFineReportEmail.js';
import { loadFineRecordForAssetLossPdf } from './loadFineRecordForAssetLossPdf.js';
import { generateAssetLossFineReportPdf } from './generateAssetLossFineReportPdf.js';
import { generateFineApprovedPdf } from './generateFineApprovedPdf.js';

async function resolveStakeholders(targetEmployeeId) {
    const { getDepartmentHOD } = await import('./getDepartmentHOD.js');
    const { getManagementHOD } = await import('./getManagementHOD.js');

    const hrHOD = await getDepartmentHOD('hr', targetEmployeeId);
    const accountsHOD = await getDepartmentHOD('finance', targetEmployeeId);
    const managementHOD = await getManagementHOD(targetEmployeeId);

    return {
        hrHOD,
        accountsHOD,
        hrHODName: hrHOD ? `${hrHOD.firstName || ''} ${hrHOD.lastName || ''}`.trim() : '',
        accountsHODName: accountsHOD ? `${accountsHOD.firstName || ''} ${accountsHOD.lastName || ''}`.trim() : '',
        ceoName: managementHOD ? `${managementHOD.firstName || ''} ${managementHOD.lastName || ''}`.trim() : '',
    };
}

function pickAssignedEmployee(fine, employeeId) {
    const list = fine?.assignedEmployees || [];
    if (employeeId) {
        const match = list.find((e) => e.employeeId === employeeId);
        if (match) return match;
    }
    return list.find((e) => e.employeeId && e.employeeId !== 'VEGA-HR-0000') || list[0] || null;
}

/**
 * Same PDF pipeline used when management approves a fine (email attachment).
 */
export async function generateFineApprovedReportPdfBuffer(fine, { employeeId } = {}) {
    if (!fine) return null;

    const assigned = pickAssignedEmployee(fine, employeeId);
    if (!assigned?.employeeId) return null;

    const targetEmpId = assigned.employeeId;
    const stakeholders = await resolveStakeholders(targetEmpId);
    const fineForPdf = await loadFineRecordForAssetLossPdf(fine, targetEmpId);

    const formSummary = await buildFineFormSummary(fineForPdf, {
        employeeId: targetEmpId,
        hrHODName: stakeholders.hrHODName,
        accountsHODName: stakeholders.accountsHODName,
        ceoName: stakeholders.ceoName,
    });

    const empDetails = await EmployeeBasic.findOne({ employeeId: targetEmpId })
        .select('employeeId firstName lastName primaryReportee')
        .populate('primaryReportee', 'firstName lastName')
        .lean();

    const displayEmployeeName =
        `${empDetails?.firstName || ''} ${empDetails?.lastName || ''}`.trim() ||
        assigned.employeeName ||
        'Employee';

    const hodName =
        formSummary?.employeeStats?.hodName ||
        (empDetails?.primaryReportee
            ? `${empDetails.primaryReportee.firstName || ''} ${empDetails.primaryReportee.lastName || ''}`.trim()
            : 'Manager');

    if (isAssetLossFineReportApplicable(fineForPdf)) {
        return generateAssetLossFineReportPdf({
            fine: fineForPdf,
            assigned,
            formSummary,
            employeeName: displayEmployeeName,
            hodName,
            hrEmployee: stakeholders.hrHOD,
            accountsEmployee: stakeholders.accountsHOD,
        });
    }

    if (isLossDamageFineType(fineForPdf)) {
        return generateFineApprovedPdf({
            fine: fineForPdf,
            assigned,
            formSummary,
            employeeName: displayEmployeeName,
            hodName,
            hrEmployee: stakeholders.hrHOD,
            accountsEmployee: stakeholders.accountsHOD,
        });
    }

    return null;
}
