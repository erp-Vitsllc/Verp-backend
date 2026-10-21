import test from 'node:test';
import assert from 'node:assert/strict';
import {
    utilityMonthBillIsInZoho,
    utilityMonthBillIsSettled,
} from './processUtilityBillPaymentDayReminders.js';

test('a month with no bill is not settled', () => {
    assert.equal(utilityMonthBillIsSettled([]), false);
});

test('a saved bill of 0 closes the pay reminder', () => {
    assert.equal(
        utilityMonthBillIsSettled([{ status: 'Approved', amount: 0 }]),
        true,
    );
});

test('a real unpaid bill with no Zoho link stays open', () => {
    assert.equal(
        utilityMonthBillIsSettled([{ status: 'Approved', amount: 108.87 }]),
        false,
    );
});

test('a paid bill is settled; a Zoho upload that is still open is not', () => {
    assert.equal(utilityMonthBillIsSettled([{ status: 'Paid', amount: 50 }]), true);
    assert.equal(
        utilityMonthBillIsSettled([
            { status: 'Approved', amount: 50, zohoBillId: 'zb-1', zohoBillStatus: 'open' },
        ]),
        false,
    );
    assert.equal(
        utilityMonthBillIsSettled([
            { status: 'Approved', amount: 50, zohoBillId: 'zb-1', zohoBillStatus: 'paid' },
        ]),
        true,
    );
});

test('a Zoho-linked bill is the gate for the accounts task', () => {
    assert.equal(utilityMonthBillIsInZoho([{ status: 'Approved', amount: 50 }]), false);
    assert.equal(
        utilityMonthBillIsInZoho([{ status: 'Approved', amount: 50, zohoBillId: 'zb-1' }]),
        true,
    );
});

test('a rejected zero bill does not settle the month', () => {
    assert.equal(
        utilityMonthBillIsSettled([{ status: 'Rejected', amount: 0 }]),
        false,
    );
});
