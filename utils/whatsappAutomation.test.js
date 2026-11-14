import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bufferLooksLikePdf } from '../services/whatsappService.js';
import { fitTemplateParams, whatsAppTemplateParam } from './whatsappAutomation.js';

describe('WhatsApp template parameters', () => {
    it('keeps one line and uses a fallback when the value is blank', () => {
        assert.equal(whatsAppTemplateParam('Sara\nAli\tKhan'), 'Sara Ali Khan');
        assert.equal(whatsAppTemplateParam('   ', 'this month'), 'this month');
    });

    it('fits the value list to the number of blanks in the template', () => {
        assert.deepEqual(fitTemplateParams(['Ahmed', '4 hrs', 'extra'], 2), ['Ahmed', '4 hrs']);
        assert.deepEqual(fitTemplateParams(['Ahmed'], 2), ['Ahmed', '-']);
        assert.deepEqual(fitTemplateParams([], 0), []);
    });
});

describe('PDF attachment check', () => {
    it('accepts a PDF marker in the first part of the file', () => {
        assert.equal(bufferLooksLikePdf(Buffer.from('%PDF-1.4\n')), true);
        assert.equal(bufferLooksLikePdf(Buffer.concat([Buffer.from('\n'), Buffer.from('%PDF-1.4')])), true);
        assert.equal(bufferLooksLikePdf(Buffer.from('not a pdf')), false);
    });
});
