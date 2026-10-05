import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    flexibleOtFieldsFromDuration,
    manualTimeOutDate,
    mergeFlexibleOtState,
} from './flexibleAttendance.js';

describe('flexibleOtFieldsFromDuration', () => {
    it('drops overtime when the new duration is only the required day plus one hour', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            date: '2026-10-05',
            timeIn: '09:00',
            timeOut: '19:00',
            requiredHours: 9,
            statusKey: 'on_office',
        });
        assert.equal(fields.flexibleOtHours, 0);
        assert.equal(fields.flexibleWorkedHours, 10);
    });

    it('keeps overtime for hours past the required day and the first extra hour', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            date: '2026-10-05',
            timeIn: '09:00',
            timeOut: '20:00',
            requiredHours: 9,
            statusKey: 'on_office',
        });
        assert.equal(fields.flexibleOtHours, 1);
    });

    it('counts every worked hour as overtime on a holiday or weekly off', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            nonWorking: true,
            date: '2026-10-05',
            timeIn: '09:00',
            timeOut: '17:00',
            requiredHours: 9,
            statusKey: 'on_office',
        });
        assert.equal(fields.flexibleOtHours, 8);
        assert.equal(fields.flexibleRequiredHours, 0);
    });

    it('clears overtime when check-in or check-out is missing', () => {
        const fields = flexibleOtFieldsFromDuration({
            isFlexible: true,
            date: '2026-10-05',
            timeIn: '09:00',
            timeOut: '',
            requiredHours: 9,
            statusKey: 'on_office',
        });
        assert.equal(fields.flexibleOtHours, 0);
    });
});

describe('mergeFlexibleOtState', () => {
    it('clears a request when the edited hours no longer contain overtime', () => {
        const next = mergeFlexibleOtState(
            { flexibleOtHours: 2, flexibleOtStatus: 'pending', flexibleOtApprovedHours: 2 },
            { flexibleWorkedHours: 10, flexibleRequiredHours: 9, flexibleOtHours: 0 },
        );
        assert.equal(next.changed, true);
        assert.equal(next.flexibleOtStatus, '');
        assert.equal(next.flexibleOtApprovedHours, 0);
        assert.equal(next.flexibleOtReason, '');
    });

    it('keeps the request when the duration still has the same overtime', () => {
        const next = mergeFlexibleOtState(
            { flexibleOtHours: 2, flexibleOtStatus: 'pending', flexibleOtApprovedHours: 2 },
            { flexibleWorkedHours: 12, flexibleRequiredHours: 9, flexibleOtHours: 2 },
        );
        assert.equal(next.changed, false);
        assert.equal(next.flexibleOtStatus, undefined);
    });
});

describe('manualTimeOutDate', () => {
    it('treats a later check-out as the same day and an earlier one as the next day', () => {
        assert.equal(manualTimeOutDate('2026-10-05', '09:00', '18:00'), '');
        assert.equal(manualTimeOutDate('2026-10-05', '22:00', '06:00'), '2026-10-06');
    });
});
