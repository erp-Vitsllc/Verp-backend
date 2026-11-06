import EmployeeBasic from '../models/EmployeeBasic.js';
import SalaryEnrollment from '../models/SalaryEnrollment.js';
import { REAL_EMPLOYEE_MONGO_FILTER, isCompanyShellEmployee } from './attendanceEmployeeFilters.js';
import { isPlaceholderEmployeeId } from './employeeIdPrefix.js';
import { collectSalarySlipPayrollFigures } from './buildSalarySlipPayload.js';
import { enrollmentCoversSalaryMonth } from './salaryEnrollmentStartMonth.js';
import { getScheduledEmailTimeZone, getZonedParts } from './scheduleDailyAtMidnight.js';
import { payrollApprovalRow } from './payrollApprovalMail.js';

function toYearMonth(value) {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}` : '';
}

function personKey(value) {
    return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function currentSalaryYearMonth() {
    const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
    return `${dubai.year}-${String(dubai.month).padStart(2, '0')}`;
}

function activePayrollEmployee(emp) {
    if (!emp) return false;
    if (String(emp.status || '') === 'Left User') return false;
    return String(emp.profileStatus || '').trim().toLowerCase() === 'active';
}

function employeeWorkedInMonth(emp, ym) {
    const join = toYearMonth(emp?.dateOfJoining);
    if (join && join > ym) return false;
    if (String(emp?.status || '') === 'Left User') {
        if (ym >= currentSalaryYearMonth()) return false;
        const exit = toYearMonth(emp?.noticeRequest?.exitDate);
        if (exit && exit < ym) return false;
    }
    return true;
}

function companyNameOf(company) {
    if (!company || typeof company !== 'object') return 'Unassigned';
    return String(company.nickName || company.name || '').trim() || 'Unassigned';
}

/** Employees on the payroll sheet for this month, with the Excel gross, deduction, OT, and net fields. */
async function loadPayrollMonthRows(monthKey) {
    const key = toYearMonth(monthKey);
    if (!key) return [];
    const enrollments = await SalaryEnrollment.find({})
        .select('employeeId fromMonth salaryDate processDate')
        .lean();
    const ids = [...new Set(
        (enrollments || [])
            .filter((row) => enrollmentCoversSalaryMonth(row, key))
            .map((row) => String(row.employeeId || '').trim())
            .filter((id) => id && !isPlaceholderEmployeeId(id)),
    )];
    if (!ids.length) return [];
    const people = await EmployeeBasic.find({ employeeId: { $in: ids }, ...REAL_EMPLOYEE_MONGO_FILTER })
        .select('employeeId firstName lastName status profileStatus dateOfJoining noticeRequest.exitDate company')
        .populate('company', 'name nickName')
        .lean();
    const enrolled = (people || []).filter((emp) => (
        emp && !isCompanyShellEmployee(emp) && activePayrollEmployee(emp) && employeeWorkedInMonth(emp, key)
    ));
    const figures = await collectSalarySlipPayrollFigures(
        enrolled.map((emp) => emp.employeeId),
        key,
    );
    return enrolled.map((emp) => {
        const code = String(emp.employeeId || '').trim();
        const slip = figures.get(personKey(code)) || {};
        const companyName = companyNameOf(emp.company);
        const name = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || code;
        return {
            approval: payrollApprovalRow(slip, companyName),
            sheet: {
                employeeId: code,
                name,
                companyName,
                basicSalary: slip.basicSalary,
                otherAllowance: slip.otherAllowance,
                monthlySalary: slip.monthlySalary,
                presentDays: slip.presentDays,
                sheetPresentDays: slip.sheetPresentDays,
                lossOfPay: slip.lossOfPay,
                sheetLossOfPay: slip.sheetLossOfPay,
                ot: slip.ot,
                extra: slip.extra,
                rewardAdditions: slip.rewardAdditions,
                zohoSalary: slip.zohoSalary,
                grossSalary: slip.grossSalary,
                fineAmount: slip.fineAmount,
                advanceAmount: slip.advanceAmount,
                loanAmount: slip.loanAmount,
                sheetOtherDeduction: slip.sheetOtherDeduction,
                otherDeduction: slip.otherDeduction,
                actualSalary: slip.actualSalary,
            },
        };
    });
}

export async function loadPayrollApprovalRows(monthKey) {
    const rows = await loadPayrollMonthRows(monthKey);
    return rows.map((row) => row.approval);
}

/** Same rows the payroll page uses for Download Excel. */
export async function loadPayrollSheetEmployees(monthKey) {
    const rows = await loadPayrollMonthRows(monthKey);
    return rows.map((row) => row.sheet);
}
