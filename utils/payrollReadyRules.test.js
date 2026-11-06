import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    assetPayrollInvolvement,
    fineBlocksPayrollReady,
    fineBlocksThisPayrollMonth,
    loanBlocksPayrollReady,
    loanPayrollRole,
    loanPayrollTitle,
    partyBalanceDueInMonth,
    utilityExcessForMonth,
    utilityBillPending,
} from './payrollReadyRules.js';

describe('loan and advance payroll readiness', () => {
    it('blocks approval and Accounts disbursement, not salary repayment', () => {
        assert.equal(loanBlocksPayrollReady({ status: 'Pending HR', approvalStatus: 'Pending HR' }), true);
        assert.equal(
            loanBlocksPayrollReady({ status: 'Pending Payment to Employee', paidAmount: 0, amount: 1000 }),
            true,
        );
        assert.equal(
            loanBlocksPayrollReady({ status: 'Approved', approvalStatus: 'Approved', amount: 1000, paidAmount: 0, repaidAmount: 0 }),
            true,
        );
        assert.equal(
            loanBlocksPayrollReady({
                status: 'Approved',
                approvalStatus: 'Approved',
                amount: 1000,
                paidAmount: 1000,
                repaidAmount: 200,
            }),
            false,
        );
        assert.equal(loanBlocksPayrollReady({ status: 'Paid', approvalStatus: 'Paid', repaidAmount: 0 }), false);
        assert.equal(loanBlocksPayrollReady({ status: 'Rejected' }), false);
        assert.equal(loanPayrollTitle({ type: 'Advance', status: 'Pending Payment to Employee' }), 'Advance · Accounts payment');
        assert.equal(loanPayrollRole({ type: 'Loan', status: 'Pending Payment to Employee' }), 'Accounts');
        assert.equal(loanPayrollTitle({ type: 'Loan', status: 'Pending HR' }), 'Loan approval');
    });
});

describe('fine payroll readiness', () => {
    it('blocks every open fine until Accounts settles Zoho or employee pay', () => {
        assert.equal(fineBlocksPayrollReady({ fineStatus: 'Pending HR' }), true);
        assert.equal(fineBlocksPayrollReady({ fineStatus: 'Approved', accountsPaymentPath: '' }), true);
        assert.equal(fineBlocksPayrollReady({ fineStatus: 'Active', accountsPaymentPath: '' }), true);
        assert.equal(fineBlocksPayrollReady({ fineStatus: 'Approved', accountsPaymentPath: 'zoho' }), false);
        assert.equal(fineBlocksPayrollReady({ fineStatus: 'Approved', accountsPaymentPath: 'employee' }), false);
        assert.equal(fineBlocksPayrollReady({ fineStatus: 'Paid' }), false);
        assert.equal(fineBlocksPayrollReady({ fineStatus: 'Completed' }), false);
    });

    it('shows every fine type only on the payroll month it was created', () => {
        const createdInNovember = {
            fineStatus: 'Pending HR',
            fineType: 'Vehicle Fine',
            createdAt: '2026-11-05T06:16:00.000Z',
            monthStart: '2026-10',
        };
        const createdInOctober = {
            fineStatus: 'Pending Authorization',
            fineType: 'Other Fines',
            createdAt: '2026-10-20T08:00:00.000Z',
        };
        assert.equal(fineBlocksThisPayrollMonth(createdInNovember, '2026-10'), false);
        assert.equal(fineBlocksThisPayrollMonth(createdInNovember, '2026-11'), true);
        assert.equal(fineBlocksThisPayrollMonth(createdInOctober, '2026-10'), true);
        assert.equal(fineBlocksThisPayrollMonth(createdInOctober, '2026-11'), false);
        assert.equal(
            fineBlocksThisPayrollMonth({ fineStatus: 'Paid', fineType: 'Safety Fine', createdAt: '2026-10-02T08:00:00.000Z' }, '2026-10'),
            false,
        );
    });
});

describe('utility payroll readiness', () => {
    it('blocks a pending bill, and excess only on the salary month', () => {
        const pending = { status: 'Pending Accounts', billMonth: '2026-09', employeeDiffAmount: 40, payByEmployeeId: 'E1' };
        assert.equal(utilityBillPending(pending), true);
        assert.equal(utilityExcessForMonth(pending, '2026-10'), false);
        const excess = { status: 'Approved', billMonth: 'October 2026', employeeDiffAmount: 25, paymentBy: 'employee' };
        assert.equal(utilityExcessForMonth(excess, '2026-10'), true);
        assert.equal(utilityExcessForMonth({ ...excess, billMonth: '2026-09' }, '2026-10'), false);
        assert.equal(utilityExcessForMonth({ ...excess, paymentBy: 'company' }, '2026-10'), false);
        assert.equal(
            partyBalanceDueInMonth({ kind: 'balance', status: 'Not Paid', billMonth: '2026-10' }, '2026-10'),
            true,
        );
        assert.equal(
            partyBalanceDueInMonth({ kind: 'loan', status: 'Not Paid', billMonth: '2026-10' }, '2026-10'),
            false,
        );
    });
});

describe('asset payroll readiness', () => {
    it('blocks a pending assignment to the employee and a pending return', () => {
        const assigned = {
            _id: 'a1',
            acceptanceStatus: 'Pending',
            assignedTo: 'emp-1',
            assignedBy: 'emp-2',
            pendingAction: null,
        };
        assert.equal(assetPayrollInvolvement(assigned, 'emp-1')?.title, 'Asset assignment pending');
        assert.equal(assetPayrollInvolvement(assigned, 'emp-2'), null);
        assert.equal(assetPayrollInvolvement({ ...assigned, acceptanceStatus: 'Accepted' }, 'emp-1'), null);

        const returning = {
            _id: 'a2',
            acceptanceStatus: 'Accepted',
            assignedTo: 'emp-1',
            pendingAction: 'Return Asset',
            pendingActionDetails: { requestedBy: 'emp-1' },
            actionRequiredBy: 'emp-3',
        };
        assert.equal(assetPayrollInvolvement(returning, 'emp-1')?.title, 'Asset return pending');
        assert.equal(assetPayrollInvolvement(returning, 'emp-3')?.title, 'Asset return pending');
        assert.equal(
            assetPayrollInvolvement({ ...returning, pendingAction: 'Asset Transfer' }, 'emp-1'),
            null,
        );
    });
});
