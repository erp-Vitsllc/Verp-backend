import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    accessFuelMonthlyLimitGate,
    isAccessFuelMonthlyLimitWindowOpen,
    isAccessFuelMonthlyCloseWindowOpen,
    accessFuelMonthlyCloseGate,
} from './accessFuelMonthlyLimitGate.js';

function dubaiDate(isoUtc) {
    return new Date(isoUtc);
}

describe('Access Fuel monthly limit window', () => {
    it('keeps the current month open before the last 5 days', () => {
        assert.equal(isAccessFuelMonthlyLimitWindowOpen('2026-09', dubaiDate('2026-09-08T08:00:00.000Z')), true);
        assert.equal(isAccessFuelMonthlyLimitWindowOpen('2026-09', dubaiDate('2026-09-26T08:00:00.000Z')), true);
        assert.equal(isAccessFuelMonthlyLimitWindowOpen('2026-09', dubaiDate('2026-09-30T08:00:00.000Z')), true);
    });

    it('opens next month only in the last 5 days of the current month', () => {
        assert.equal(isAccessFuelMonthlyLimitWindowOpen('2026-10', dubaiDate('2026-09-08T08:00:00.000Z')), false);
        assert.equal(isAccessFuelMonthlyLimitWindowOpen('2026-10', dubaiDate('2026-09-25T08:00:00.000Z')), false);
        assert.equal(isAccessFuelMonthlyLimitWindowOpen('2026-10', dubaiDate('2026-09-26T08:00:00.000Z')), true);
        assert.equal(isAccessFuelMonthlyLimitWindowOpen('2026-10', dubaiDate('2026-10-01T08:00:00.000Z')), true);
    });

    it('enables when assigned vehicles still need fuel this month', () => {
        const now = dubaiDate('2026-09-08T08:00:00.000Z');
        assert.equal(
            accessFuelMonthlyLimitGate({
                monthKey: '2026-09',
                assignedCount: 13,
                notAddedCount: 10,
                alreadyCreated: false,
                now,
            }).canCreate,
            true,
        );
        assert.equal(
            accessFuelMonthlyLimitGate({
                monthKey: '2026-09',
                assignedCount: 13,
                notAddedCount: 10,
                alreadyCreated: true,
                now,
            }).canCreate,
            false,
        );
        assert.equal(
            accessFuelMonthlyLimitGate({
                monthKey: '2026-09',
                assignedCount: 13,
                notAddedCount: 0,
                alreadyCreated: false,
                now,
            }).canCreate,
            false,
        );
    });
});

describe('Access Fuel monthly close window', () => {
    it('opens only on the 2nd of the next month', () => {
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-09', dubaiDate('2026-09-08T08:00:00.000Z')), false);
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-09', dubaiDate('2026-10-01T08:00:00.000Z')), false);
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-09', dubaiDate('2026-10-02T08:00:00.000Z')), true);
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-09', dubaiDate('2026-10-03T08:00:00.000Z')), false);
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-12', dubaiDate('2027-01-02T08:00:00.000Z')), true);
    });

    it('needs open fuel-added vehicles on that day', () => {
        const now = dubaiDate('2026-10-02T08:00:00.000Z');
        assert.equal(
            accessFuelMonthlyCloseGate({ monthKey: '2026-09', openAddedCount: 3, now }).canClose,
            true,
        );
        assert.equal(
            accessFuelMonthlyCloseGate({ monthKey: '2026-09', openAddedCount: 0, now }).canClose,
            false,
        );
        assert.equal(
            accessFuelMonthlyCloseGate({
                monthKey: '2026-09',
                openAddedCount: 3,
                now: dubaiDate('2026-09-08T08:00:00.000Z'),
            }).canClose,
            false,
        );
    });
});
