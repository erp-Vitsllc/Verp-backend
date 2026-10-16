import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    entryDetailsEqual,
    openUtilityBillMonthKey,
    planUtilityEntryDetailRevisions,
    UTILITY_DETAIL_BASELINE_MONTH,
} from './utilityEntryDetailRevision.js';

const before = {
    values: { accountNumber: '0521981385', monthlyRental: 50, provider: 'Etisalat' },
    assignedTo: 'ZEESHAN MUHAMMAD',
    assignedToType: 'Employee',
    assignedToId: 'VEGA-HR-00018',
};

const after = {
    values: { accountNumber: '0500000000', monthlyRental: 80, provider: 'Du' },
    assignedTo: 'FARSANA ASHRAF',
    assignedToType: 'Employee',
    assignedToId: 'VEGA-HR-00035',
};

describe('utility entry detail revisions', () => {
    it('opens the previous Dubai calendar month', () => {
        assert.equal(openUtilityBillMonthKey(new Date('2026-10-16T08:00:00Z')), '2026-09');
    });

    it('does nothing when details are unchanged', () => {
        assert.equal(
            planUtilityEntryDetailRevisions({
                before,
                after: { ...before, values: { ...before.values } },
                currentMonth: '2026-09',
                hasExistingRevisions: false,
            }).length,
            0,
        );
        assert.equal(entryDetailsEqual(before, { ...before, values: { ...before.values } }), true);
    });

    it('freezes every earlier month on the first change and writes the open month', () => {
        const writes = planUtilityEntryDetailRevisions({
            before,
            after,
            currentMonth: '2026-09',
            hasExistingRevisions: false,
        });
        assert.equal(writes.length, 2);
        assert.equal(writes[0].fromMonth, UTILITY_DETAIL_BASELINE_MONTH);
        assert.equal(writes[0].assignedTo, 'ZEESHAN MUHAMMAD');
        assert.equal(writes[0].values.monthlyRental, 50);
        assert.equal(writes[1].fromMonth, '2026-09');
        assert.equal(writes[1].assignedTo, 'FARSANA ASHRAF');
        assert.equal(writes[1].values.accountNumber, '0500000000');
    });

    it('updates only the open month after history already exists', () => {
        const writes = planUtilityEntryDetailRevisions({
            before,
            after,
            currentMonth: '2026-10',
            hasExistingRevisions: true,
        });
        assert.equal(writes.length, 1);
        assert.equal(writes[0].fromMonth, '2026-10');
        assert.equal(writes[0].values.monthlyRental, 80);
    });

    it('ignores attachment file bytes when nothing else changed', () => {
        const withFile = {
            ...before,
            values: {
                ...before.values,
                attachment: { name: 'plan.pdf', dataUrl: 'data:application/pdf;base64,AAA' },
            },
        };
        const sameFileNewBytes = {
            ...before,
            values: {
                ...before.values,
                attachment: { name: 'plan.pdf', dataUrl: 'data:application/pdf;base64,BBB' },
            },
        };
        assert.equal(entryDetailsEqual(withFile, sameFileNewBytes), true);
    });
});
