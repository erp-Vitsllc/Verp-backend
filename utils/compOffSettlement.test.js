import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    adjustableOvertimeHoursFromRows,
    canAdjustFromOvertime,
    compOffActions,
    compOffDisplayLabel,
    deductedCompOffHours,
    effectiveChargeMonth,
    isUnsettledCompOff,
    monthName,
    nextMonthKey,
} from './compOffSettlement.js';

const WORK_DAY = {
    startHour: '9',
    startMinute: '00',
    startMeridiem: 'AM',
    endHour: '6',
    endMinute: '00',
    endMeridiem: 'PM',
    isOffDay: false,
};

const WEEK = {
    timingMode: 'fixed',
    monday: WORK_DAY,
    tuesday: WORK_DAY,
    wednesday: WORK_DAY,
    thursday: WORK_DAY,
    friday: WORK_DAY,
    saturday: { ...WORK_DAY, isOffDay: true },
    sunday: { ...WORK_DAY, isOffDay: true },
};

describe('comp-off settlement', () => {
    it('names the next month and allows one jump', () => {
        assert.equal(nextMonthKey('2026-12'), '2027-01');
        assert.equal(monthName('2026-04'), 'April');
        const open = { date: '2026-03-12', statusKey: 'compoff_leave', compOff: {} };
        assert.equal(compOffDisplayLabel(open), 'Comp Off Leave');
        assert.equal(isUnsettledCompOff(open), true);
        assert.deepEqual(compOffActions(open), { canAdjust: true, canJump: true, canAuthorize: false });

        const jumped = {
            date: '2026-03-12',
            statusKey: 'compoff_leave',
            compOff: { state: 'jumped', chargeMonth: '2026-04', jumpCount: 1 },
        };
        assert.equal(effectiveChargeMonth(jumped), '2026-04');
        assert.equal(compOffDisplayLabel(jumped), 'Comp Off (April)');
        assert.deepEqual(compOffActions(jumped), { canAdjust: true, canJump: false, canAuthorize: true });
        assert.equal(isUnsettledCompOff({ ...jumped, statusKey: 'authorized_leave' }), false);
    });

    it('adjusts only from weekday overtime of at least 10 hours', () => {
        const rows = [
            { date: '2026-10-02', timeIn: '09:00', timeOut: '04:00' },
            { date: '2026-10-03', timeIn: '09:00', timeOut: '18:00' },
        ];
        const hours = adjustableOvertimeHoursFromRows(rows, WEEK);
        assert.equal(hours, 10);
        assert.equal(canAdjustFromOvertime(hours), true);
        assert.equal(canAdjustFromOvertime(9.99), false);

        const deducted = deductedCompOffHours(
            [{ statusKey: 'compoff_leave', compOff: { state: 'adjusted', chargeMonth: '2026-10', otHoursDeducted: 10 } }],
            '2026-10',
        );
        assert.equal(deducted, 10);
        assert.equal(canAdjustFromOvertime(hours - deducted), false);
    });
});
