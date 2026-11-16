import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { billsFromServiceRemark, isPendingVendorBill, zohoBooksBillUrl } from './erpVendorZohoBills.js';

describe('zohoBooksBillUrl', () => {
    it('builds the Zoho Books bill link from the accounts host', () => {
        const previous = process.env.ZOHO_ACCOUNTS_BASE_URL;
        process.env.ZOHO_ACCOUNTS_BASE_URL = 'https://accounts.zoho.com';
        try {
            assert.equal(
                zohoBooksBillUrl('2001', '9988'),
                'https://books.zoho.com/app/2001#/bills/9988',
            );
        } finally {
            if (previous == null) delete process.env.ZOHO_ACCOUNTS_BASE_URL;
            else process.env.ZOHO_ACCOUNTS_BASE_URL = previous;
        }
    });
});

describe('billsFromServiceRemark', () => {
    it('keeps Zoho bills created for this vendor and skips other vendors', () => {
        const remark = JSON.stringify({
            zohoVendorId: 'vendor-a',
            zohoBills: [
                {
                    zohoBillId: 'b1',
                    zohoVendorId: 'vendor-a',
                    billNumber: 'ERP-1',
                    zohoBillNumber: 'VITS-Bills-1',
                    billDate: '2026-01-02',
                    garageBillAmount: 50,
                },
                {
                    zohoBillId: 'b2',
                    zohoVendorId: 'vendor-b',
                    billNumber: 'ERP-2',
                    garageBillAmount: 80,
                },
            ],
        });
        const bills = [...billsFromServiceRemark(remark, { assetId: 'VH-1' }, new Set(['vendor-a'])).values()];
        assert.equal(bills.length, 1);
        assert.equal(bills[0].zohoBillId, 'b1');
        assert.equal(bills[0].billNumber, 'VITS-Bills-1');
        assert.equal(bills[0].referenceNumber, 'ERP-1');
        assert.equal(bills[0].total, 50);
        assert.equal(bills[0].source, 'Vehicle service');
    });

    it('counts unpaid and open bills and skips paid or void bills', () => {
        assert.equal(isPendingVendorBill({ status: 'Pending' }), true);
        assert.equal(isPendingVendorBill({ status: 'open', balance: 25 }), true);
        assert.equal(isPendingVendorBill({ status: 'paid', balance: 0 }), false);
        assert.equal(isPendingVendorBill({ status: 'void', balance: 10 }), false);
        assert.equal(isPendingVendorBill({ status: '', balance: 0 }), false);
        assert.equal(isPendingVendorBill({ status: '', balance: 12.5 }), true);
    });

    it('ignores a service that was not posted to Zoho', () => {
        const bills = billsFromServiceRemark(
            { zohoVendorId: 'vendor-a', billNumber: 'X' },
            {},
            new Set(['vendor-a']),
        );
        assert.equal(bills.size, 0);
    });
});
