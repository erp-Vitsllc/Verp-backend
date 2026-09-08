import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    accessFuelEmailSubject,
    accessFuelInboxMessage,
    accessFuelMonthLabel,
    isAssignedVehicleForAccessFuel,
} from './processVehicleAccessFuelReminders.js';

describe('Access Fuel monthly reminder copy', () => {
    it('uses Assigned status only', () => {
        assert.equal(isAssignedVehicleForAccessFuel({ status: 'Assigned' }), true);
        assert.equal(isAssignedVehicleForAccessFuel({ status: 'assigned' }), true);
        assert.equal(isAssignedVehicleForAccessFuel({ status: 'Unassigned' }), false);
        assert.equal(isAssignedVehicleForAccessFuel({ status: 'Returned' }), false);
        assert.equal(isAssignedVehicleForAccessFuel({}), false);
    });

    it('builds the once-a-month email subject from the month', () => {
        assert.equal(accessFuelEmailSubject('2026-08'), 'Aug vehicle monthly limit');
        assert.equal(accessFuelEmailSubject('2026-09'), 'Sep vehicle monthly limit');
    });

    it('builds the vehicle bell message from the missing monthly-limit count', () => {
        assert.equal(
            accessFuelInboxMessage(3, '2026-09'),
            '3 vehicles have to add September 2026 monthly limit',
        );
        assert.equal(
            accessFuelInboxMessage(1, '2026-08'),
            '1 vehicle has to add August 2026 monthly limit',
        );
        assert.equal(accessFuelMonthLabel('2026-08', 'short'), 'Aug');
    });
});
