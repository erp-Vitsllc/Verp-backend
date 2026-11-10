import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
    isAccountsOpeningBeforeHr,
    stageAfterAccountsApproval,
    stageAfterHrApproval,
    storedUserId,
} from './loanAccountsGate.js';

test('a stored loan creator id stays a 24-character id, not the raw byte buffer', () => {
    const id = new mongoose.Types.ObjectId();
    assert.equal(storedUserId(id), id.toString());
    assert.equal(storedUserId(id.toString()), id.toString());
    assert.equal(storedUserId({ _id: id, employeeId: 'VEGA-HR-0001' }), id.toString());
    assert.equal(storedUserId(id.id), null);
});

test('a normal employee create parked on Accounts is still the opening, not the Accounts workflow', () => {
    assert.equal(
        isAccountsOpeningBeforeHr({
            accountsFirst: true,
            approvalStatus: 'Pending Accounts',
            workflow: [{ role: 'Accounts', status: 'Pending' }],
        }),
        true,
    );
    assert.equal(
        isAccountsOpeningBeforeHr({
            accountsFirst: true,
            approvalStatus: 'Pending Accounts',
            hrApprovedBy: 'hr-user',
            workflow: [{ role: 'HR', status: 'Approved' }, { role: 'Accounts', status: 'Pending' }],
        }),
        false,
    );
    assert.equal(
        isAccountsOpeningBeforeHr({
            accountsFirst: false,
            approvalStatus: 'Pending Accounts',
            workflow: [{ role: 'HR', status: 'Approved' }, { role: 'Accounts', status: 'Pending' }],
        }),
        false,
    );
});

test('an outside creator still goes to Accounts after HR when Accounts has not approved', () => {
    assert.equal(stageAfterHrApproval({ accountsFirst: true, workflow: [] }), 'Pending Accounts');
});

test('after the opening Accounts approve, HR still sends the loan back to Accounts for payment', () => {
    assert.equal(
        stageAfterHrApproval({
            accountsFirst: true,
            workflow: [{ role: 'Accounts', status: 'Approved' }, { role: 'HR', status: 'Approved' }],
        }),
        'Pending Accounts',
    );
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
