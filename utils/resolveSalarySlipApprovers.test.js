import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { salarySlipApprovalRows } from './resolveSalarySlipApprovers.js';

describe('salary slip approval rows', () => {
    const steps = [
        {
            key: 'accounts',
            status: 'approved',
            actionedAt: '2026-11-02T08:00:00.000Z',
            actionedByName: 'Accounts User',
        },
        {
            key: 'hr',
            status: 'approved',
            actionedAt: '2026-11-03T08:00:00.000Z',
            actionedByName: 'HR User',
        },
        {
            key: 'management',
            status: 'approved',
            actionedAt: '2026-11-04T08:00:00.000Z',
            actionedByName: 'General Manager',
        },
    ];

    it('fills each approver from their own step and the employee from management approval', () => {
        const rows = salarySlipApprovalRows({
            steps,
            processed: true,
            people: {
                accounts: { name: 'Amina Accounts', signatureUrl: 'data:image/png;base64,acc' },
                hr: { name: 'Hana HR', signatureUrl: 'data:image/png;base64,hr' },
                management: { name: 'Karim GM', signatureUrl: 'data:image/png;base64,gm' },
                employee: { name: 'Raseel Muhammad', signatureUrl: 'data:image/png;base64,emp' },
            },
        });

        assert.equal(rows[0].title, 'Payroll Officer');
        assert.equal(rows[0].name, 'Amina Accounts');
        assert.equal(rows[0].signatureUrl, 'data:image/png;base64,acc');
        assert.match(rows[0].date, /2026/);

        assert.equal(rows[1].title, 'HR Manager');
        assert.equal(rows[1].name, 'Hana HR');
        assert.notEqual(rows[1].date, rows[0].date);

        assert.equal(rows[2].title, 'General Manager');
        assert.equal(rows[2].name, 'Karim GM');

        assert.equal(rows[3].title, 'Employee');
        assert.equal(rows[3].name, 'Raseel Muhammad');
        assert.equal(rows[3].date, rows[2].date);
        assert.equal(rows[3].signatureUrl, 'data:image/png;base64,emp');
    });

    it('leaves a step blank until that person has approved', () => {
        const rows = salarySlipApprovalRows({
            steps: [{ key: 'accounts', status: 'approved', actionedAt: '2026-11-02T08:00:00.000Z' }],
            processed: false,
            people: { accounts: { name: 'Amina Accounts', signatureUrl: 'sig' } },
        });
        assert.equal(rows[0].name, 'Amina Accounts');
        assert.equal(rows[1].name, undefined);
        assert.equal(rows[2].name, undefined);
        assert.equal(rows[3].name, undefined);
        assert.equal(rows[3].date, undefined);
    });
});
