import assert from 'node:assert/strict';
import test from 'node:test';
import {
    QUOTE_NOT_APPROVED,
    QUOTE_OLDER_THAN_THREE_MONTHS,
    quoteImportBlockReason,
} from './zohoService.js';

const today = '2026-11-28';

test('an approved quote from the last 3 months can be added', () => {
    assert.equal(quoteImportBlockReason({ status: 'approved', date: '2026-08-28' }, today), '');
    assert.equal(quoteImportBlockReason({ status: 'Approved', date: '2026-11-01' }, today), '');
});

test('a quote that is not approved is blocked', () => {
    assert.equal(quoteImportBlockReason({ status: 'sent', date: '2026-11-01' }, today), QUOTE_NOT_APPROVED);
    assert.equal(quoteImportBlockReason({ status: 'draft', date: '2026-11-01' }, today), QUOTE_NOT_APPROVED);
    assert.equal(quoteImportBlockReason({ status: '', date: '2026-11-01' }, today), QUOTE_NOT_APPROVED);
});

test('an approved quote older than 3 months is blocked', () => {
    assert.equal(
        quoteImportBlockReason({ status: 'approved', date: '2026-08-27' }, today),
        QUOTE_OLDER_THAN_THREE_MONTHS,
    );
    assert.equal(
        quoteImportBlockReason({ status: 'approved', date: '' }, today),
        QUOTE_OLDER_THAN_THREE_MONTHS,
    );
});
