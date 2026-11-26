import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dubaiDateKey, formatWorkOrderNo, nextWorkOrderNo, parseWorkOrderNo, workOrderNoInText } from './workOrderNumber.js';

const year2026 = new Date(2026, 5, 15);

describe('dubaiDateKey', () => {
    it('uses the Dubai calendar date', () => {
        assert.equal(dubaiDateKey(new Date('2026-11-15T22:30:00.000Z')), '2026-11-16');
        assert.equal(dubaiDateKey(new Date('2026-11-16T19:30:00.000Z')), '2026-11-16');
    });
});

describe('formatWorkOrderNo', () => {
    it('pads the count to three digits', () => {
        assert.equal(formatWorkOrderNo(2026, 1), 'WO-26-001');
        assert.equal(formatWorkOrderNo(2026, 12), 'WO-26-012');
        assert.equal(formatWorkOrderNo(2026, 1000), 'WO-26-1000');
    });
});

describe('nextWorkOrderNo', () => {
    it('starts each year at 001', () => {
        assert.equal(nextWorkOrderNo([], year2026), 'WO-26-001');
        assert.equal(nextWorkOrderNo(['WO-25-128'], year2026), 'WO-26-001');
    });

    it('counts up from the highest number in that year', () => {
        assert.equal(
            nextWorkOrderNo(['WO-26-001', 'WO-2026-007', 'WO-25-040'], year2026),
            'WO-26-008',
        );
        assert.equal(nextWorkOrderNo(['WO-26-099'], year2026), 'WO-26-100');
    });

    it('ignores numbers that are not work order numbers', () => {
        assert.equal(nextWorkOrderNo(['WO-25-0128', 'draft', ''], year2026), 'WO-26-001');
        assert.equal(parseWorkOrderNo('WO-26-001')?.sequence, 1);
        assert.equal(parseWorkOrderNo('WO-2026-001')?.year, 2026);
        assert.equal(parseWorkOrderNo('TSK-26-1'), null);
    });
});

describe('workOrderNoInText', () => {
    it('reads the work order number out of a task sentence', () => {
        assert.equal(workOrderNoInText('Upload attachment to the work order WO-26-012'), 'WO-26-012');
        assert.equal(workOrderNoInText('Approve the actual BOQ on WO-2026-7'), 'WO-26-007');
        assert.equal(workOrderNoInText('Create the MR'), '');
    });
});
