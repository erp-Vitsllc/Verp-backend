import assert from 'node:assert/strict';
import test from 'node:test';
import {
    clearZohoOrganizationRateLimit,
    isZohoBooksRateLimitError,
    noteZohoOrganizationRateLimit,
    zohoOrganizationRateLimitMessage,
    zohoRateLimitHoldMs,
} from '../services/zohoService.js';

test('Zoho code 45 does not lock later calls inside ERP', () => {
    const message = 'The API call for this organization has exceeded the maximum call rate limit of 5,000';
    assert.equal(isZohoBooksRateLimitError({ message, zohoCode: 45 }), true);
    assert.equal(zohoRateLimitHoldMs(message, 45), 0);

    const organizationId = 'org-rate-limit-test';
    clearZohoOrganizationRateLimit(organizationId);
    noteZohoOrganizationRateLimit(organizationId, message, 45);
    assert.equal(zohoOrganizationRateLimitMessage(organizationId), '');
});
