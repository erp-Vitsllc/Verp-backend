import axios from 'axios';
import {
    readZohoTokens,
    writeZohoTokens,
    issueOAuthState,
    validateOAuthState,
} from '../utils/zohoTokenStore.js';

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_OAUTH_SCOPE = 'ZohoBooks.contacts.READ';

function getZohoConfig() {
    return {
        clientId: process.env.ZOHO_CLIENT_ID || '',
        clientSecret: process.env.ZOHO_CLIENT_SECRET || '',
        redirectUri: process.env.ZOHO_REDIRECT_URI || '',
        organizationId: process.env.ZOHO_ORGANIZATION_ID || '',
        oauthScope: process.env.ZOHO_OAUTH_SCOPE || DEFAULT_OAUTH_SCOPE,
        accountsBaseUrl: (process.env.ZOHO_ACCOUNTS_BASE_URL || 'https://accounts.zoho.com').replace(
            /\/$/,
            '',
        ),
        booksApiBase: (process.env.ZOHO_BOOKS_API_BASE || 'https://www.zohoapis.com/books/v3').replace(
            /\/$/,
            '',
        ),
    };
}

function assertOAuthConfig(config) {
    if (!config.clientId || !config.clientSecret || !config.redirectUri) {
        throw new Error(
            'Zoho OAuth is not configured. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REDIRECT_URI.',
        );
    }
}

function assertBooksConfig(config) {
    assertOAuthConfig(config);
    if (!config.organizationId) {
        throw new Error('Zoho Books organization is not configured. Set ZOHO_ORGANIZATION_ID.');
    }
}

function buildTokenPayload(tokenResponse, existing = {}) {
    const expiresIn = Number(tokenResponse?.expires_in) || 3600;
    const apiDomain = String(
        tokenResponse?.api_domain || existing?.api_domain || process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com',
    ).replace(/\/$/, '');

    return {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        expires_in: expiresIn,
        expires_at: Date.now() + expiresIn * 1000,
        api_domain: apiDomain,
    };
}

function resolveBooksApiBase(config, stored) {
    const apiDomain = String(
        stored?.api_domain || process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com',
    ).replace(/\/$/, '');

    if (process.env.ZOHO_BOOKS_API_BASE) {
        return config.booksApiBase;
    }

    return `${apiDomain}/books/v3`;
}

function resolveTokenExpiry(stored) {
    const expiresAt = Number(stored?.expires_at) || 0;
    if (expiresAt > 0) return expiresAt;

    const updatedAt = Number(stored?.updated_at) || 0;
    const expiresIn = Number(stored?.expires_in) || 3600;
    if (updatedAt > 0) return updatedAt + expiresIn * 1000;

    return 0;
}

export async function buildAuthorizationUrl() {
    const config = getZohoConfig();
    assertOAuthConfig(config);

    const state = issueOAuthState();
    const params = new URLSearchParams({
        scope: config.oauthScope,
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: config.redirectUri,
        access_type: 'offline',
        prompt: 'consent',
        state,
    });

    return {
        authorizationUrl: `${config.accountsBaseUrl}/oauth/v2/auth?${params.toString()}`,
        state,
        scope: config.oauthScope,
    };
}

export async function validateOAuthCallbackState(state) {
    const receivedState = String(state || '').trim();

    if (!receivedState) {
        throw new Error('Missing OAuth state parameter');
    }

    if (!validateOAuthState(receivedState)) {
        throw new Error('Invalid or expired OAuth state parameter');
    }
}

async function requestTokens(params, config) {
    const body = new URLSearchParams(params);
    const response = await axios.post(`${config.accountsBaseUrl}/oauth/v2/token`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
    });

    const data = response.data || {};
    if (!data.access_token) {
        throw new Error(data.error || data.message || 'Zoho token response did not include access_token');
    }

    return data;
}

