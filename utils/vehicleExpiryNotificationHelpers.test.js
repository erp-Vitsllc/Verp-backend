import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildVehicleExpiryFollowUpExtra1,
    collectLiveDueVehicleExpiryExtra1,
    isLiveVehicleExpiryExtra1,
} from './vehicleExpiryNotificationHelpers.js';

function daysFromToday(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    date.setHours(12, 0, 0, 0);
    return date;
}

function fleetAsset(documents) {
    return {
        _id: 'veh1',
        assetId: 'VEGA-VHCL-006',
        name: 'YARIS',
        plateNumber: 'A 12345',
        vehicleProfileActivationStatus: 'active',
        vehicleDispositionStatus: 'active',
        documents,
    };
}

describe('vehicle expiry reminders after renewal', () => {
    it('keeps a reminder only while that live card is still inside the window', () => {
        const soon = daysFromToday(3);
        const asset = fleetAsset([
            { type: 'Insurance', expiryDate: soon },
        ]);
        const extra1 = buildVehicleExpiryFollowUpExtra1({
            label: 'Insurance Card',
            expiryDate: soon,
        });

        assert.equal(isLiveVehicleExpiryExtra1(asset, extra1), true);
        assert.equal(
            collectLiveDueVehicleExpiryExtra1(asset).has(extra1),
            true,
        );
    });

    it('drops the old reminder after the card is renewed past the window', () => {
        const oldExpiry = daysFromToday(-2);
        const renewedExpiry = daysFromToday(360);
        const asset = fleetAsset([
            {
                type: 'Insurance',
                expiryDate: oldExpiry,
                status: 'old',
                description: JSON.stringify({ isRenewed: true, archiveReason: 'Replaced' }),
            },
            { type: 'Insurance', expiryDate: renewedExpiry },
        ]);
        const staleExtra1 = buildVehicleExpiryFollowUpExtra1({
            label: 'Insurance Card',
            expiryDate: oldExpiry,
        });
        const legacyNameOnly = 'YARIS (VEGA-VHCL-006)';

        assert.equal(isLiveVehicleExpiryExtra1(asset, staleExtra1), false);
        assert.equal(isLiveVehicleExpiryExtra1(asset, legacyNameOnly), false);
        assert.equal(collectLiveDueVehicleExpiryExtra1(asset).size, 0);
    });

    it('drops a name-only reminder when registration has no expiry and insurance was renewed', () => {
        const asset = fleetAsset([
            { type: 'Registration', issueDate: null, expiryDate: null },
            { type: 'Insurance', expiryDate: daysFromToday(360) },
        ]);

        assert.equal(isLiveVehicleExpiryExtra1(asset, 'YARIS (VEGA-VHCL-006)'), false);
        assert.equal(
            isLiveVehicleExpiryExtra1(
                asset,
                'Expiry follow-up required: YARIS (VEGA-VHCL-006)',
            ),
            false,
        );
    });

    it('drops the reminder after Not Renew and keeps a different card that is still due', () => {
        const soon = daysFromToday(2);
        const asset = fleetAsset([
            {
                type: 'Insurance',
                expiryDate: daysFromToday(-1),
                description: JSON.stringify({ isRenewed: true, notRenewed: true, archiveReason: 'Not Renewed' }),
            },
            { type: 'Warranty', expiryDate: soon },
        ]);
        const closedInsurance = buildVehicleExpiryFollowUpExtra1({
            label: 'Insurance Card',
            expiryDate: daysFromToday(-1),
        });
        const liveWarranty = buildVehicleExpiryFollowUpExtra1({
            label: 'Warranty',
            expiryDate: soon,
        });

        assert.equal(isLiveVehicleExpiryExtra1(asset, closedInsurance), false);
        assert.equal(isLiveVehicleExpiryExtra1(asset, 'YARIS (VEGA-VHCL-006)'), false);
        assert.equal(isLiveVehicleExpiryExtra1(asset, liveWarranty), true);
    });
});
