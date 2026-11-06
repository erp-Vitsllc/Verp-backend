import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildAccountsPayrollApprovedEmailHtml,
    buildSlotAccountsEmailHtml,
    buildSlotHrApprovalEmailHtml,
    buildPayrollApprovalEmailHtml,
    formatPayrollHours,
    payrollApprovalRow,
    payrollApprovalSubject,
    payrollMonthLabel,
    summarizePayrollApproval,
} from './payrollApprovalMail.js';

function row(company, figures) {
    return payrollApprovalRow(figures, company);
}

describe('payroll approval email', () => {
    const rows = [
        row('VEGA DxB', {
            zohoSalary: 1000,
            fineAmount: 10,
            advanceAmount: 5,
            loanAmount: 0,
            sheetOtherDeduction: 5,
            overtimeHours: 2,
            ot: 40,
            rewardAdditions: 15,
            actualSalary: 980,
        }),
        row('NNIT', {
            zohoSalary: 500,
            fineAmount: 0,
            advanceAmount: 0,
            loanAmount: 20,
            sheetOtherDeduction: 0,
            overtimeHours: 1.5,
            ot: 25,
            rewardAdditions: 0,
            actualSalary: 480,
        }),
        row('NNIT', {
            zohoSalary: 200,
            fineAmount: 0,
            advanceAmount: 0,
            loanAmount: 0,
            sheetOtherDeduction: 0,
            overtimeHours: 0,
            ot: 0,
            rewardAdditions: 10,
            actualSalary: 200,
        }),
    ];
    const summary = summarizePayrollApproval(rows);

    it('uses the salary month label and the Excel totals', () => {
        assert.equal(payrollMonthLabel('2026-10'), 'October 2026');
        assert.equal(summary.employeeCount, 3);
        assert.equal(summary.companyCount, 2);
        assert.equal(summary.gross, 1700);
        assert.equal(summary.deductions, 40);
        assert.equal(summary.overtimeHours, 3.5);
        assert.equal(summary.otAmount, 65);
        assert.equal(summary.otherEarnings, 25);
        assert.equal(summary.net, 1660);
        const nnit = summary.companies.find((company) => company.companyName === 'NNIT');
        const vega = summary.companies.find((company) => company.companyName === 'VEGA DxB');
        assert.equal(nnit.employees, 2);
        assert.equal(nnit.net, 680);
        assert.equal(vega.gross, 1000);
        assert.equal(
            summary.companies.reduce((sum, company) => sum + company.net, 0),
            summary.net,
        );
        assert.equal(formatPayrollHours(3.5), '3.5 hours');
    });

    it('builds one HR summary email with approve and reject links', () => {
        const html = buildPayrollApprovalEmailHtml({
            stage: 'HR',
            monthKey: '2026-10',
            monthLabel: 'October 2026',
            summary,
            baseUrl: 'https://testverp.cloud',
        });
        assert.equal(
            payrollApprovalSubject('HR', 'October 2026'),
            'Payroll Approval Request – October 2026 – Pending HR Approval',
        );
        assert.match(html, /Dear HR Team/);
        assert.match(html, /Accounts Department has completed payroll checking/);
        assert.match(html, /Pending HR Approval/);
        assert.match(html, /NNIT/);
        assert.match(html, /VEGA DxB/);
        assert.match(html, /Grand Total/);
        assert.match(html, /AED 1,700.00/);
        assert.match(html, /AED 1,660.00/);
        assert.match(html, /https:\/\/testverp\.cloud\/HRM\/Salary\/2026-10\?payrollStage=hr&amp;payrollAction=approve/);
        assert.match(html, /payrollStage=hr&amp;payrollAction=reject/);
        assert.match(html, /APPROVE PAYROLL/);
        assert.match(html, /REJECT PAYROLL/);
        assert.doesNotMatch(html, /HR Approved By/);
        assert.doesNotMatch(html, /is waiting for HR approval/);
    });

    it('builds the Management email only after HR approval details are included', () => {
        const html = buildPayrollApprovalEmailHtml({
            stage: 'MANAGEMENT',
            monthKey: '2026-10',
            monthLabel: 'October 2026',
            summary,
            hrApproverName: 'Hana User',
            hrApprovedAt: '6 Nov 2026, 11:44 am',
            baseUrl: 'https://testverp.cloud',
        });
        assert.equal(
            payrollApprovalSubject('MANAGEMENT', 'October 2026'),
            'Payroll Approval Request – October 2026 – Pending Management Approval',
        );
        assert.match(html, /Dear Management/);
        assert.match(html, /approved by HR/);
        assert.match(html, /HR Approved By/);
        assert.match(html, /Hana User/);
        assert.match(html, /6 Nov 2026, 11:44 am/);
        assert.match(html, /payrollStage=management&amp;payrollAction=approve/);
        assert.match(html, /payrollStage=management&amp;payrollAction=reject/);
        assert.doesNotMatch(html, /Dear HR Team/);
        assert.doesNotMatch(html, /is waiting for Management approval/);
    });

    it('tells Accounts that Management submitted the payroll', () => {
        const html = buildAccountsPayrollApprovedEmailHtml({ monthLabel: 'October 2026' });
        assert.match(html, /Dear Accounts Team/);
        assert.match(html, /The Management Department has completed payroll checking for <strong>October 2026<\/strong> and submitted the payroll\./);
        assert.match(html, /Please find the payroll attachment below\./);
        assert.doesNotMatch(html, /Create slot is now/);
        assert.doesNotMatch(html, /Hello Accounts/);
    });

    it('replaces the slot email to HR with the approval notice only', () => {
        const html = buildSlotHrApprovalEmailHtml({ slotNo: 1, monthKey: '2026-10' });
        assert.match(html, /Dear HR Team/);
        assert.match(html, /Payroll Processing – Request for HR Approval/);
        assert.match(html, /<strong>Salary Slot 1 for October 2026<\/strong>/);
        assert.match(html, /submitted by the Accounts Department/);
        assert.match(html, /Kindly review the payroll details, verify the relevant salary calculations\./);
        assert.match(html, /VERP HRM – Automated Payroll Management System/);
        assert.match(html, /VEGA Digital IT Solutions LLC/);
        assert.match(html, /Please do not reply to this email/);
        assert.doesNotMatch(html, /Hello HR/);
        assert.doesNotMatch(html, /Open the payroll/);
        assert.doesNotMatch(html, /pending with HR/);
    });

    it('sends Accounts a formal WPS or cash notice for the slot file', () => {
        const wps = buildSlotAccountsEmailHtml({
            slotNo: 1,
            monthKey: '2026-10',
            method: 'WPS',
            attached: true,
            payrollUrl: 'https://testverp.cloud/HRM/Salary/2026-10',
        });
        const cash = buildSlotAccountsEmailHtml({
            slotNo: 2,
            monthLabel: 'October 2026',
            method: 'CASH',
            attached: true,
            payrollUrl: 'https://testverp.cloud/HRM/Salary/2026-10',
        });
        assert.match(wps, /Dear Accounts Team/);
        assert.match(wps, /Payroll Processing – WPS File/);
        assert.match(wps, /Salary Slot 1 for October 2026/);
        assert.match(wps, /Here is the attachment to update your WPS and proceed in VERP for the further process\./);
        assert.match(wps, /href="https:\/\/testverp\.cloud\/HRM\/Salary\/2026-10"/);
        assert.match(wps, /Open the payroll details/);
        assert.doesNotMatch(wps, /Hello Accounts/);
        assert.match(cash, /Payroll Processing – Cash Salary/);
        assert.match(cash, /Salary Slot 2 for October 2026/);
        assert.match(cash, /cash salary workbook for the employees in this slot is attached/);
        assert.match(cash, /Update payment/);
        assert.doesNotMatch(cash, /update your WPS/);
        assert.doesNotMatch(cash, /Open the payroll details/);
    });
});
