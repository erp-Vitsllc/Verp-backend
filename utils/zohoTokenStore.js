import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data');
const LEGACY_TOKEN_FILE = path.join(DATA_DIR, 'zoho-tokens.json');
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function getOAuthStateSecret() {
    return (
        process.env.ZOHO_CLIENT_SECRET ||
        process.env.JWT_SECRET ||
        'zoho-oauth-state-secret'
    );
}

function sanitizeOrgIdForFile(organizationId) {
    const id = String(organizationId || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_');
    return id || 'default';
}

export function zohoTokenFilePath(organizationId) {
    const id = String(organizationId || '').trim();
    if (!id) return LEGACY_TOKEN_FILE;
    return path.join(DATA_DIR, `zoho-tokens-${sanitizeOrgIdForFile(id)}.json`);
}

async function ensureDataDir() {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJsonFile(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

/**
 * Read tokens for a Zoho Books organization.
 * Falls back to default/legacy tokens when the org file is missing — same Zoho
 * login often has access to both VEGA + NNIT Books orgs with one OAuth grant.
 */
export async function readZohoTokens(organizationId = '') {
    const orgId = String(organizationId || '').trim();
    const primary = zohoTokenFilePath(orgId);
    const fromPrimary = await readJsonFile(primary);
    if (fromPrimary?.access_token || fromPrimary?.refresh_token) return fromPrimary;

    const defaultOrg = String(process.env.ZOHO_ORGANIZATION_ID || '').trim();
    if (orgId && defaultOrg && orgId === defaultOrg) {
        const legacy = await readJsonFile(LEGACY_TOKEN_FILE);
        if (legacy?.access_token || legacy?.refresh_token) return legacy;
    }
    if (!orgId) {
        return readJsonFile(LEGACY_TOKEN_FILE);
    }

    // Cross-org fallback: reuse any connected token from this Zoho account.
    if (defaultOrg && defaultOrg !== orgId) {
        const fromDefault = await readJsonFile(zohoTokenFilePath(defaultOrg));
        if (fromDefault?.access_token || fromDefault?.refresh_token) return fromDefault;
        const legacy = await readJsonFile(LEGACY_TOKEN_FILE);
        if (legacy?.access_token || legacy?.refresh_token) return legacy;
    }

    const all = await listZohoTokenOrganizations();
    const other = all.find(
        (row) =>
            row.connected &&
            String(row.organizationId || '').trim() &&
            String(row.organizationId).trim() !== orgId,
    );
    if (other?.organizationId) {
        const shared = await readJsonFile(zohoTokenFilePath(other.organizationId));
        if (shared?.access_token || shared?.refresh_token) return shared;
    }

    return fromPrimary;
}

export async function writeZohoTokens(tokens, organizationId = '') {
    await ensureDataDir();
    const orgId = String(organizationId || tokens?.organization_id || '').trim();
    const payload = {
        ...tokens,
        organization_id: orgId || tokens?.organization_id || '',
        updated_at: Date.now(),
    };
    const filePath = zohoTokenFilePath(orgId || process.env.ZOHO_ORGANIZATION_ID || '');
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
    });

    // Keep legacy file in sync for the default org (older code paths / first setup).
    const defaultOrg = String(process.env.ZOHO_ORGANIZATION_ID || '').trim();
    if (orgId && defaultOrg && orgId === defaultOrg) {
        await fs.writeFile(LEGACY_TOKEN_FILE, JSON.stringify(payload, null, 2), {
            encoding: 'utf8',
            mode: 0o600,
        });
    }
}

export async function clearZohoTokens(organizationId = '') {
    const orgId = String(organizationId || '').trim();
    const targets = [zohoTokenFilePath(orgId)];
    const defaultOrg = String(process.env.ZOHO_ORGANIZATION_ID || '').trim();
    if (!orgId || (defaultOrg && orgId === defaultOrg)) {
        targets.push(LEGACY_TOKEN_FILE);
    }
    for (const filePath of targets) {
        try {
            await fs.unlink(filePath);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

/** List connected org token files (for status UI). */
export async function listZohoTokenOrganizations() {
    await ensureDataDir();
    const names = await fs.readdir(DATA_DIR).catch(() => []);
    const orgs = [];

    for (const name of names) {
        if (name === 'zoho-tokens.json') {
            const data = await readJsonFile(LEGACY_TOKEN_FILE);
            const orgId =
                String(data?.organization_id || process.env.ZOHO_ORGANIZATION_ID || '').trim() ||
                'default';
            orgs.push({
                organizationId: orgId,
                connected: Boolean(data?.refresh_token || data?.access_token),
                updatedAt: data?.updated_at || null,
                file: 'zoho-tokens.json',
            });
            continue;
        }
        const match = /^zoho-tokens-(.+)\.json$/i.exec(name);
        if (!match) continue;
        const filePath = path.join(DATA_DIR, name);
        const data = await readJsonFile(filePath);
        const organizationId = String(data?.organization_id || match[1] || '').trim();
        orgs.push({
            organizationId,
            connected: Boolean(data?.refresh_token || data?.access_token),
            updatedAt: data?.updated_at || null,
            file: name,
        });
    }

    // Dedupe by organizationId (prefer per-org file over legacy)
    const byId = new Map();
    for (const row of orgs) {
        const key = row.organizationId || 'default';
        const prev = byId.get(key);
        if (!prev || row.file !== 'zoho-tokens.json') {
            byId.set(key, row);
        }
    }
    return Array.from(byId.values());
}

export function issueOAuthState({ organizationId = '' } = {}) {
    const payload = {
        nonce: crypto.randomBytes(16).toString('hex'),
        exp: Date.now() + OAUTH_STATE_TTL_MS,
        organizationId: String(organizationId || '').trim(),
    };
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
        .createHmac('sha256', getOAuthStateSecret())
        .update(data)
        .digest('base64url');
    return `${data}.${signature}`;
}

/**
 * @returns {{ ok: true, organizationId: string } | { ok: false }}
 */
export function validateOAuthState(receivedState) {
    const state = String(receivedState || '').trim();
    if (!state) return { ok: false };

    const separatorIndex = state.lastIndexOf('.');
    if (separatorIndex <= 0) return { ok: false };

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
        return { ok: false };
    }

    try {
        const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
        if (!(Number(payload.exp) > Date.now())) return { ok: false };
        return {
            ok: true,
            organizationId: String(payload.organizationId || '').trim(),
        };
    } catch {
        return { ok: false };
    }
}