export async function exchangeAuthorizationCode(code, { state } = {}) {
    const config = getZohoConfig();
    assertOAuthConfig(config);

    if (!code) {
        throw new Error('Authorization code is required');
    }

    await validateOAuthCallbackState(state);

    const tokenResponse = await requestTokens(
        {
            grant_type: 'authorization_code',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: config.redirectUri,
            code: String(code),
        },
        config,
    );

    const existing = (await readZohoTokens()) || {};
    const payload = buildTokenPayload(
        {
            ...tokenResponse,
            refresh_token: tokenResponse.refresh_token || existing.refresh_token,
        },
        existing,
    );

    if (!payload.refresh_token) {
        throw new Error(
            'Zoho did not return a refresh_token. Re-authorize with access_type=offline and prompt=consent.',
        );
    }

    await writeZohoTokens(payload);
    return payload;
}

async function refreshAccessToken(refreshToken) {
    const config = getZohoConfig();
    assertOAuthConfig(config);

    const tokenResponse = await requestTokens(
        {
            grant_type: 'refresh_token',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: refreshToken,
        },
        config,
    );

    const existing = (await readZohoTokens()) || {};
    const payload = buildTokenPayload(
        {
            ...tokenResponse,
            refresh_token: tokenResponse.refresh_token || refreshToken || existing.refresh_token,
        },
        existing,
    );

    await writeZohoTokens(payload);
    return payload.access_token;
}

export async function getAccessToken() {
    const config = getZohoConfig();
    assertOAuthConfig(config);

    const stored = await readZohoTokens();
    if (!stored?.refresh_token && !stored?.access_token) {
        throw new Error('Zoho is not connected. Complete OAuth authorization via /api/zoho/callback first.');
    }

    const expiresAt = resolveTokenExpiry(stored);
    const accessTokenStillValid =
        stored.access_token && expiresAt - TOKEN_EXPIRY_BUFFER_MS > Date.now();

    if (accessTokenStillValid) {
        return stored.access_token;
    }

    if (!stored.refresh_token) {
        throw new Error('Zoho refresh_token is missing. Re-authorize Zoho Books integration.');
    }

    return refreshAccessToken(stored.refresh_token);
}

export async function fetchVendors() {
    const config = getZohoConfig();
    assertBooksConfig(config);

    const stored = (await readZohoTokens()) || {};
    const booksApiBase = resolveBooksApiBase(config, stored);
    const accessToken = await getAccessToken();
    const vendors = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        let response;
        try {
            response = await axios.get(`${booksApiBase}/vendors`, {
                params: {
                    organization_id: config.organizationId,
                    page,
                    per_page: 200,
                },
                headers: {
                    Authorization: `Zoho-oauthtoken ${accessToken}`,
                },
                timeout: 30000,
            });
        } catch (error) {
            const zohoMessage = error?.response?.data?.message;
            throw new Error(zohoMessage || error?.message || 'Failed to fetch vendors from Zoho Books');
        }

        const data = response.data || {};
        if (Number(data.code) !== 0) {
            throw new Error(data.message || 'Failed to fetch vendors from Zoho Books');
        }

        const pageVendors = Array.isArray(data.contacts) ? data.contacts : [];
        vendors.push(...pageVendors);

        hasMore = Boolean(data.page_context?.has_more_page);
        page += 1;

        if (!pageVendors.length) {
            break;
        }
    }

    return vendors;
}

export async function fetchCustomers() {
    const config = getZohoConfig();
    assertBooksConfig(config);

    const stored = (await readZohoTokens()) || {};
    const booksApiBase = resolveBooksApiBase(config, stored);
    const accessToken = await getAccessToken();
    const customers = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        let response;
        try {
            response = await axios.get(`${booksApiBase}/customers`, {
                params: {
                    organization_id: config.organizationId,
                    page,
                    per_page: 200,
                },
                headers: {
                    Authorization: `Zoho-oauthtoken ${accessToken}`,
                },
                timeout: 30000,
            });
        } catch (error) {
            const zohoMessage = error?.response?.data?.message;
            throw new Error(zohoMessage || error?.message || 'Failed to fetch customers from Zoho Books');
        }

        const data = response.data || {};
        if (Number(data.code) !== 0) {
            throw new Error(data.message || 'Failed to fetch customers from Zoho Books');
        }

        const pageCustomers = Array.isArray(data.contacts) ? data.contacts : [];
        customers.push(...pageCustomers);

        hasMore = Boolean(data.page_context?.has_more_page);
        page += 1;

        if (!pageCustomers.length) {
            break;
        }
    }

    return customers;
}
