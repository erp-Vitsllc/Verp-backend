import crypto from 'crypto';

/**
 * When no app secret is configured, signatures are not checked.
 * A configured secret must match Meta's X-Hub-Signature-256 header.
 */
export function whatsAppSignatureMatches(rawBody, header, secret) {
    const key = String(secret || '').trim();
    if (!key) return true;

    const given = String(header || '');
    if (!given.startsWith('sha256=') || rawBody == null) return false;

    const expected = crypto.createHmac('sha256', key).update(rawBody).digest('hex');
    const received = given.slice('sha256='.length);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const receivedBuf = Buffer.from(received, 'utf8');
    if (expectedBuf.length !== receivedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}
