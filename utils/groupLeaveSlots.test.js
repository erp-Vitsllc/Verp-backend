import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { floorGroupLeaveSlots, readGroupLeavePercent } from './groupLeaveSlots.js';

describe('floorGroupLeaveSlots', () => {
    it('lets 1% of 10 staff allow one person', () => {
        assert.equal(floorGroupLeaveSlots(10, 1), 1);
    });

    it('keeps 1.5 and 1.6 as 1', () => {
        assert.equal(floorGroupLeaveSlots(10, 15), 1);
        assert.equal(floorGroupLeaveSlots(10, 16), 1);
    });

    it('uses 2 once the raw count reaches or crosses 2', () => {
        assert.equal(floorGroupLeaveSlots(10, 20), 2);
        assert.equal(floorGroupLeaveSlots(10, 29), 2);
        assert.equal(floorGroupLeaveSlots(10, 30), 3);
    });

    it('returns 0 when percent or headcount is empty', () => {
        assert.equal(floorGroupLeaveSlots(10, 0), 0);
        assert.equal(floorGroupLeaveSlots(0, 10), 0);
        assert.equal(floorGroupLeaveSlots(10, null), 0);
    });
});

describe('readGroupLeavePercent', () => {
    it('treats blank as unset and clamps above 100', () => {
        assert.equal(readGroupLeavePercent(''), null);
        assert.equal(readGroupLeavePercent(undefined), null);
        assert.equal(readGroupLeavePercent(0), 0);
        assert.equal(readGroupLeavePercent(10), 10);
        assert.equal(readGroupLeavePercent(150), 100);
    });
});
