import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'locator-tokens.json');

async function ensureDataDir() {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readLocatorTokens() {
    try {
        const raw = await fs.readFile(TOKEN_FILE, 'utf8');
        if (!String(raw || '').trim()) {
            // Empty/corrupt session file — treat as logged out so login can rewrite it.
            await clearLocatorTokens().catch(() => {});
            return null;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.token) return null;
        return parsed;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        // Invalid JSON (e.g. truncated write) — clear and force a fresh Locator login.
        if (error instanceof SyntaxError) {
            await clearLocatorTokens().catch(() => {});
            return null;
        }
        throw error;
    }
}

export async function writeLocatorTokens(tokens) {
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

export async function clearLocatorTokens() {
    try {
        await fs.unlink(TOKEN_FILE);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}
