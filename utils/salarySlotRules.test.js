import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    salaryMonthPaymentLabel,
    singleSlotPayType,
    slotHoldsEmployees,
    slotIsPaid,
    slotStatusOf,
} from './salarySlotRules.js';

describe('salary slot rules', () => {
    it('allows one pay type in a slot', () => {
        assert.deepEqual(singleSlotPayType(['WPS', 'WPS']), { ok: true, method: 'WPS', message: '' });
        assert.equal(singleSlotPayType(['Cash', 'WPS']).ok, false);
    });

    it('keeps draft and applied employees on that month slot only', () => {
        assert.equal(slotHoldsEmployees({ status: 'draft' }), true);
        assert.equal(slotHoldsEmployees({ status: 'pending_hr' }), true);
        assert.equal(slotHoldsEmployees({ status: 'pending_wps' }), true);
        assert.equal(slotHoldsEmployees({ status: 'pending_update' }), true);
        assert.equal(slotHoldsEmployees({ status: 'approved' }), true);
        assert.equal(slotIsPaid({ status: 'pending_wps' }), false);
        assert.equal(slotIsPaid({ status: 'pending_update' }), false);
        assert.equal(slotHoldsEmployees({ status: 'cancelled' }), false);
        assert.equal(slotStatusOf({}), 'approved');
        assert.equal(slotIsPaid({}), true);
        assert.equal(slotIsPaid({ status: 'draft' }), false);
    });

    it('labels month payment from green slots and enrolled employees', () => {
        const enrolled = ['E1', 'E2'];
        assert.equal(
            salaryMonthPaymentLabel({
                enrolledIds: enrolled,
                slots: [
                    { status: 'approved', employeeIds: ['E1'] },
                    { status: 'approved', employeeIds: ['E2'] },
                ],
            }),
            'Paid',
        );
        assert.equal(
            salaryMonthPaymentLabel({
                enrolledIds: enrolled,
                slots: [{ status: 'approved', employeeIds: ['E1'] }],
            }),
            'Partially paid',
        );
        assert.equal(
            salaryMonthPaymentLabel({
                enrolledIds: enrolled,
                slots: [{ status: 'pending_hr', employeeIds: ['E1', 'E2'] }],
            }),
            'Not paid',
        );
        assert.equal(salaryMonthPaymentLabel({ enrolledIds: enrolled, slots: [] }), 'Not paid');
    });
});
