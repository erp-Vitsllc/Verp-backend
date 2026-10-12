import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFlexibleOtWhatsAppText } from './sendFlexibleOtWhatsApp.js';

describe('buildFlexibleOtWhatsAppText', () => {
    it('tells the employee which day HR set as Present', () => {
        const text = buildFlexibleOtWhatsAppText({
            firstName: 'Ahmed',
            sourceDate: '2026-10-11',
            nextDayPresent: true,
            nextDayDate: '2026-10-13',
            remainderHours: 0,
        });
        assert.equal(
            text,
            'Hello Ahmed, HR set 13 Oct 2026 as Present from your overtime on 11 Oct 2026.',
        );
    });

    it('includes leftover overtime when the present day does not use every hour', () => {
        const text = buildFlexibleOtWhatsAppText({
            firstName: 'Ahmed',
            sourceDate: '2026-10-11',
            nextDayPresent: true,
            nextDayDate: '2026-10-13',
            remainderHours: 2,
        });
        assert.equal(
            text,
            'Hello Ahmed, HR set 13 Oct 2026 as Present from your overtime on 11 Oct 2026. Remaining overtime on that day: 2 hours.',
        );
    });

    it('tells the employee the overtime hours HR set', () => {
        const text = buildFlexibleOtWhatsAppText({
            firstName: 'Ahmed',
            sourceDate: '2026-10-11',
            nextDayPresent: false,
            approvedHours: 4,
        });
        assert.equal(text, 'Hello Ahmed, HR set your overtime for 11 Oct 2026: 4 hours.');
    });

    it('keeps the notice to the decision and leaves out employee codes', () => {
        const text = buildFlexibleOtWhatsAppText({
            firstName: 'Sara\nAli <tag>',
            sourceDate: '2026-10-01',
            approvedHours: 1,
        });
        assert.equal(text, 'Hello Sara Ali tag, HR set your overtime for 1 Oct 2026: 1 hour.');
        assert.doesNotMatch(text, /VITS|971|\d{8,}/);
    });
});
