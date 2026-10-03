import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    CLOSED_FUEL_MONTH_GPS_TTL_MS,
    fuelMonthGpsIsFresh,
    fuelMonthGpsIsUsable,
    fuelMonthRangeIsClosed,
} from './fuelMonthGpsCache.js';

const NOW = new Date('2026-10-03T08:00:00.000Z');

function stat(ageMs, summarySource = 'excessive-idling') {
    return {
        summarySource,
        computedAt: new Date(NOW.getTime() - ageMs).toISOString(),
    };
}

describe('fuel month GPS cache', () => {
    it('treats a finished month as closed', () => {
        assert.equal(fuelMonthRangeIsClosed(new Date('2026-10-01T00:00:00.000Z'), NOW), true);
        assert.equal(fuelMonthRangeIsClosed(new Date('2026-10-04T00:00:00.000Z'), NOW), false);
    });

    it('keeps previous months usable without another GPS scan', () => {
        const end = new Date('2026-10-01T00:00:00.000Z');
        assert.equal(fuelMonthGpsIsUsable(stat(30 * 24 * 60 * 60 * 1000), end, NOW), true);
        assert.equal(fuelMonthGpsIsFresh(stat(60 * 60 * 1000), end, NOW), true);
        assert.equal(fuelMonthGpsIsFresh(stat(CLOSED_FUEL_MONTH_GPS_TTL_MS + 1000), end, NOW), false);
    });

    it('reuses the current month briefly, then allows a quiet refresh', () => {
        const end = new Date('2026-10-04T00:00:00.000Z');
        assert.equal(fuelMonthGpsIsFresh(stat(30 * 1000), end, NOW), true);
        assert.equal(fuelMonthGpsIsFresh(stat(5 * 60 * 1000), end, NOW), false);
        assert.equal(fuelMonthGpsIsUsable(stat(5 * 60 * 1000), end, NOW), true);
        assert.equal(fuelMonthGpsIsUsable(stat(20 * 60 * 1000), end, NOW), false);
    });

    it('rejects a row with no calculation time', () => {
        const end = new Date('2026-10-01T00:00:00.000Z');
        assert.equal(fuelMonthGpsIsUsable({ summarySource: 'snapshots' }, end, NOW), false);
        assert.equal(fuelMonthGpsIsFresh({ computedAt: 'not-a-date' }, end, NOW), false);
    });
});
