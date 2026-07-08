import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'zoho-tokens.json');
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function getOAuthStateSecret() {
    return (
        process.env.ZOHO_CLIENT_SECRET ||
        process.env.JWT_SECRET ||
        'zoho-oauth-state-secret'
    );
}

async function ensureDataDir() {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readZohoTokens() {
    try {
        const raw = await fs.readFile(TOKEN_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

export async function writeZohoTokens(tokens) {
    await ensureDataDir();
    const payload = {
        ...tokens,
        updated_at: Date.now(),
    };
    await fs.writeFile(TOKEN_FILE, JSON.stringify(payload, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
    });
}

export async function clearZohoTokens() {
    try {
        await fs.unlink(TOKEN_FILE);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

export function issueOAuthState() {
    const payload = {
        nonce: crypto.randomBytes(16).toString('hex'),
        exp: Date.now() + OAUTH_STATE_TTL_MS,
    };
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
        .createHmac('sha256', getOAuthStateSecret())
        .update(data)
        .digest('base64url');
    return `${data}.${signature}`;
}

export function validateOAuthState(receivedState) {
    const state = String(receivedState || '').trim();
    if (!state) return false;

    const separatorIndex = state.lastIndexOf('.');
    if (separatorIndex <= 0) return false;

    const data = state.slice(0, separatorIndex);
    const signature = state.slice(separatorIndex + 1);
    const expectedSignature = crypto
        .createHmac('sha256', getOAuthStateSecret())
        .update(data)
        .digest('base64url');

    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (
        signatureBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
        return false;
    }

    try {
        const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
        return Number(payload.exp) > Date.now();
    } catch {
        return false;
    }
}
