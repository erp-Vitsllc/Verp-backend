import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lpoNotFilledNotice } from './sendWorkOrderLpoEmail.js';

describe('lpoNotFilledNotice', () => {
    it('tells the salesperson the LPO fields were left empty', () => {
        const notice = lpoNotFilledNotice({
            senderName: 'Sara Ali',
            workOrderNo: 'WO-2026-001',
            customer: 'Emaar Properties',
        });
        assert.equal(notice.extra1, 'LPO was not filled on WO-2026-001');
        assert.match(notice.message, /Sara Ali did not fill the LPO on WO-2026-001 for Emaar Properties/);
        assert.match(notice.message, /Number, date and value were left empty/);
        assert.match(notice.extra2, /Emaar Properties/);
    });
});
