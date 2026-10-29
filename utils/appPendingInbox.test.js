import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    appInboxChannel,
    isActionableAppInboxRow,
    presentAppInboxRow,
    tagAppAcceptChannel,
} from './appPendingInbox.js';

describe('appInboxChannel', () => {
    it('opens the app inbox only when web is off and app is on', () => {
        assert.equal(appInboxChannel({ loginThrough: { portalApp: true, web: false } }), 'app');
        assert.equal(appInboxChannel({ loginThrough: { portalApp: true, web: true } }), null);
        assert.equal(appInboxChannel({ loginThrough: { portalApp: false, web: false } }), null);
    });
});

describe('isActionableAppInboxRow', () => {
    it('keeps a pending leave request', () => {
        assert.equal(
            isActionableAppInboxRow({
                status: 'Pending',
                requestType: 'Employee Leave Request',
                extra2: 'Annual leave request',
            }),
            true,
        );
    });

    it('drops an accepted assignment notice and an assigner copy', () => {
        assert.equal(
            isActionableAppInboxRow({
                status: 'Pending',
                requestType: 'Asset Assignment',
                extra2: 'Assignment accepted',
                extra3: JSON.stringify({ assignmentOutcome: true, outcome: 'accept' }),
            }),
            false,
        );
        assert.equal(
            isActionableAppInboxRow({
                status: 'Pending',
                requestType: 'Asset Assignment',
                extra3: JSON.stringify({ handoverViewerRole: 'assigner' }),
            }),
            false,
        );
    });
});

describe('presentAppInboxRow', () => {
    it('marks the row for the app and keeps the request type', () => {
        const row = presentAppInboxRow({
            _id: 'abc',
            requestId: 'req1',
            requestType: 'Employee Leave Request',
            extra1: '2026-10-28',
            extra2: 'Annual leave request for 2026-10-28',
            extra3: JSON.stringify({ leaveDashboard: true }),
            requestedByName: 'Sam',
            requestedDate: '2026-10-28T00:00:00.000Z',
        });
        const extra3 = JSON.parse(row.extra3);
        assert.equal(row.requestType, 'Employee Leave Request');
        assert.equal(extra3.acceptChannel, 'app');
        assert.equal(extra3.leaveDashboard, true);
        assert.equal(extra3.assignmentRequest, undefined);
        assert.equal(tagAppAcceptChannel('plain note'), JSON.stringify({ text: 'plain note', acceptChannel: 'app' }));
    });
});
