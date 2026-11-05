import assert from 'node:assert/strict';
import test from 'node:test';
import {
    clearZohoOrganizationRateLimit,
    isZohoBooksRateLimitError,
    noteZohoOrganizationRateLimit,
    zohoOrganizationRateLimitMessage,
    zohoRateLimitHoldMs,
} from '../services/zohoService.js';

test('Zoho code 45 is the 5,000-call allowance and is not retried in a minute', () => {
    const message = 'The API call for this organization has exceeded the maximum call rate limit of 5,000';
    assert.equal(isZohoBooksRateLimitError({ message, zohoCode: 45 }), true);
    assert.ok(zohoRateLimitHoldMs(message, 45) >= 60 * 60 * 1000);

    const organizationId = 'org-rate-limit-test';
    clearZohoOrganizationRateLimit(organizationId);
    noteZohoOrganizationRateLimit(organizationId, message, 45);
    assert.match(zohoOrganizationRateLimitMessage(organizationId), /5,000/);
    clearZohoOrganizationRateLimit(organizationId);
    assert.equal(zohoOrganizationRateLimitMessage(organizationId), '');
});
