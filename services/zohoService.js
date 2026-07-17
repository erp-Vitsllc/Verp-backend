import axios from 'axios';
import {
    readZohoTokens,
    writeZohoTokens,
    issueOAuthState,
    validateOAuthState,
} from '../utils/zohoTokenStore.js';

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_OAUTH_SCOPE = [
    'ZohoBooks.contacts.READ',
    'ZohoBooks.vendorpayments.READ',
    'ZohoBooks.vendorpayments.CREATE',
    'ZohoBooks.bills.READ',
    'ZohoBooks.expenses.READ',
    'ZohoBooks.accountants.READ',
    'ZohoBooks.settings.READ',
].join(',');

export function getZohoConfig() {
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

export function getZohoOrganizationId() {
    const organizationId = String(getZohoConfig().organizationId || '').trim();
    if (!organizationId) {
        throw new Error('Zoho Books organization is not configured. Set ZOHO_ORGANIZATION_ID.');
    }
    return organizationId;
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

function extractZohoContactPage(data, kind) {
    if (Array.isArray(data?.contacts)) return data.contacts;
    if (kind === 'customer' && Array.isArray(data?.customers)) return data.customers;
    if (kind === 'vendor' && Array.isArray(data?.vendors)) return data.vendors;
    return [];
}

async function getBooksRequestContext() {
    const config = getZohoConfig();
    assertBooksConfig(config);

    const stored = (await readZohoTokens()) || {};
    return {
        config,
        booksApiBase: resolveBooksApiBase(config, stored),
        accessToken: await getAccessToken(),
    };
}

async function requestZohoBooks(pathname, { method = 'get', params = {}, data, timeout = 30000 } = {}) {
    const { config, booksApiBase, accessToken } = await getBooksRequestContext();

    try {
        const response = await axios({
            method,
            url: `${booksApiBase}${pathname}`,
            params: {
                organization_id: config.organizationId,
                ...params,
            },
            data,
            headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`,
                ...(data ? { 'Content-Type': 'application/json' } : {}),
            },
            timeout,
        });

        const body = response.data || {};
        if (Number(body.code) !== 0) {
            throw new Error(body.message || 'Zoho Books request failed');
        }

        return body;
    } catch (error) {
        const zohoMessage = error?.response?.data?.message;
        throw new Error(zohoMessage || error?.message || 'Zoho Books request failed');
    }
}

async function fetchPaginatedZohoBooks(
    pathname,
    key,
    { params = {}, timeout = 30000, maxPages = Infinity, perPage = 200, startPage = 1 } = {},
) {
    const rows = [];
    let page = Math.max(1, Number(startPage) || 1);
    let hasMore = true;
    const pageLimit = Number.isFinite(maxPages) && maxPages > 0 ? Math.floor(maxPages) : Infinity;
    let pagesFetched = 0;

    while (hasMore && pagesFetched < pageLimit) {
        const data = await requestZohoBooks(pathname, {
            params: {
                ...params,
                page,
                per_page: perPage,
            },
            timeout,
        });
        const pageRows = Array.isArray(data?.[key]) ? data[key] : [];
        rows.push(...pageRows);

        hasMore = Boolean(data.page_context?.has_more_page);
        page += 1;
        pagesFetched += 1;

        if (!pageRows.length) {
            hasMore = false;
            break;
        }
    }

    return {
        rows,
        hasMore: Boolean(hasMore),
        pageCount: pagesFetched,
        nextPage: hasMore ? page : null,
        startPage: Math.max(1, Number(startPage) || 1),
    };
}

/**
 * Fetch up to maxRows from Zoho starting at startPage (Zoho page size typically 200).
 * Used for progressive sync (e.g. first 400, then next 400).
 */
export async function fetchZohoBooksChunk(
    pathname,
    key,
    { params = {}, timeout = 60000, startPage = 1, maxRows = 400, perPage = 200 } = {},
) {
    const limit = Math.max(1, Number(maxRows) || 400);
    const pageSize = Math.max(1, Math.min(200, Number(perPage) || 200));
    const maxPages = Math.ceil(limit / pageSize);

    const result = await fetchPaginatedZohoBooks(pathname, key, {
        params,
        timeout,
        startPage,
        maxPages,
        perPage: pageSize,
    });

    const rows = result.rows.slice(0, limit);
    // If we truncated within a page, still more to fetch from same next page logic
    const hasMore = result.hasMore || result.rows.length > limit;

    return {
        rows,
        hasMore: Boolean(hasMore),
        nextPage: hasMore ? result.nextPage || (Number(startPage) || 1) + result.pageCount : null,
        pageCount: result.pageCount,
    };
}

async function fetchAllZohoBooksRows(pathname, key, options = {}) {
    const result = await fetchPaginatedZohoBooks(pathname, key, options);
    return result.rows;
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

        const pageVendors = extractZohoContactPage(data, 'vendor');
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

        const pageCustomers = extractZohoContactPage(data, 'customer');
        customers.push(...pageCustomers);

        hasMore = Boolean(data.page_context?.has_more_page);
        page += 1;

        if (!pageCustomers.length) {
            break;
        }
    }

    return customers;
}

export async function fetchVendorPayments(params = {}) {
    const allowedParams = [
        'vendor_name',
        'reference_number',
        'payment_number',
        'date',
        'date_start',
        'date_end',
        'payment_mode',
        'vendor_id',
        'bill_id',
        'description',
        'filter_by',
        'search_text',
        'sort_column',
    ];
    const cleanParams = {};

    allowedParams.forEach((key) => {
        const value = params?.[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            cleanParams[key] = String(value).trim();
        }
    });

    const syncAllPages =
        params?.syncAllPages === true ||
        params?.sync_all_pages === true ||
        String(params?.syncAllPages || params?.sync_all_pages || '').trim() === 'true';

    return fetchAllZohoBooksRows('/vendorpayments', 'vendorpayments', {
        params: cleanParams,
        maxPages: syncAllPages ? Infinity : 3,
        timeout: syncAllPages ? 120000 : 45000,
    });
}

export async function createVendorPayment(payload = {}) {
    const response = await requestZohoBooks('/vendorpayments', {
        method: 'post',
        data: payload,
        timeout: 30000,
    });

    return response.vendorpayment || response;
}

export async function fetchVendorBills({ vendorId } = {}) {
    const params = {
        status: 'unpaid',
    };

    if (vendorId) {
        params.vendor_id = String(vendorId).trim();
    }

    // All unpaid bills for this vendor (every Zoho page).
    return fetchAllZohoBooksRows('/bills', 'bills', {
        params,
        timeout: 60000,
    });
}

export async function fetchBills(query = {}) {
    const params = {};
    const status = String(query.status || '').trim();
    const vendorId = String(query.vendor_id || query.vendorId || '').trim();

    if (status) params.status = status;
    if (vendorId) params.vendor_id = vendorId;

    // Full bill list from Zoho — all pages.
    const result = await fetchPaginatedZohoBooks('/bills', 'bills', {
        params,
        perPage: 200,
        timeout: 60000,
    });

    return {
        data: result.rows,
        meta: {
            count: result.rows.length,
            hasMore: result.hasMore,
            pageCount: result.pageCount,
            source: 'zoho',
        },
    };
}

function isOpenVendorExpense(expense) {
    if (!expense || typeof expense !== 'object') return false;

    const status = String(expense.status || '').toLowerCase();
    if (['reimbursed', 'invoiced', 'void'].includes(status)) return false;

    const balance = Number(expense.balance);
    if (Number.isFinite(balance) && balance > 0) return true;

    const total = Number(expense.total ?? expense.bcy_total ?? expense.amount) || 0;
    if (total <= 0) return false;

    return Boolean(String(expense.vendor_id || '').trim());
}

export async function fetchVendorExpenses({ vendorId } = {}) {
    const id = String(vendorId || '').trim();
    if (!id) return [];

    try {
        // All expenses for this vendor (every Zoho page).
        const expenses = await fetchAllZohoBooksRows('/expenses', 'expenses', {
            params: {
                vendor_id: id,
            },
            timeout: 60000,
        });

        return expenses.filter(isOpenVendorExpense);
    } catch (error) {
        const message = String(error?.message || '');
        if (/not authorized|invalid oauth scope/i.test(message)) {
            console.warn('[ZohoVendorExpenses] Expenses scope missing — reconnect Zoho with ZohoBooks.expenses.READ');
            return [];
        }
        throw error;
    }
}

export async function fetchExpenses(query = {}) {
    const params = {};
    const vendorId = String(query.vendor_id || query.vendorId || '').trim();
    const filterBy = String(query.filter_by || query.filterBy || '').trim();
    const status = String(query.status || '').trim();

    if (vendorId) params.vendor_id = vendorId;
    if (filterBy) params.filter_by = filterBy;
    if (status) params.status = status;

    // Full expense list from Zoho — all pages.
    const result = await fetchPaginatedZohoBooks('/expenses', 'expenses', {
        params,
        perPage: 200,
        timeout: 60000,
    });

    return {
        data: result.rows,
        meta: {
            count: result.rows.length,
            hasMore: result.hasMore,
            pageCount: result.pageCount,
            source: 'zoho',
        },
    };
}

export async function fetchExpensesChunk(query = {}, { startPage = 1, maxRows = 400 } = {}) {
    const params = {};
    const vendorId = String(query.vendor_id || query.vendorId || '').trim();
    const filterBy = String(query.filter_by || query.filterBy || '').trim();
    const status = String(query.status || '').trim();

    if (vendorId) params.vendor_id = vendorId;
    if (filterBy) params.filter_by = filterBy;
    if (status) params.status = status;

    return fetchZohoBooksChunk('/expenses', 'expenses', {
        params,
        startPage,
        maxRows,
        timeout: 60000,
    });
}

export async function fetchBillsChunk(query = {}, { startPage = 1, maxRows = 400 } = {}) {
    const params = {};
    const status = String(query.status || '').trim();
    const vendorId = String(query.vendor_id || query.vendorId || '').trim();

    if (status) params.status = status;
    if (vendorId) params.vendor_id = vendorId;

    return fetchZohoBooksChunk('/bills', 'bills', {
        params,
        startPage,
        maxRows,
        timeout: 60000,
    });
}

export async function fetchVendorPaymentsChunk(params = {}, { startPage = 1, maxRows = 400 } = {}) {
    const allowedParams = [
        'vendor_name',
        'reference_number',
        'payment_number',
        'date',
        'date_start',
        'date_end',
        'payment_mode',
        'vendor_id',
        'bill_id',
        'description',
        'filter_by',
        'search_text',
        'sort_column',
    ];
    const cleanParams = {};

    allowedParams.forEach((key) => {
        const value = params?.[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            cleanParams[key] = String(value).trim();
        }
    });

    return fetchZohoBooksChunk('/vendorpayments', 'vendorpayments', {
        params: cleanParams,
        startPage,
        maxRows,
        timeout: 60000,
    });
}

export async function fetchVendorsChunk({ startPage = 1, maxRows = 400 } = {}) {
    const config = getZohoConfig();
    assertBooksConfig(config);

    const stored = (await readZohoTokens()) || {};
    const booksApiBase = resolveBooksApiBase(config, stored);
    const accessToken = await getAccessToken();
    const vendors = [];
    let page = Math.max(1, Number(startPage) || 1);
    const limit = Math.max(1, Number(maxRows) || 400);
    let hasMore = true;

    while (hasMore && vendors.length < limit) {
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

        const pageVendors = extractZohoContactPage(data, 'vendor');
        vendors.push(...pageVendors);

        hasMore = Boolean(data.page_context?.has_more_page);
        page += 1;

        if (!pageVendors.length) {
            hasMore = false;
            break;
        }
    }

    const rows = vendors.slice(0, limit);
    const truncated = vendors.length > limit;

    return {
        rows,
        hasMore: Boolean(hasMore || truncated),
        nextPage: hasMore || truncated ? page : null,
    };
}

export async function fetchPaymentAccounts() {
    const accounts = await fetchAllZohoBooksRows('/chartofaccounts', 'chartofaccounts', {
        params: {
            filter_by: 'AccountType.Active',
        },
        maxPages: 3,
        timeout: 45000,
    });

    return accounts.filter((account) => {
        const type = String(account?.account_type || account?.account_type_formatted || '').toLowerCase();
        return /cash|bank|credit card|undeposited/.test(type);
    });
}

export async function fetchVendorContact(vendorId) {
    const id = String(vendorId || '').trim();
    if (!id) return null;

    const data = await requestZohoBooks(`/contacts/${encodeURIComponent(id)}`, {
        timeout: 30000,
    });

    return data.contact || null;
}

function collectLocationsFromRows(rows = []) {
    const byId = new Map();

    rows.forEach((row) => {
        const id = String(row?.location_id || row?.branch_id || '').trim();
        const name = String(row?.location_name || row?.branch_name || '').trim();
        if (!id || byId.has(id)) return;
        byId.set(id, {
            location_id: id,
            location_name: name || id,
            is_primary: false,
            is_location_active: true,
        });
    });

    return Array.from(byId.values());
}

async function fetchLocationsFromRecords() {
    const byId = new Map();

    const merge = (rows) => {
        collectLocationsFromRows(rows).forEach((location) => {
            if (!byId.has(location.location_id)) {
                byId.set(location.location_id, location);
            }
        });
    };

    const attempts = [
        {
            label: 'payments',
            pathname: '/vendorpayments',
            key: 'vendorpayments',
            params: { page: 1, per_page: 200, sort_column: 'created_time' },
        },
        {
            label: 'bills',
            pathname: '/bills',
            key: 'bills',
            params: { page: 1, per_page: 200 },
        },
        {
            label: 'vendors',
            pathname: '/contacts',
            key: 'contacts',
            params: { contact_type: 'vendor', page: 1, per_page: 200 },
        },
    ];

    await Promise.all(
        attempts.map(async ({ label, pathname, key, params }) => {
            try {
                const data = await requestZohoBooks(pathname, { params, timeout: 30000 });
                const rows = Array.isArray(data?.[key])
                    ? data[key]
                    : Array.isArray(data?.vendors)
                      ? data.vendors
                      : [];
                merge(rows);
            } catch (error) {
                console.warn(`[ZohoLocations] ${label} fallback failed:`, error?.message || error);
            }
        }),
    );

    return Array.from(byId.values());
}

export async function fetchLocations() {
    try {
        const data = await requestZohoBooks('/locations', {
            params: {
                filter_by: 'Status.Active',
            },
            timeout: 30000,
        });

        let locations = [];
        if (Array.isArray(data?.locations)) locations = data.locations;
        else if (Array.isArray(data?.locations?.locations)) locations = data.locations.locations;

        if (locations.length) return locations;
    } catch (error) {
        // Locations require ZohoBooks.settings.READ. Fall back to ids seen on payments/bills.
        console.warn('[ZohoLocations] Failed:', error?.message || error);
    }

    try {
        const fallback = await fetchLocationsFromRecords();
        if (fallback.length) {
            console.warn(`[ZohoLocations] Using ${fallback.length} location(s) from payments/bills`);
        }
        return fallback;
    } catch (error) {
        console.warn('[ZohoLocations] Fallback failed:', error?.message || error);
        return [];
    }
}

const DEFAULT_PAYMENT_MODES = [
    'Cash',
    'Check',
    'Bank Transfer',
    'Credit Card',
    'Bank Remittance',
    'Others',
];

function normalizePaymentModeName(value) {
    const name = String(value ?? '').trim();
    if (!name) return '';
    // Zoho sometimes returns lowercase tokens (cash, banktransfer).
    const compact = name.toLowerCase().replace(/[\s_-]+/g, '');
    const known = {
        cash: 'Cash',
        check: 'Check',
        cheque: 'Check',
        banktransfer: 'Bank Transfer',
        creditcard: 'Credit Card',
        bankremittance: 'Bank Remittance',
        autotransaction: 'Auto Transaction',
        others: 'Others',
        other: 'Others',
    };
    return known[compact] || name;
}

function collectPaymentModes(values = []) {
    const seen = new Set();
    const modes = [];

    values.forEach((value) => {
        const name =
            typeof value === 'string'
                ? normalizePaymentModeName(value)
                : normalizePaymentModeName(
                      value?.payment_mode_name ||
                          value?.payment_mode ||
                          value?.name ||
                          value?.mode,
                  );
        if (!name) return;
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        modes.push(name);
    });

    return modes;
}

async function fetchPaymentModesFromPayments() {
    try {
        const data = await requestZohoBooks('/vendorpayments', {
            params: {
                page: 1,
                per_page: 200,
                sort_column: 'created_time',
            },
            timeout: 30000,
        });
        return collectPaymentModes((data?.vendorpayments || []).map((row) => row?.payment_mode));
    } catch (error) {
        console.warn('[ZohoPaymentModes] Payment fallback failed:', error?.message || error);
        return [];
    }
}

export async function fetchPaymentModes() {
    try {
        const data = await requestZohoBooks('/settings/paymentmodes', {
            timeout: 30000,
        });

        const fromSettings = collectPaymentModes(
            data?.paymentmodes || data?.payment_modes || data?.data || [],
        );
        if (fromSettings.length) return sortPaymentModes(fromSettings);
    } catch (error) {
        console.warn('[ZohoPaymentModes] Failed:', error?.message || error);
    }

    const fromPayments = await fetchPaymentModesFromPayments();
    const merged = collectPaymentModes([...DEFAULT_PAYMENT_MODES, ...fromPayments]);
    if (fromPayments.length) {
        console.warn(`[ZohoPaymentModes] Using ${fromPayments.length} mode(s) from payments + defaults`);
    }
    return sortPaymentModes(merged);
}

function sortPaymentModes(modes = []) {
    const rank = new Map(DEFAULT_PAYMENT_MODES.map((mode, index) => [mode.toLowerCase(), index]));
    return [...modes].sort((a, b) => {
        const aRank = rank.has(a.toLowerCase()) ? rank.get(a.toLowerCase()) : 1000;
        const bRank = rank.has(b.toLowerCase()) ? rank.get(b.toLowerCase()) : 1000;
        if (aRank !== bRank) return aRank - bRank;
        return a.localeCompare(b);
    });
}

function parsePaymentNumberParts(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return { prefix: '', number: 0, width: 1 };

    const match = raw.match(/^(.*?)(\d+)$/);
    if (!match) {
        const asNumber = Number(raw);
        return {
            prefix: '',
            number: Number.isFinite(asNumber) ? asNumber : 0,
            width: raw.length || 1,
        };
    }

    return {
        prefix: match[1],
        number: Number(match[2]) || 0,
        width: match[2].length,
    };
}

/**
 * Derive the next Zoho Payment # from existing vendor payments
 * (Zoho UI auto-fills this; there is no dedicated "next number" endpoint).
 */
export async function fetchNextVendorPaymentNumber() {
    let best = { prefix: '', number: 0, width: 1 };
    let page = 1;
    let hasMore = true;
    // Cap pages so the Record Payment modal stays responsive.
    const MAX_PAGES = 10;

    while (hasMore && page <= MAX_PAGES) {
        const data = await requestZohoBooks('/vendorpayments', {
            params: {
                page,
                per_page: 200,
                sort_column: 'date',
            },
            timeout: 30000,
        });

        const pageRows = Array.isArray(data?.vendorpayments) ? data.vendorpayments : [];
        pageRows.forEach((payment) => {
            const parts = parsePaymentNumberParts(payment?.payment_number);
            if (parts.number > best.number) {
                best = parts;
            }
        });

        hasMore = Boolean(data.page_context?.has_more_page) && pageRows.length > 0;
        page += 1;
    }

    const nextNumber = best.number + 1;
    return `${best.prefix}${String(nextNumber).padStart(best.width, '0')}`;
}
