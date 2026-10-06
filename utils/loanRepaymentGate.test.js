import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectBlockingLoan } from './loanRepaymentGate.js';

function record(overrides) {
    return {
        _id: overrides.id,
        loanId: overrides.loanId,
        type: overrides.type,
        status: overrides.status,
        approvalStatus: overrides.status,
        amount: overrides.amount ?? 1000,
        repaidAmount: overrides.repaidAmount ?? 0,
    };
}

describe('same-type loan and advance gate', () => {
    const unpaidAdvance = record({
        id: 'adv-1',
        loanId: 'VEGA-ADV-0001',
        type: 'Advance',
        status: 'Approved',
    });
    const unpaidLoan = record({
        id: 'lon-1',
        loanId: 'VEGA-LON-0001',
        type: 'Loan',
        status: 'Paid',
        repaidAmount: 200,
    });
    const repaidAdvance = record({
        id: 'adv-2',
        loanId: 'VEGA-ADV-0002',
        type: 'Advance',
        status: 'Paid',
        repaidAmount: 1000,
    });

    it('lets an employee with an advance apply for a loan', () => {
        assert.equal(selectBlockingLoan([unpaidAdvance], { type: 'Loan' }), null);
    });

    it('lets an employee with a loan apply for an advance', () => {
        assert.equal(selectBlockingLoan([unpaidLoan], { type: 'Advance' }), null);
    });

    it('blocks a second advance while the first is unpaid', () => {
        const blocking = selectBlockingLoan([unpaidAdvance, unpaidLoan], { type: 'Advance' });
        assert.equal(blocking.loanId, 'VEGA-ADV-0001');
    });

    it('blocks a second loan while the first is unpaid', () => {
        const blocking = selectBlockingLoan([unpaidAdvance, unpaidLoan], { type: 'Loan' });
        assert.equal(blocking.loanId, 'VEGA-LON-0001');
    });

    it('allows another advance after the previous advance is fully repaid', () => {
        assert.equal(selectBlockingLoan([repaidAdvance], { type: 'Advance' }), null);
    });

    it('does not treat the record being edited as a blocker', () => {
        assert.equal(
            selectBlockingLoan([unpaidAdvance], { type: 'Advance', excludeId: 'adv-1' }),
            null,
        );
    });
});
