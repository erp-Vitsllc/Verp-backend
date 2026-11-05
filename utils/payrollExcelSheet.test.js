import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const workbookModule = await import(new URL(
    '../../VERP_frontend/src/app/HRM/Salary/utils/payrollExcel.js',
    import.meta.url,
));

const { buildPayrollWorkbookBytes } = workbookModule;

function sheetXml(bytes) {
    return Buffer.from(bytes).toString('utf8');
}

describe('payroll excel sheet columns', () => {
    it('uses punched days, the slip loss of pay total, and zoho salary', () => {
        const bytes = buildPayrollWorkbookBytes({
            monthLabel: 'October 2026',
            employees: [{
                employeeId: 'VEGA-HR-0001',
                name: 'Sample Employee',
                companyName: 'VEGA DxB',
                basicSalary: 10000,
                otherAllowance: 5000,
                monthlySalary: 15000,
                presentDays: 20,
                sheetPresentDays: 26,
                lossOfPay: 2000,
                sheetLossOfPay: 1209.68,
                grossSalary: 15000,
                zohoSalary: 13790.32,
                ot: 0,
                rewardAdditions: 0,
                fineAmount: 0,
                advanceAmount: 0,
                loanAmount: 0,
                sheetOtherDeduction: 2150.16,
                actualSalary: 11640.16,
            }],
        });
        const xml = sheetXml(bytes);
        assert.match(xml, /<c r="H4"[^>]*><v>26<\/v><\/c>/);
        assert.match(xml, /<c r="I4"[^>]*><v>1209\.68<\/v><\/c>/);
        assert.match(xml, /<c r="L4"[^>]*><v>13790\.32<\/v><\/c>/);
        assert.doesNotMatch(xml, /<c r="H4"[^>]*><v>20<\/v><\/c>/);
        assert.doesNotMatch(xml, /<c r="I4"[^>]*><v>2000<\/v><\/c>/);
        assert.doesNotMatch(xml, /<c r="L4"[^>]*><v>15000<\/v><\/c>/);
    });
});
