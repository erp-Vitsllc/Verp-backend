import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLoanRepaymentPayment, loanRecoveredAmount } from './loanRecoveredAmount.js';

const advance = {
    _id: 'loan-1',
    loanId: 'VEGA-ADV-0004',
    amount: 5000,
    paidAmount: 5000,
    repaidAmount: 5000,
};

describe('loanRecoveredAmount', () => {
    it('does not add the company payout to the amount the employee paid back', () => {
        const payments = [
            {
                relatedEntityType: 'Advance',
                paymentType: 'Advance',
                relatedEntityId: 'loan-1',
                referenceId: 'VEGA-ADV-0004',
                amount: 5000,
            },
            {
                relatedEntityType: 'AdvanceRepayment',
                paymentType: 'Advance',
                relatedEntityId: 'loan-1',
                referenceId: 'VEGA-ADV-0004',
                amount: 5000,
            },
        ];

        assert.equal(isLoanRepaymentPayment(payments[0], advance), false);
        assert.equal(isLoanRepaymentPayment(payments[1], advance), true);
        assert.equal(loanRecoveredAmount(advance, payments), 5000);
    });

    it('caps a doubled recovered total at the advance amount', () => {
        assert.equal(
            loanRecoveredAmount(
                { ...advance, repaidAmount: 10000 },
                [
                    {
                        relatedEntityType: 'AdvanceRepayment',
                        relatedEntityId: 'loan-1',
                        amount: 10000,
                    },
                ],
            ),
            5000,
        );
    });

    it('keeps a partial repayment below the advance amount', () => {
        assert.equal(
            loanRecoveredAmount(
                { ...advance, repaidAmount: 2000 },
                [
                    {
                        relatedEntityType: 'AdvanceRepayment',
                        relatedEntityId: 'loan-1',
                        amount: 2000,
                    },
                ],
            ),
            2000,
        );
    });
});
