import test from 'node:test';
import assert from 'node:assert/strict';
import { clockShiftMinutes, normalizeWorkPay, shiftClockLabel } from './workPayLocation.js';

test('India is 90 minutes ahead of UAE', () => {
    const shift = clockShiftMinutes('Asia/Kolkata', new Date('2026-06-15T08:00:00Z'));
    assert.equal(shift, 90);
});

test('UAE 9:00 to 18:00 is 10:30 to 19:30 in India', () => {
    assert.equal(shiftClockLabel('09:00', 90), '10:30');
    assert.equal(shiftClockLabel('18:00', 90), '19:30');
});

test('UAE work location stays on dirhams', () => {
    const result = normalizeWorkPay({ workLocation: 'uae' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.value.salaryCurrency, 'AED');
    assert.equal(result.value.workTimeZone, 'Asia/Dubai');
});

test('outside UAE requires a country and currency', () => {
    const missing = normalizeWorkPay({ workLocation: 'outside_uae' });
    assert.ok(missing.errors.length > 0);
    const india = normalizeWorkPay({
        workLocation: 'outside_uae',
        workingFromCountry: 'India',
        workingFromCountryCode: 'IN',
        salaryCurrency: 'INR',
        workTimeZone: 'Asia/Kolkata',
    });
    assert.deepEqual(india.errors, []);
    assert.equal(india.value.salaryCurrency, 'INR');
});
