import test from 'node:test';
import assert from 'node:assert/strict';
import { stageAfterAccountsApproval, stageAfterHrApproval } from './loanAccountsGate.js';

test('an outside creator still goes to Accounts after HR when Accounts has not approved', () => {
    assert.equal(stageAfterHrApproval({ accountsFirst: true, workflow: [] }), 'Pending Accounts');
});

test('after Accounts has already approved, HR goes on to Management', () => {
    assert.equal(
        stageAfterHrApproval({ accountsFirst: true, accountsApprovedBy: 'accounts-user', workflow: [] }),
        'Pending Authorization',
    );
});

test('HR, Accounts, or Admin Officer skips the Accounts approval', () => {
    assert.equal(stageAfterHrApproval({ skipAccountsApproval: true, workflow: [] }), 'Pending Authorization');
});

test('Accounts first continues to HR', () => {
    assert.equal(
        stageAfterAccountsApproval({ accountsFirst: true, workflow: [{ role: 'Accounts', status: 'Pending' }] }),
        'Pending HR',
    );
});

test('Accounts after HR still goes to Management', () => {
    assert.equal(
        stageAfterAccountsApproval({
            workflow: [{ role: 'HR Admin', status: 'Approved' }],
        }),
        'Pending Authorization',
    );
});
