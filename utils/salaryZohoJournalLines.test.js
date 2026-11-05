import assert from 'node:assert/strict';
import test from 'node:test';
import { salarySlipZohoPay } from './buildSalarySlipPayload.js';
import {
    assignSalaryJournalAccounts,
    buildSalaryZohoLines,
    groupSalaryZohoJournals,
} from './salaryZohoJournalLines.js';

test('zoho salary is monthly earnings plus annual leave and ticket, minus loss of pay', () => {
    const amount = salarySlipZohoPay({
        earnings: [
            { component: 'Basic Salary', amount: 1000 },
            { component: 'Other Allowance', amount: 200 },
            { component: 'Overtime Hours', amount: 50 },
        ],
        yearlyEarnings: [
            { component: 'Leave Salary', amount: 80 },
            { component: 'Travel Allowance', amount: 20 },
        ],
        deductions: [
            { component: 'Authorized Leave', amount: 30 },
            { component: 'Loan', amount: 400 },
        ],
        summary: { leaveSalary: { amount: 80 }, airTicket: { amount: 20 } },
    });
    assert.equal(amount, 1320);
});

test('same category is one debit and each employee is a credit', () => {
    const lines = buildSalaryZohoLines([
        {
            employeeId: 'A',
            name: 'Asha',
            zohoAccountId: 'emp-a',
            zohoAccountName: 'Asha payable',
            zohoCategoryAccountId: 'cat-staff',
            zohoCategoryAccountName: 'Staff cost',
            zohoSalary: 100,
        },
        {
            employeeId: 'B',
            name: 'Bala',
            zohoAccountId: 'emp-b',
            zohoAccountName: 'Bala payable',
            zohoCategoryAccountId: 'cat-staff',
            zohoCategoryAccountName: 'Staff cost',
            zohoSalary: 40.5,
        },
        {
            employeeId: 'C',
            name: 'Zero',
            zohoAccountId: 'emp-c',
            zohoCategoryAccountId: 'cat-staff',
            zohoCategoryAccountName: 'Staff cost',
            zohoSalary: 0,
        },
    ]);

    const debits = lines.filter((line) => line.kind === 'category');
    const credits = lines.filter((line) => line.kind === 'employee');
    assert.equal(debits.length, 1);
    assert.equal(debits[0].accountId, 'cat-staff');
    assert.equal(debits[0].debit, '140.50');
    assert.equal(debits[0].credit, '');
    assert.deepEqual(credits.map((line) => line.accountId), ['emp-a', 'emp-b']);
    assert.deepEqual(credits.map((line) => line.credit), ['100.00', '40.50']);
    assert.equal(credits[0].description, '');
    assert.equal(debits[0].description, '');
    assert.equal(credits[0].personName, 'Asha');
});

test('every description is the payroll note, without the employee name', () => {
    const lines = buildSalaryZohoLines([
        {
            employeeId: 'A',
            name: 'Raseel Muhammad',
            zohoAccountId: 'emp-a',
            zohoAccountName: 'Raseel Muhammad',
            zohoCategoryAccountName: 'No category',
            zohoSalary: 10,
        },
    ], { note: 'Salary payroll October 2026' });
    assert.equal(lines.every((line) => line.description === 'Salary payroll October 2026'), true);
    assert.equal(lines.some((line) => line.description.includes('Raseel')), false);
});

test('blank accounts are filled from the chart of accounts name', () => {
    const lines = assignSalaryJournalAccounts([
        {
            kind: 'category',
            accountId: '',
            accountName: 'Staff cost',
            categoryName: 'Staff cost',
        },
        {
            kind: 'employee',
            accountId: '',
            accountName: '',
            personName: 'Raseel Muhammad',
        },
        {
            kind: 'employee',
            accountId: 'kept',
            accountName: 'Already chosen',
            personName: 'Other Person',
        },
    ], [
        { account_id: 'cat-1', account_name: 'Staff cost' },
        { account_id: 'emp-1', account_name: 'Raseel Muhammad - Salary' },
        { account_id: 'other', account_name: 'Other Person' },
    ]);
    assert.equal(lines[0].accountId, 'cat-1');
    assert.equal(lines[1].accountId, 'emp-1');
    assert.equal(lines[2].accountId, 'kept');
});

test('employees land on the Zoho company linked to their company', () => {
    const journals = groupSalaryZohoJournals({
        organizations: [
            { organizationId: 'vega-org', name: 'VEGADIGITAL IT SOLUTIONS LLC', brand: 'VEGA' },
            { organizationId: 'nnit-org', name: 'NEURON NEXUS INFORMATION TECHNOLOGY L.L.C', brand: 'NNIT' },
        ],
        employees: [
            {
                employeeId: 'V1',
                name: 'Vega Person',
                zohoSalary: 10,
                zohoAccountId: 'v-acc',
                zohoCategoryAccountId: 'v-cat',
                zohoCategoryAccountName: 'Vega salaries',
                company: { nickName: 'VEGA DxB', name: 'Vega Dubai' },
            },
            {
                employeeId: 'N1',
                name: 'Nnit Person',
                zohoSalary: 20,
                zohoAccountId: 'n-acc',
                zohoCategoryAccountId: 'n-cat',
                zohoCategoryAccountName: 'NNIT salaries',
                company: { nickName: 'NNT', zohoOrganizationId: 'nnit-org' },
            },
        ],
    });

    assert.deepEqual(journals.map((org) => org.label), ['Vega Digital', 'Neuron Nexus']);
    assert.equal(journals[0].lines.some((line) => line.personName === 'Vega Person'), true);
    assert.equal(journals[1].lines.some((line) => line.personName === 'Nnit Person'), true);
    assert.equal(journals[0].lines.some((line) => line.personName === 'Nnit Person'), false);
});
