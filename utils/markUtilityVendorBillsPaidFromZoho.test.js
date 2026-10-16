import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    isZohoBillFullyPaid,
    zohoBillMatchesDisplayedNumber,
} from './markUtilityVendorBillsPaidFromZoho.js';

describe('isZohoBillFullyPaid', () => {
    it('treats Zoho status paid as paid', () => {
        assert.equal(isZohoBillFullyPaid({ status: 'paid', balance: 0, total: 108.87 }), true);
    });

    it('treats a cleared balance as paid even when status is still partially paid', () => {
        assert.equal(
            isZohoBillFullyPaid({ status: 'partially_paid', balance: 0, total: 108.87 }),
            true,
        );
    });

    it('keeps an open balance unpaid', () => {
        assert.equal(
            isZohoBillFullyPaid({ status: 'open', balance: 108.87, total: 108.87 }),
            false,
        );
    });

    it('uses applied payments when status has not flipped yet', () => {
        assert.equal(
            isZohoBillFullyPaid({
                status: 'open',
                total: 108.87,
                balance: 108.87,
                payments: [{ amount_applied: 108.87 }],
            }),
            true,
        );
    });

    it('does not treat the word unpaid as paid', () => {
        assert.equal(
            isZohoBillFullyPaid({ status: 'unpaid', balance: 50, total: 50 }),
            false,
        );
    });

    it('treats a tax-inclusive Zoho bill with balance 0 as paid', () => {
        assert.equal(
            isZohoBillFullyPaid({
                status: 'open',
                balance: 0,
                total: 140.56,
                sub_total: 133.87,
                bill_number: 'INV2049058048',
            }),
            true,
        );
    });
});

describe('zohoBillMatchesDisplayedNumber', () => {
    it('matches the Serial No. custom field shown on the utility card', () => {
        assert.equal(
            zohoBillMatchesDisplayedNumber(
                {
                    bill_number: 'INV2049058048',
                    custom_fields: [{ label: 'Serial No.', value: 'VITS-Bills-012574' }],
                },
                'VITS-Bills-012574',
            ),
            true,
        );
    });

    it('does not match a different bill number', () => {
        assert.equal(
            zohoBillMatchesDisplayedNumber(
                { bill_number: 'INV2049058048' },
                'VITS-Bills-012574',
            ),
            false,
        );
    });
});
