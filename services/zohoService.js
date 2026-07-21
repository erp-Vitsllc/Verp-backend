import axios from 'axios';
import {
    readZohoTokens,
    writeZohoTokens,
    issueOAuthState,
    validateOAuthState,
} from '../utils/zohoTokenStore.js';
import { getZohoOrgContext } from '../utils/zohoOrgContext.js';

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_OAUTH_SCOPE = [
    'ZohoBooks.contacts.READ',
    'ZohoBooks.contacts.CREATE',
    'ZohoBooks.vendorpayments.READ',
    'ZohoBooks.vendorpayments.CREATE',
    'ZohoBooks.vendorpayments.UPDATE',
    'ZohoBooks.bills.READ',
    'ZohoBooks.bills.CREATE',
    'ZohoBooks.bills.UPDATE',
    'ZohoBooks.expenses.READ',
    'ZohoBooks.expenses.CREATE',
    'ZohoBooks.accountants.READ',
    'ZohoBooks.settings.READ',
].join(',');

export function getZohoConfig() {
    return {
        clientId: process.env.ZOHO_CLIENT_ID || '',
        clientSecret: process.env.ZOHO_CLIENT_SECRET || '',
        redirectUri: process.env.ZOHO_REDIRECT_URI || '',
        organizationId: process.env.ZOHO_ORGANIZATION_ID || '',
        nnitOrganizationId: process.env.ZOHO_ORGANIZATION_ID_NNIT || '',
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

/**
 * Active Zoho Books organization id:
 * 1) request/async context (withZohoOrganization / multi-org)
 * 2) ZOHO_ORGANIZATION_ID env (default / first Zoho)
 */
export function getZohoOrganizationId() {
    const fromContext = String(getZohoOrgContext()?.organizationId || '').trim();
    if (fromContext) return fromContext;

    const organizationId = String(getZohoConfig().organizationId || '').trim();
    if (!organizationId) {
        throw new Error(
            'Zoho Books organization is not configured. Set ZOHO_ORGANIZATION_ID or pass organizationId/companyId.',
        );
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
    // Org may come from AsyncLocalStorage instead of env.
    getZohoOrganizationId();
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

export async function buildAuthorizationUrl({ organizationId = '' } = {}) {
    const config = getZohoConfig();
    assertOAuthConfig(config);

    const orgId = String(organizationId || '').trim() || String(config.organizationId || '').trim();
    if (!orgId) {
        throw new Error(
            'organizationId is required to connect Zoho (pass organizationId or set ZOHO_ORGANIZATION_ID).',
        );
    }

    const state = issueOAuthState({ organizationId: orgId });
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
        organizationId: orgId,
    };
}

export async function validateOAuthCallbackState(state) {
    const receivedState = String(state || '').trim();

    if (!receivedState) {
        throw new Error('Missing OAuth state parameter');
    }

    const validated = validateOAuthState(receivedState);
    if (!validated?.ok) {
        throw new Error('Invalid or expired OAuth state parameter');
    }
    return validated;
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

    const validated = await validateOAuthCallbackState(state);
    const organizationId =
        String(validated.organizationId || '').trim() ||
        String(config.organizationId || '').trim();

    if (!organizationId) {
        throw new Error(
            'OAuth state did not include organizationId. Reconnect with ?organizationId=…',
        );
    }

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

    const existing = (await readZohoTokens(organizationId)) || {};
    const payload = buildTokenPayload(
        {
            ...tokenResponse,
            refresh_token: tokenResponse.refresh_token || existing.refresh_token,
        },
        existing,
    );
    payload.organization_id = organizationId;

    if (!payload.refresh_token) {
        throw new Error(
            'Zoho did not return a refresh_token. Re-authorize with access_type=offline and prompt=consent.',
        );
    }

    await writeZohoTokens(payload, organizationId);
    return payload;
}

async function refreshAccessToken(refreshToken, organizationId) {
    const config = getZohoConfig();
    assertOAuthConfig(config);
    const orgId = String(organizationId || '').trim() || getZohoOrganizationId();

    const tokenResponse = await requestTokens(
        {
            grant_type: 'refresh_token',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: refreshToken,
        },
        config,
    );

    const existing = (await readZohoTokens(orgId)) || {};
    const payload = buildTokenPayload(
        {
            ...tokenResponse,
            refresh_token: tokenResponse.refresh_token || refreshToken || existing.refresh_token,
        },
        existing,
    );
    payload.organization_id = orgId;

    await writeZohoTokens(payload, orgId);
    return payload.access_token;
}

export async function getAccessToken() {
    const config = getZohoConfig();
    assertOAuthConfig(config);
    const organizationId = getZohoOrganizationId();

    const stored = await readZohoTokens(organizationId);
    if (!stored?.refresh_token && !stored?.access_token) {
        throw new Error(
            `Zoho is not connected for organization ${organizationId}. Complete OAuth via /api/zoho/auth-url?organizationId=${organizationId}`,
        );
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

    return refreshAccessToken(stored.refresh_token, organizationId);
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
    const organizationId = getZohoOrganizationId();

    const stored = (await readZohoTokens(organizationId)) || {};
    return {
        config,
        organizationId,
        booksApiBase: resolveBooksApiBase(config, stored),
        accessToken: await getAccessToken(),
        grantedScope: String(stored.scope || ''),
    };
}

async function requestZohoBooks(pathname, { method = 'get', params = {}, data, timeout = 30000 } = {}) {
    const { organizationId, booksApiBase, accessToken, grantedScope } =
        await getBooksRequestContext();

    const isWrite = String(method).toLowerCase() !== 'get';
    if (isWrite) {
        console.log(
            `[ZohoBooks →] ${String(method).toUpperCase()} ${booksApiBase}${pathname}`,
            `org=${organizationId}`,
            `token=…${String(accessToken).slice(-8)}`,
            `granted_scope=${grantedScope || '(not stored)'}`,
        );
        if (data) console.log('[ZohoBooks →] payload:', JSON.stringify(data, null, 2));
    }

    try {
        const response = await axios({
            method,
            url: `${booksApiBase}${pathname}`,
            params: {
                organization_id: organizationId,
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
            console.error(
                `[ZohoBooks ✗] ${String(method).toUpperCase()} ${pathname} org=${organizationId}`,
                `HTTP ${response.status} zoho_code=${body.code}:`,
                JSON.stringify(body),
            );
            throw new Error(body.message || 'Zoho Books request failed');
        }

        if (isWrite) {
            console.log(
                `[ZohoBooks ✓] ${String(method).toUpperCase()} ${pathname} org=${organizationId} zoho_code=${body.code} message="${body.message || ''}"`,
            );
        }
        return body;
    } catch (error) {
        const zohoStatus = error?.response?.status;
        const zohoBody = error?.response?.data;
        const zohoMessage = zohoBody?.message;
        if (zohoStatus || zohoBody) {
            console.error(
                `[ZohoBooks ✗] ${String(method).toUpperCase()} ${pathname} org=${organizationId}`,
                `HTTP ${zohoStatus ?? '?'} zoho_code=${zohoBody?.code ?? '?'}:`,
                typeof zohoBody === 'object' ? JSON.stringify(zohoBody) : String(zohoBody ?? ''),
            );
        } else if (isWrite) {
            console.error(
                `[ZohoBooks ✗] ${String(method).toUpperCase()} ${pathname} org=${organizationId} (no Zoho response):`,
                error?.message || error,
            );
        }
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
    const organizationId = getZohoOrganizationId();

    const stored = (await readZohoTokens(organizationId)) || {};
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
                    organization_id: organizationId,
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

/**
 * List Zoho Books organizations available to the connected OAuth user
 * (VEGA + NNIT under the same Zoho login).
 */
export async function fetchZohoOrganizations() {
    try {
        const data = await requestZohoBooks('/organizations', {
            timeout: 30000,
        });
        const rows = Array.isArray(data?.organizations) ? data.organizations : [];
        return rows
            .map((row) => ({
                organizationId: String(row?.organization_id || row?.organizationId || '').trim(),
                name: String(row?.name || '').trim(),
                isDefault: Boolean(row?.is_default_org),
                isActive: row?.is_org_active !== false && row?.isOrgActive !== false,
            }))
            .filter((row) => row.organizationId);
    } catch (error) {
        console.warn('[ZohoOrganizations] Failed:', error?.message || error);
        return [];
    }
}

export async function fetchCustomers() {
    const config = getZohoConfig();
    assertBooksConfig(config);
    const organizationId = getZohoOrganizationId();

    const stored = (await readZohoTokens(organizationId)) || {};
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
                    organization_id: organizationId,
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

/**
 * Create a balanced Zoho manual journal (debit + credit against Chart of Accounts).
 * OAuth: ZohoBooks.accountants.CREATE
 */
export async function createZohoJournal(payload = {}) {
    const response = await requestZohoBooks('/journals', {
        method: 'post',
        data: payload,
        timeout: 30000,
    });
    return response.journal || response;
}

/**
 * Zoho general-ledger lines for a vendor payment (debit + credit).
 * GET /transactions/{transaction_id}/journals?entity_type=vendor_payment
 */
export async function fetchTransactionJournalView(transactionId, { entityType = 'vendor_payment' } = {}) {
    const id = String(transactionId || '').trim();
    if (!id) return null;

    const data = await requestZohoBooks(`/transactions/${encodeURIComponent(id)}/journals`, {
        params: {
            entity_type: entityType,
        },
        timeout: 20000,
    });
    return data;
}

export async function fetchVendorPaymentById(paymentId) {
    const id = String(paymentId || '').trim();
    if (!id) return null;

    const data = await requestZohoBooks(`/vendorpayments/${encodeURIComponent(id)}`, {
        timeout: 30000,
    });

    return data.vendorpayment || data.payment || null;
}

export async function updateVendorPayment(paymentId, payload = {}) {
    const id = String(paymentId || '').trim();
    if (!id) throw new Error('Payment id is required.');

    const response = await requestZohoBooks(`/vendorpayments/${encodeURIComponent(id)}`, {
        method: 'put',
        data: payload,
        timeout: 30000,
    });

    return response.vendorpayment || response.payment || response;
}

/**
 * Download Zoho Books vendor payment PDF (accept=pdf / Accept: application/pdf).
 * Throws if Zoho does not return a PDF for this resource.
 */
export async function fetchVendorPaymentPdf(paymentId) {
    const id = String(paymentId || '').trim();
    if (!id) {
        throw new Error('Payment id is required.');
    }

    const { organizationId, booksApiBase, accessToken } = await getBooksRequestContext();

    const response = await axios({
        method: 'get',
        url: `${booksApiBase}/vendorpayments/${encodeURIComponent(id)}`,
        params: {
            organization_id: organizationId,
            accept: 'pdf',
        },
        headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            Accept: 'application/pdf',
        },
        responseType: 'arraybuffer',
        timeout: 60000,
        validateStatus: () => true,
    });

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    const buffer = Buffer.from(response.data || []);

    if (response.status >= 400 || !contentType.includes('pdf')) {
        let message = 'Zoho did not return a PDF for this payment.';
        try {
            const asText = buffer.toString('utf8');
            const parsed = JSON.parse(asText);
            if (parsed?.message) message = parsed.message;
        } catch {
            /* keep default */
        }
        throw new Error(message);
    }

    const disposition = String(response.headers?.['content-disposition'] || '');
    const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
    const rawName = match?.[1] ? decodeURIComponent(match[1].replace(/"/g, '')) : '';
    const filename = rawName || `Payment-${id}.pdf`;

    return { buffer, filename, contentType: 'application/pdf' };
}

export async function createBill(payload = {}) {
    const response = await requestZohoBooks('/bills', {
        method: 'post',
        data: payload,
        timeout: 30000,
    });

    return response.bill || response;
}

/** Submit a Draft bill into the Zoho approval flow (orgs with bill approval enabled). */
export async function submitBillForApproval(billId) {
    const id = String(billId || '').trim();
    if (!id) throw new Error('Bill id is required.');

    return requestZohoBooks(`/bills/${encodeURIComponent(id)}/submit`, {
        method: 'post',
        timeout: 30000,
    });
}

/** Approve a submitted bill in Zoho (orgs with bill approval enabled). */
export async function approveBill(billId) {
    const id = String(billId || '').trim();
    if (!id) throw new Error('Bill id is required.');

    return requestZohoBooks(`/bills/${encodeURIComponent(id)}/approve`, {
        method: 'post',
        timeout: 30000,
    });
}

/**
 * Move an API-created bill out of Draft so Accounts can pay it in Zoho.
 * Orgs with bill approval enabled reject status/open (code 21025) until the
 * bill is submitted + approved — do that automatically, then retry open.
 */
export async function markBillAsOpen(billId) {
    const id = String(billId || '').trim();
    if (!id) throw new Error('Bill id is required.');

    try {
        return await requestZohoBooks(`/bills/${encodeURIComponent(id)}/status/open`, {
            method: 'post',
            timeout: 30000,
        });
    } catch (error) {
        if (!/has not been approved/i.test(String(error?.message || ''))) {
            throw error;
        }

        try {
            await submitBillForApproval(id);
        } catch (submitErr) {
            // Already submitted / not needed — continue to approve.
            console.warn('[ZohoBooks] Bill submit skipped:', submitErr?.message || submitErr);
        }
        await approveBill(id);

        try {
            return await requestZohoBooks(`/bills/${encodeURIComponent(id)}/status/open`, {
                method: 'post',
                timeout: 30000,
            });
        } catch (openErr) {
            // Some orgs treat approved bills as open already.
            if (/already|approved/i.test(String(openErr?.message || ''))) {
                return { code: 0, message: 'Bill approved in Zoho.' };
            }
            throw openErr;
        }
    }
}

export async function fetchBillById(billId) {
    const id = String(billId || '').trim();
    if (!id) return null;

    const data = await requestZohoBooks(`/bills/${encodeURIComponent(id)}`, {
        timeout: 30000,
    });

    return data.bill || null;
}

export async function updateBill(billId, payload = {}) {
    const id = String(billId || '').trim();
    if (!id) throw new Error('Bill id is required.');

    const response = await requestZohoBooks(`/bills/${encodeURIComponent(id)}`, {
        method: 'put',
        data: payload,
        timeout: 30000,
    });

    return response.bill || response;
}

export async function createExpense(payload = {}) {
    const response = await requestZohoBooks('/expenses', {
        method: 'post',
        data: payload,
        timeout: 30000,
    });

    return response.expense || response;
}

export async function createVendor(payload = {}) {
    const response = await requestZohoBooks('/contacts', {
        method: 'post',
        data: payload,
        timeout: 30000,
    });

    return response.contact || response;
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

    const status = String(expense.status || '').toLowerCase().replace(/\s+/g, '_');
    if (['reimbursed', 'invoiced', 'void', 'deleted'].includes(status)) return false;

    const balance = Number(expense.balance);
    if (Number.isFinite(balance)) {
        return balance > 0;
    }

    const total = Number(expense.total ?? expense.bcy_total ?? expense.amount) || 0;
    if (total <= 0) return false;

    // Zoho often omits balance on open/unbilled expenses — still payable against the vendor.
    return Boolean(String(expense.vendor_id || '').trim());
}

export async function fetchVendorExpenses({ vendorId } = {}) {
    const id = String(vendorId || '').trim();
    if (!id) return [];

    try {
        // Prefer unbilled/open expenses; fall back to all vendor expenses if filter unsupported.
        let expenses = [];
        try {
            expenses = await fetchAllZohoBooksRows('/expenses', 'expenses', {
                params: {
                    vendor_id: id,
                    filter_by: 'Status.Unbilled',
                },
                timeout: 60000,
            });
        } catch {
            expenses = [];
        }

        if (!expenses.length) {
            expenses = await fetchAllZohoBooksRows('/expenses', 'expenses', {
                params: {
                    vendor_id: id,
                },
                timeout: 60000,
            });
        }

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
    const organizationId = getZohoOrganizationId();

    const stored = (await readZohoTokens(organizationId)) || {};
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
                    organization_id: organizationId,
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

/**
 * Full Zoho Chart of Accounts for Payments Made → Paid Through.
 * Returns every active account (VEGA / NNIT org-scoped via request context).
 */
/** Account types Zoho itself offers as "Paid Through" on vendor payments (plus payables for employee credit journals). */
const PAID_THROUGH_ACCOUNT_TYPES = new Set([
    'bank',
    'cash',
    'credit_card',
    'payment_clearing',
    'other_current_asset',
    'other_current_liability',
    'other_liability',
    'accounts_payable',
    'equity',
]);

export async function fetchPaymentAccounts() {
    const accounts = await fetchAllZohoBooksRows('/chartofaccounts', 'chartofaccounts', {
        params: {
            filter_by: 'AccountType.Active',
        },
        maxPages: 10,
        timeout: 60000,
    });

    const byId = new Map();
    accounts.forEach((account) => {
        const id = String(account?.account_id || account?.id || '').trim();
        if (!id) return;
        // Skip soft-deleted / inactive rows if Zoho still returns them.
        const status = String(account?.status || account?.is_active || '')
            .toLowerCase()
            .trim();
        if (status === 'inactive' || status === 'false' || account?.is_active === false) {
            return;
        }
        // Only payment-capable accounts — exclude fixed assets / expense / income rows.
        const accountType = String(account?.account_type || '')
            .toLowerCase()
            .replace(/\s+/g, '_')
            .trim();
        if (accountType && !PAID_THROUGH_ACCOUNT_TYPES.has(accountType)) {
            return;
        }
        byId.set(id, account);
    });

    const rows = [...byId.values()].sort((a, b) => {
        const typeA = String(a.account_type_formatted || a.account_type || '').toLowerCase();
        const typeB = String(b.account_type_formatted || b.account_type || '').toLowerCase();
        if (typeA !== typeB) return typeA.localeCompare(typeB);
        const nameA = String(a.account_name || a.name || '').toLowerCase();
        const nameB = String(b.account_name || b.name || '').toLowerCase();
        return nameA.localeCompare(nameB);
    });

    if (!rows.length) {
        console.warn('[ZohoPaymentAccounts] Chart of Accounts returned 0 active accounts');
    } else {
        console.log(`[ZohoPaymentAccounts] Loaded ${rows.length} Chart of Accounts row(s)`);
    }

    return rows;
}

/** Expense / COGS / asset accounts used on Zoho bill line items. */
export async function fetchBillExpenseAccounts() {
    const accounts = await fetchAllZohoBooksRows('/chartofaccounts', 'chartofaccounts', {
        params: {
            filter_by: 'AccountType.Active',
        },
        maxPages: 2,
        timeout: 25000,
    });

    return accounts.filter((account) => {
        const type = String(account?.account_type || account?.account_type_formatted || '').toLowerCase();
        // Exclude payment / liability accounts that belong on Payments Made, not bill lines.
        if (/cash|bank|credit card|undeposited|accounts payable|accounts receivable/.test(type)) {
            return false;
        }
        return /expense|cost of goods|costofgoods|fixed asset|other asset|other current asset|stock|inventory/.test(
            type,
        );
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

export async function fetchVendorComments(vendorId) {
    const id = String(vendorId || '').trim();
    if (!id) return [];

    const data = await requestZohoBooks(`/contacts/${encodeURIComponent(id)}/comments`, {
        timeout: 30000,
    });

    return Array.isArray(data.contact_comments) ? data.contact_comments : [];
}

export async function createVendorComment(vendorId, description) {
    const id = String(vendorId || '').trim();
    const text = String(description || '').trim();
    if (!id) throw new Error('Vendor id is required.');
    if (!text) throw new Error('Comment text is required.');

    const data = await requestZohoBooks(`/contacts/${encodeURIComponent(id)}/comments`, {
        method: 'post',
        data: { description: text },
        timeout: 30000,
    });

    return data.contact_comment || data.comment || data;
}

export async function fetchBillComments(billId) {
    const id = String(billId || '').trim();
    if (!id) return [];

    const data = await requestZohoBooks(`/bills/${encodeURIComponent(id)}/comments`, {
        timeout: 30000,
    });

    return Array.isArray(data.comments) ? data.comments : [];
}

export async function createBillComment(billId, description) {
    const id = String(billId || '').trim();
    const text = String(description || '').trim();
    if (!id) throw new Error('Bill id is required.');
    if (!text) throw new Error('Comment text is required.');

    const data = await requestZohoBooks(`/bills/${encodeURIComponent(id)}/comments`, {
        method: 'post',
        data: { description: text },
        timeout: 30000,
    });

    return data.comment || data;
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
    // Cap to 1 page — enough for next # hint; keeps New Bill / Payment modals fast.
    const MAX_PAGES = 1;

    while (hasMore && page <= MAX_PAGES) {
        const data = await requestZohoBooks('/vendorpayments', {
            params: {
                page,
                per_page: 200,
                sort_column: 'date',
            },
            timeout: 20000,
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

/**
 * Derive the next Zoho Bill # from recent bills (same approach as payment numbers).
 */
export async function fetchNextBillNumber() {
    let best = { prefix: '', number: 0, width: 1 };
    let page = 1;
    let hasMore = true;
    // Cap to 1 page so New Bill modal opens quickly.
    const MAX_PAGES = 1;

    while (hasMore && page <= MAX_PAGES) {
        const data = await requestZohoBooks('/bills', {
            params: {
                page,
                per_page: 200,
                sort_column: 'date',
            },
            timeout: 20000,
        });

        const pageRows = Array.isArray(data?.bills) ? data.bills : [];
        pageRows.forEach((bill) => {
            const parts = parsePaymentNumberParts(bill?.bill_number);
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
