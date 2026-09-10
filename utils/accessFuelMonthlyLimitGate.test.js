import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    accessFuelMonthlyLimitGate,
    isAccessFuelMonthlyLimitWindowOpen,
    isAccessFuelMonthlyCloseWindowOpen,
    accessFuelMonthlyCloseGate,
    assignedVehiclesMissingMonthlyLimit,
    limitedVehicleIdsFromLog,
    pendingAccessFuelLimitVehicles,
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

    it('disables previous months', () => {
        assert.equal(isAccessFuelMonthlyLimitWindowOpen('2026-08', dubaiDate('2026-09-08T08:00:00.000Z')), false);
        assert.equal(isAccessFuelMonthlyLimitWindowOpen('2026-07', dubaiDate('2026-09-26T08:00:00.000Z')), false);
        assert.equal(
            accessFuelMonthlyLimitGate({
                monthKey: '2026-08',
                assignedCount: 13,
                pendingLimitCount: 10,
                now: dubaiDate('2026-09-08T08:00:00.000Z'),
            }).canCreate,
            false,
        );
        assert.match(
            accessFuelMonthlyLimitGate({
                monthKey: '2026-08',
                assignedCount: 13,
                pendingLimitCount: 10,
                now: dubaiDate('2026-09-08T08:00:00.000Z'),
            }).reason,
            /current or future/i,
        );
    });

    it('enables while assigned vehicles still need a monthly limit', () => {
        const now = dubaiDate('2026-09-08T08:00:00.000Z');
        assert.equal(
            accessFuelMonthlyLimitGate({
                monthKey: '2026-09',
                assignedCount: 13,
                pendingLimitCount: 10,
                now,
            }).canCreate,
            true,
        );
        assert.equal(
            accessFuelMonthlyLimitGate({
                monthKey: '2026-09',
                assignedCount: 13,
                pendingLimitCount: 0,
                now,
            }).canCreate,
            false,
        );
        assert.equal(
            accessFuelMonthlyLimitGate({
                monthKey: '2026-09',
                assignedCount: 0,
                pendingLimitCount: 0,
                now,
            }).canCreate,
            false,
        );
    });

    it('hides vehicles already checked or limited for the month', () => {
        const assigned = [
            { _id: 'a', fuelMonthlyLimit: 0 },
            { _id: 'b', fuelMonthlyLimit: 800 },
            { _id: 'c', fuelMonthlyLimit: 0 },
        ];
        assert.deepEqual(
            pendingAccessFuelLimitVehicles({
                assignedVehicles: assigned,
                billedVehicleIds: ['c'],
                limitLog: { vehicleIds: ['a'] },
            }).map((row) => String(row._id)),
            ['b'],
        );
        assert.deepEqual(limitedVehicleIdsFromLog({ vehicleIds: ['a'] }, assigned), ['a']);
        assert.deepEqual(limitedVehicleIdsFromLog({ vehicleCount: 1 }, assigned), ['b']);
        assert.deepEqual(
            assignedVehiclesMissingMonthlyLimit({
                assignedVehicles: assigned,
                limitLog: { vehicleIds: ['a'] },
            }).map((row) => String(row._id)),
            ['b', 'c'],
        );
    });
});

describe('Access Fuel monthly close window', () => {
    it('opens from the 2nd of the next month onward', () => {
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-09', dubaiDate('2026-09-08T08:00:00.000Z')), false);
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-09', dubaiDate('2026-10-01T08:00:00.000Z')), false);
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-09', dubaiDate('2026-10-02T08:00:00.000Z')), true);
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-09', dubaiDate('2026-10-03T08:00:00.000Z')), true);
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-08', dubaiDate('2026-09-09T08:00:00.000Z')), true);
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-12', dubaiDate('2027-01-02T08:00:00.000Z')), true);
        assert.equal(isAccessFuelMonthlyCloseWindowOpen('2026-12', dubaiDate('2027-02-10T08:00:00.000Z')), true);
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
        assert.equal(
            accessFuelMonthlyCloseGate({
                monthKey: '2026-08',
                openAddedCount: 1,
                now: dubaiDate('2026-09-09T08:00:00.000Z'),
            }).canClose,
            true,
        );
    });
});
