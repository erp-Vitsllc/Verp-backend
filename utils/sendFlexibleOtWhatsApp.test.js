import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFlexibleOtWhatsAppText } from './sendFlexibleOtWhatsApp.js';

describe('buildFlexibleOtWhatsAppText', () => {
    it('tells the employee the hours HR approved and the month total', () => {
        const text = buildFlexibleOtWhatsAppText({
            firstName: 'Ahmed',
            approvedHours: 4,
            monthTotalHours: 10,
        });
        assert.equal(
            text,
            'Hello Ahmed, you have approved 4 hrs OT. Total OT is 10 hrs.',
        );
    });

    it('uses the singular hour label and keeps the name on one line', () => {
        const text = buildFlexibleOtWhatsAppText({
            firstName: 'Sara\nAli <tag>',
            approvedHours: 1,
            monthTotalHours: 1,
        });
        assert.equal(
            text,
            'Hello Sara Ali tag, you have approved 1 hr OT. Total OT is 1 hr.',
        );
        assert.doesNotMatch(text, /Present|comp off|leave|VITS|971|\d{8,}/i);
    });
});
