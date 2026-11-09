import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    MONTH_SALARY_DMF_STEP_DEFS,
    approveCurrentDmfStep,
    buildInitialDmf,
    payrollApprovalStatusLabel,
    recallMonthPayroll,
    rejectDmf,
    returnMonthPayrollToHr,
    salarySlipEditLockMessage,
    serializeDmf,
    salaryMonthBellStillOpen,
    viewerCanCreateSalarySlot,
    viewerCanRecallMonthPayroll,
    viewerCanSubmitMonthPayroll,
    viewerCanValidateMonthPayroll,
    viewerCanUpdateSalarySlip,
} from './salaryDmfApproval.js';

function person(id, first, email) {
    return { _id: id, employeeId: id, firstName: first, lastName: 'User', companyEmail: email };
}

function monthDraft() {
    return buildInitialDmf({
        assignees: {
            user1: person('ACC', 'Ada', 'ada@example.com'),
            accounts: person('ACC', 'Ada', 'ada@example.com'),
            hr: person('HR', 'Hana', 'hana@example.com'),
            management: person('MGT', 'Mina', 'mina@example.com'),
        },
        amount: 1000,
        billLabel: 'Salary 2026-10',
        actor: { id: 'user', name: 'Ada User' },
        stepDefs: MONTH_SALARY_DMF_STEP_DEFS,
    });
}

const accounts = { isAccounts: true, isHr: false, isManagement: false };
const hr = { isHr: true, isAccounts: false, isManagement: false };
const management = { isManagement: true, isHr: false, isAccounts: false };

