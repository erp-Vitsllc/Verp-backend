import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { quotationChanges, savedQuotation, snapshotFromEstimate } from './workOrderQuotationSync.js';

const live = {
    number: 'DXB-VEGA-007276',
    id: 'est-1',
    date: '2026-11-19',
    customerName: 'CASH CUSTOMER',
    projectName: 'Tilal Al Ghaf',
    salespersonName: 'Raseel Muhammad',
    valueExclVat: 100,
    vatAmount: 5,
    total: 105,
    status: 'draft',
    notes: 'Warranty: 1 year',
    terms: '100% Advance',
    lines: [{ description: 'Roller tube', quantity: 1, rate: 75, amount: 75 }],
};

describe('quotationChanges', () => {
    it('reports no change when the saved snapshot matches Zoho', () => {
        const saved = snapshotFromEstimate(live);
        assert.deepEqual(quotationChanges(saved, snapshotFromEstimate(live)), []);
    });

    it('lists only the fields Zoho changed', () => {
        const saved = snapshotFromEstimate(live);
        const next = snapshotFromEstimate({ ...live, total: 210, vatAmount: 10, valueExclVat: 200, date: '2026-11-20' });
        const labels = quotationChanges(saved, next).map((row) => row.label);
        assert.deepEqual(labels, ['Quotation date', 'Amount excl. VAT', 'VAT', 'Total']);
    });

    it('ignores line-only differences when lines were never stored', () => {
        const saved = savedQuotation({
            quotationRef: live.number,
            quotationDate: live.date,
            customer: live.customerName,
            valueExclVat: live.valueExclVat,
            vatAmount: live.vatAmount,
            value: live.total,
        });
        assert.equal(saved.linesCaptured, false);
        assert.deepEqual(quotationChanges(saved, snapshotFromEstimate(live)), []);
    });

    it('notices a line change after the quotation was captured', () => {
        const saved = snapshotFromEstimate(live);
        const next = snapshotFromEstimate({
            ...live,
            lines: [{ description: 'Roller tube', quantity: 2, rate: 75, amount: 150 }],
        });
        assert.equal(quotationChanges(saved, next).some((row) => row.label === 'Line items'), true);
    });
});
