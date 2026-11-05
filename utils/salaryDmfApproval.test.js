import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    MONTH_SALARY_DMF_STEP_DEFS,
    approveCurrentDmfStep,
    buildInitialDmf,
    payrollApprovalStatusLabel,
    rejectDmf,
    serializeDmf,
    viewerCanCreateSalarySlot,
    viewerCanSubmitMonthPayroll,
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

const accounts = { isAccounts: true };
const hr = { isHr: true, isAccounts: false };

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

    it('lets only flowchart Accounts submit, including after a rejection', () => {
        const idle = { status: 'idle' };
        assert.equal(viewerCanSubmitMonthPayroll(idle, accounts), true);
        assert.equal(viewerCanSubmitMonthPayroll(idle, hr), false);
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
        assert.equal(view.canCreateSlot, true);
        assert.equal(serializeDmf(dmf, { ready: true, ctx: hr, flow: 'month' }).canCreateSlot, false);
    });

    it('lets only Management update a salary slip after the month is processed', () => {
        const management = { isManagement: true };
        const idle = { status: 'idle' };
        assert.equal(viewerCanUpdateSalarySlip(idle, accounts, { canEditSetup: true }), true);
        assert.equal(viewerCanUpdateSalarySlip(idle, management, { canEditSetup: false }), false);
        assert.equal(viewerCanUpdateSalarySlip({ status: 'pending' }, hr, { canEditSetup: true }), true);

        const dmf = monthDraft();
        approveCurrentDmfStep(dmf, { actor: { name: 'Ada User' }, comment: 'Submitted' });
        approveCurrentDmfStep(dmf, { actor: { name: 'Hana User' }, comment: '' });
        approveCurrentDmfStep(dmf, { actor: { name: 'Mina User' }, comment: '' });
        assert.equal(dmf.status, 'approved');
        assert.equal(viewerCanUpdateSalarySlip(dmf, management, { canEditSetup: false }), true);
        assert.equal(viewerCanUpdateSalarySlip(dmf, accounts, { canEditSetup: true }), false);
        assert.equal(viewerCanUpdateSalarySlip(dmf, hr, { canEditSetup: true }), false);
    });
});