describe('month payroll submit', () => {
    it('sends Accounts submit straight to HR', () => {
        const dmf = monthDraft();
        const result = approveCurrentDmfStep(dmf, { actor: { name: 'Ada User' }, comment: 'Submitted' });
        assert.equal(result.completed, false);
        assert.equal(result.nextStep.key, 'hr');
        assert.equal(dmf.currentStepKey, 'hr');
        assert.equal(dmf.steps.find((step) => step.key === 'accounts').status, 'approved');
        assert.equal(dmf.steps.find((step) => step.key === 'hr').status, 'pending');
        assert.equal(payrollApprovalStatusLabel(dmf), 'Pending for Hana User (HR)');
    });

    it('lets payroll submit while idle or rejected, including after a rejection', () => {
        const idle = { status: 'idle' };
        assert.equal(viewerCanSubmitMonthPayroll(idle, accounts), true);
        assert.equal(viewerCanSubmitMonthPayroll(idle, hr), false);
        assert.equal(viewerCanSubmitMonthPayroll(idle, management), false);
        assert.equal(viewerCanSubmitMonthPayroll({ status: 'pending' }, accounts), false);
        assert.equal(viewerCanSubmitMonthPayroll({ status: 'approved' }, accounts), false);

        const dmf = monthDraft();
        approveCurrentDmfStep(dmf, { actor: { name: 'Ada User' }, comment: 'Submitted' });
        rejectDmf(dmf, { actor: { name: 'Hana User' }, reason: 'Attendance still open' });
        assert.equal(dmf.status, 'rejected');
        assert.equal(payrollApprovalStatusLabel(dmf), 'Rejected');
        assert.equal(viewerCanSubmitMonthPayroll(dmf, accounts), true);
        assert.equal(viewerCanSubmitMonthPayroll(dmf, hr), false);
    });

    it('opens Create slot only for Accounts after Management approval', () => {
        const dmf = monthDraft();
        approveCurrentDmfStep(dmf, { actor: { name: 'Ada User' }, comment: 'Submitted' });
        approveCurrentDmfStep(dmf, { actor: { name: 'Hana User' }, comment: '' });
        const done = approveCurrentDmfStep(dmf, { actor: { name: 'Mina User' }, comment: '' });
        assert.equal(done.completed, true);
        assert.equal(dmf.status, 'approved');
        assert.equal(viewerCanCreateSalarySlot(dmf, accounts), true);
        assert.equal(viewerCanCreateSalarySlot(dmf, hr), false);

        const view = serializeDmf(dmf, { ready: true, ctx: accounts, flow: 'month' });
        assert.equal(view.canStart, false);
        assert.equal(view.canValidate, true);
        assert.equal(serializeDmf(dmf, { ready: true, ctx: hr, flow: 'month' }).canValidate, true);
        assert.equal(serializeDmf(dmf, { ready: true, ctx: management, flow: 'month' }).canValidate, false);
        assert.equal(view.canCreateSlot, true);
        assert.equal(serializeDmf(dmf, { ready: true, ctx: hr, flow: 'month' }).canCreateSlot, false);
    });

    it('keeps the salary bell with the role that still has the payroll', () => {
        assert.equal(
            salaryMonthBellStillOpen({ kind: 'month', dmfStatus: 'pending' }),
            true,
        );
        assert.equal(
            salaryMonthBellStillOpen({ kind: 'salary-accounts', dmfStatus: 'rejected' }),
            true,
        );
        assert.equal(
            salaryMonthBellStillOpen({ kind: 'salary-accounts', dmfStatus: 'idle' }),
            true,
        );
        assert.equal(
            salaryMonthBellStillOpen({
                kind: 'salary-zoho',
                dmfStatus: 'approved',
                zohoJournalUpdated: false,
            }),
            true,
        );
        assert.equal(
            salaryMonthBellStillOpen({
                kind: 'salary-zoho',
                dmfStatus: 'approved',
                zohoJournalUpdated: true,
            }),
            false,
        );
        assert.equal(
            salaryMonthBellStillOpen({ kind: 'salary-zoho', dmfStatus: 'pending' }),
            false,
        );
        assert.equal(
            salaryMonthBellStillOpen({ kind: 'month', dmfStatus: 'approved' }),
            false,
        );
    });

    it('lets Accounts and HR validate while Management has the payroll', () => {
        const dmf = monthDraft();
        approveCurrentDmfStep(dmf, { actor: { name: 'Ada User' }, comment: 'Submitted' });
        approveCurrentDmfStep(dmf, { actor: { name: 'Hana User' }, comment: '' });
        assert.equal(dmf.currentStepKey, 'management');
        assert.equal(viewerCanValidateMonthPayroll(accounts), true);
        assert.equal(viewerCanValidateMonthPayroll(hr), true);
        assert.equal(serializeDmf(dmf, { ready: true, ctx: accounts, flow: 'month' }).canValidate, true);
        assert.equal(serializeDmf(dmf, { ready: true, ctx: hr, flow: 'month' }).canValidate, true);
        assert.equal(serializeDmf(dmf, { ready: true, ctx: management, flow: 'month' }).canValidate, true);
        assert.equal(serializeDmf(dmf, { ready: true, ctx: {}, flow: 'month' }).canValidate, false);
    });

    it('lets Accounts, HR, and Management edit the slip until the payroll is processed', () => {
        const idle = { status: 'idle' };
        assert.equal(viewerCanUpdateSalarySlip(idle, accounts, { canEditSetup: false }), true);
        assert.equal(viewerCanUpdateSalarySlip(idle, hr, { canEditSetup: false }), true);
        assert.equal(viewerCanUpdateSalarySlip(idle, management, { canEditSetup: false }), true);
        assert.equal(viewerCanUpdateSalarySlip(idle, {}, { canEditSetup: true }), true);
        assert.equal(viewerCanUpdateSalarySlip(idle, {}, { canEditSetup: false }), false);
        assert.equal(salarySlipEditLockMessage(idle), '');

        const dmf = monthDraft();
        approveCurrentDmfStep(dmf, { actor: { name: 'Ada User' }, comment: 'Submitted' });
        assert.equal(dmf.currentStepKey, 'hr');
        assert.equal(viewerCanUpdateSalarySlip(dmf, hr, { canEditSetup: false }), true);
        assert.equal(viewerCanUpdateSalarySlip(dmf, accounts, { canEditSetup: false }), true);
        assert.equal(salarySlipEditLockMessage(dmf), '');
        assert.equal(viewerCanRecallMonthPayroll(dmf, accounts), true);
        assert.equal(viewerCanRecallMonthPayroll(dmf, hr), false);

        approveCurrentDmfStep(dmf, { actor: { name: 'Hana User' }, comment: '' });
        assert.equal(dmf.currentStepKey, 'management');
        assert.equal(viewerCanUpdateSalarySlip(dmf, management, { canEditSetup: false }), true);
        assert.equal(viewerCanUpdateSalarySlip(dmf, hr, { canEditSetup: false }), true);
        assert.equal(viewerCanUpdateSalarySlip(dmf, accounts, { canEditSetup: false }), true);
        assert.equal(salarySlipEditLockMessage(dmf), '');
        assert.equal(viewerCanRecallMonthPayroll(dmf, hr), true);
        assert.equal(viewerCanRecallMonthPayroll(dmf, accounts), false);

        approveCurrentDmfStep(dmf, { actor: { name: 'Mina User' }, comment: '' });
        assert.equal(dmf.status, 'approved');
        assert.equal(viewerCanUpdateSalarySlip(dmf, management, { canEditSetup: true }), false);
        assert.equal(viewerCanUpdateSalarySlip(dmf, accounts, { canEditSetup: true }), false);
        assert.equal(viewerCanUpdateSalarySlip(dmf, hr, { canEditSetup: true }), false);
        assert.equal(salarySlipEditLockMessage(dmf), 'This salary slip can no longer be edited.');
        assert.equal(viewerCanRecallMonthPayroll(dmf, accounts), false);
        assert.equal(viewerCanRecallMonthPayroll(dmf, hr), false);
    });

    it('lets Accounts recall from HR, and HR recall from Management', () => {
        const dmf = monthDraft();
        approveCurrentDmfStep(dmf, { actor: { name: 'Ada User' }, comment: 'Submitted' });
        recallMonthPayroll(dmf);
        assert.equal(dmf.status, 'idle');
        assert.equal(dmf.currentStepKey, '');
        assert.equal(dmf.steps.every((step) => step.status === 'scheduled'), true);
        assert.equal(viewerCanSubmitMonthPayroll(dmf, accounts), true);

        const withManagement = monthDraft();
        approveCurrentDmfStep(withManagement, { actor: { name: 'Ada User' }, comment: 'Submitted' });
        approveCurrentDmfStep(withManagement, { actor: { name: 'Hana User' }, comment: '' });
        const back = recallMonthPayroll(withManagement);
        assert.equal(back.returnedTo, 'hr');
        assert.equal(withManagement.status, 'pending');
        assert.equal(withManagement.currentStepKey, 'hr');
        assert.equal(withManagement.steps.find((step) => step.key === 'management').status, 'scheduled');
        assert.equal(viewerCanRecallMonthPayroll(withManagement, accounts), true);
        assert.throws(() => recallMonthPayroll({ status: 'approved', steps: [], currentStepKey: '' }));
    });

    it('returns a Management rejection to HR and requires a reason', () => {
        const dmf = monthDraft();
        approveCurrentDmfStep(dmf, { actor: { name: 'Ada User' }, comment: 'Submitted' });
        approveCurrentDmfStep(dmf, { actor: { name: 'Hana User' }, comment: '' });
        assert.equal(dmf.currentStepKey, 'management');
        assert.throws(() => returnMonthPayrollToHr(dmf, { actor: { name: 'Mina User' }, reason: '  ' }));
        returnMonthPayrollToHr(dmf, { actor: { name: 'Mina User' }, reason: 'Overtime is wrong' });
        assert.equal(dmf.status, 'pending');
        assert.equal(dmf.currentStepKey, 'hr');
        assert.equal(dmf.rejectReason, 'Overtime is wrong');
        assert.equal(dmf.steps.find((step) => step.key === 'hr').status, 'pending');
        assert.equal(dmf.steps.find((step) => step.key === 'management').status, 'scheduled');
        approveCurrentDmfStep(dmf, { actor: { name: 'Hana User' }, comment: '' });
        assert.equal(dmf.currentStepKey, 'management');
        assert.equal(dmf.rejectReason, '');
    });
});
