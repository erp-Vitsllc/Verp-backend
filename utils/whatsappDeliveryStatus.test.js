import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { formatWhatsAppFailure, shouldApplyWhatsAppStatus } from './whatsappMessageLog.js';
import { whatsAppSignatureMatches } from './whatsappWebhookSignature.js';

describe('WhatsApp delivery status order', () => {
    it('keeps delivered and read ahead of an older sent receipt', () => {
        assert.equal(shouldApplyWhatsAppStatus('delivered', 'sent'), false);
        assert.equal(shouldApplyWhatsAppStatus('read', 'delivered'), false);
        assert.equal(shouldApplyWhatsAppStatus('sent', 'delivered'), true);
        assert.equal(shouldApplyWhatsAppStatus('delivered', 'read'), true);
    });

    it('records a failure only before delivery is confirmed', () => {
        assert.equal(shouldApplyWhatsAppStatus('sent', 'failed'), true);
        assert.equal(shouldApplyWhatsAppStatus('delivered', 'failed'), false);
        assert.equal(shouldApplyWhatsAppStatus('read', 'failed'), false);
    });
});

describe('WhatsApp failure text', () => {
    it('keeps the Meta error code with the message', () => {
        assert.equal(formatWhatsAppFailure('Message undeliverable', 131026), '[131026] Message undeliverable');
        assert.equal(formatWhatsAppFailure('(#131047) Re-engagement message', 131047), '(#131047) Re-engagement message');
    });
});

describe('WhatsApp webhook signature', () => {
    it('accepts a matching signature and rejects a wrong one', () => {
        const secret = 'test-secret';
        const body = Buffer.from('{"object":"whatsapp_business_account"}');
        const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
        assert.equal(whatsAppSignatureMatches(body, `sha256=${digest}`, secret), true);
        assert.equal(whatsAppSignatureMatches(body, 'sha256=deadbeef', secret), false);
    });

    it('does not enforce a signature until an app secret is configured', () => {
        assert.equal(whatsAppSignatureMatches(Buffer.from('{}'), '', ''), true);
    });
});
