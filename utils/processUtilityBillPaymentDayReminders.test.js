import test from 'node:test';
import assert from 'node:assert/strict';
import { isUtilityTypePaymentNotice } from './utilityReminderTask.js';
import {
    dueUnpaidBillMonths,
    simCreatedBeforeBillMonth,
    unpaidMonthsSinceSimCreated,
    utilityTypeNoticeId,
    utilityTypePaymentMessage,
    previousCalendarMonthKey,
    previousMonthPayReminderDue,
    utilityMonthBillIsInZoho,
    utilityMonthBillIsSettled,
} from './processUtilityBillPaymentDayReminders.js';

test('a month with no bill is not settled', () => {
    assert.equal(utilityMonthBillIsSettled([]), false);
});

test('a saved bill of 0 is not paid, so the reminder stays open', () => {
    assert.equal(
        utilityMonthBillIsSettled([{ status: 'Approved', amount: 0 }]),
        false,
    );
    assert.equal(utilityMonthBillIsSettled([{ status: 'Pending', amount: 0 }]), false);
});

test('unpaid months through the previous month are the ones Accounts is notified for', () => {
    assert.deepEqual(dueUnpaidBillMonths('2026-07', 2026, 11), [
        '2026-07',
        '2026-08',
        '2026-09',
        '2026-10',
    ]);
    assert.deepEqual(dueUnpaidBillMonths('2026-11', 2026, 11), []);
    assert.deepEqual(dueUnpaidBillMonths('2026-10', 2026, 11), ['2026-10']);
});

test('only the utility-type bell is a task, not each SIM or account', () => {
    assert.equal(
        isUtilityTypePaymentNotice({
            requestType: 'Utility Bill Payment Reminder',
            extra3: JSON.stringify({ entryId: 'utility-type:internet bills', utilityTypeNotice: true }),
        }),
        true,
    );
    assert.equal(
        isUtilityTypePaymentNotice({
            requestType: 'Utility Bill Payment Reminder',
            extra3: JSON.stringify({ entryId: '507f1f77bcf86cd799439011' }),
        }),
        false,
    );
});

test('the 1st notice is one per utility, not one per SIM number', () => {
    assert.equal(utilityTypeNoticeId('SIM cards'), 'utility-type:sim cards');
    assert.equal(utilityTypeNoticeId('SIM cards'), utilityTypeNoticeId('sim cards'));
    assert.equal(
        utilityTypePaymentMessage('Internet Bills', '2026-10'),
        'October bill payment — Internet Bills, please pay the bill',
    );
    assert.match(utilityTypePaymentMessage('SIM cards', '2026-10'), /October/);
    assert.doesNotMatch(utilityTypePaymentMessage('SIM cards', '2026-10'), /050/);
});

test('a newly added SIM is not checked for months before it existed', () => {
    assert.equal(simCreatedBeforeBillMonth('2026-11', '2026-10'), false);
    assert.equal(simCreatedBeforeBillMonth('2026-11', '2026-11'), false);
    assert.equal(simCreatedBeforeBillMonth('2026-07', '2026-07'), false);
    assert.equal(simCreatedBeforeBillMonth('2026-07', '2026-08'), true);
    assert.deepEqual(unpaidMonthsSinceSimCreated('2026-11', 2026, 11), []);
    assert.deepEqual(unpaidMonthsSinceSimCreated('2026-10', 2026, 11), []);
    assert.deepEqual(unpaidMonthsSinceSimCreated('2026-07', 2026, 11), [
        '2026-08',
        '2026-09',
        '2026-10',
    ]);
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

test('the 1st notifies Accounts for the previous month by name', () => {
    assert.equal(previousCalendarMonthKey(2026, 11), '2026-10');
    assert.equal(previousCalendarMonthKey(2026, 1), '2025-12');
    assert.deepEqual(
        previousMonthPayReminderDue('2026-10', { year: 2026, month: 11, day: 1, alreadySent: false }),
        { open: true, send: true },
    );
    assert.deepEqual(
        previousMonthPayReminderDue('2026-10', { year: 2026, month: 11, day: 7, alreadySent: false }),
        { open: true, send: true },
    );
    assert.deepEqual(
        previousMonthPayReminderDue('2026-10', { year: 2026, month: 11, day: 7, alreadySent: true }),
        { open: true, send: false },
    );
    assert.deepEqual(
        previousMonthPayReminderDue('2026-11', { year: 2026, month: 11, day: 1, alreadySent: false }),
        { open: false, send: false },
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
