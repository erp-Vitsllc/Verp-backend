import axios from 'axios';
import { clearLocatorTokens, readLocatorTokens, writeLocatorTokens } from '../utils/locatorTokenStore.js';

const KNOTS_TO_KMH = 1.852;
const DEFAULT_API_BASE = 'https://pro.mylocatorplus.com/locator-clients/api';
const DEFAULT_WS_BASE = 'wss://pro.mylocatorplus.com/locator-clients/api/socket';

const rateLimitBuckets = new Map();

function getLocatorConfig() {
    return {
        apiBaseUrl: (process.env.LOCATOR_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, ''),
        wsBaseUrl: (process.env.LOCATOR_WS_BASE_URL || DEFAULT_WS_BASE).replace(/\/$/, ''),
        username: process.env.LOCATOR_USERNAME || '',
        password: process.env.LOCATOR_PASSWORD || '',
        isAdmin: process.env.LOCATOR_IS_ADMIN || 'customer',
    };
}

export function isLocatorConfigured() {
    const { username, password } = getLocatorConfig();
    return Boolean(username && password);
}

function assertLocatorConfig() {
    if (!isLocatorConfigured()) {
        throw new Error(
            'Locator GPS is not configured. Set LOCATOR_USERNAME and LOCATOR_PASSWORD in the backend environment.',
        );
    }
}

function buildApiClient() {
    const { apiBaseUrl } = getLocatorConfig();
    return axios.create({
        baseURL: apiBaseUrl,
        timeout: 30000,
        headers: {
            'Content-Type': 'application/json',
        },
    });
}

function assertRateLimit(key, maxRequests, windowMs) {
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + windowMs };

    if (now >= bucket.resetAt) {
        bucket.count = 0;
        bucket.resetAt = now + windowMs;
    }

    bucket.count += 1;
    rateLimitBuckets.set(key, bucket);

    if (bucket.count > maxRequests) {
        const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
        const error = new Error(
            `Locator API rate limit exceeded for ${key}. Retry after ${retryAfterSec}s.`,
        );
        error.statusCode = 429;
        error.retryAfterSec = retryAfterSec;
        throw error;
    }
}

function normalizeSpeedKmh(speedKnots) {
    const knots = Number(speedKnots);
    if (!Number.isFinite(knots)) return null;
    return Number((knots * KNOTS_TO_KMH).toFixed(2));
}

function normalizeDistanceKm(distanceMeters) {
    const meters = Number(distanceMeters);
    if (!Number.isFinite(meters)) return null;
    return Number((meters / 1000).toFixed(2));
}

function normalizeTemperatureC(temp1) {
    const raw = Number(temp1);
    if (!Number.isFinite(raw)) return null;
    return Number((raw / 10).toFixed(2));
}

export function normalizeWebSocketPosition(position) {
    if (!position || typeof position !== 'object') return position;

    return {
        ...position,
        speedKmh: normalizeSpeedKmh(position.speed),
        totalDistanceKm: normalizeDistanceKm(position.totalDistance),
        temperatureC: normalizeTemperatureC(position.temp1),
    };
}

export function normalizeRestPosition(position) {
    if (!position || typeof position !== 'object') return position;

    const attributes = position.attributes || {};

    return {
        ...position,
        speedKmh: normalizeSpeedKmh(position.speed),
        attributes: {
            ...attributes,
            totalDistanceKm:
                attributes.totalDistanceKm ??
                (attributes.totalDistance != null
                    ? String(normalizeDistanceKm(attributes.totalDistance))
                    : attributes.totalDistanceKm),
            temperatureC: normalizeTemperatureC(attributes.temp1),
        },
    };
}

export function normalizeLiveData(data) {
    if (!data || typeof data !== 'object') return data;

    const coordinates = String(data['Coordinates'] || '')
        .split(',')
        .map((part) => part.trim());

    return {
        ...data,
        latitude: coordinates[0] ? Number(coordinates[0]) : null,
        longitude: coordinates[1] ? Number(coordinates[1]) : null,
        speedKmh: Number.isFinite(Number(data.Speed)) ? Number(data.Speed) : null,
    };
}

export function buildLocatorWebSocketUrl() {
    const { wsBaseUrl, username, password } = getLocatorConfig();
    assertLocatorConfig();

    const params = new URLSearchParams({
        username,
        password,
    });

    return `${wsBaseUrl}?${params.toString()}`;
}

export async function locatorLogin({ force = false } = {}) {
    assertLocatorConfig();

    if (!force) {
        const stored = await readLocatorTokens();
        if (stored?.token) {
            return stored;
        }
    }

    const { username, password, isAdmin } = getLocatorConfig();
    const client = buildApiClient();

    const response = await client.post('/v1/login', {
        user_name: username,
        user_password: password,
        isAdmin,
    });

    const payload = response?.data;
    if (!payload?.success || !payload?.data?.token) {
        throw new Error(payload?.message || 'Locator login failed');
    }

    const stored = {
        token: payload.data.token,
        user: payload.data.user || null,
        vehicles: payload.data.vehicles || [],
        groups: payload.data.groups || [],
        modules: payload.data.modules || [],
    };

    await writeLocatorTokens(stored);
    return stored;
}

async function getValidToken({ force = false } = {}) {
    const session = await locatorLogin({ force });
    return session.token;
}

export async function fetchLatestPositions() {
    assertLocatorConfig();
    assertRateLimit('latest-positions', 3, 60 * 1000);

    const client = buildApiClient();
    let token = await getValidToken();

    const requestLatest = async (authToken) =>
        client.post(
            '/v1/position/latest',
            {},
            {
                headers: {
                    Authorization: authToken,
                },
            },
        );

    let response;
    try {
        response = await requestLatest(token);
    } catch (error) {
        const status = error?.response?.status;
        if (status === 401 || status === 403) {
            token = await getValidToken({ force: true });
            response = await requestLatest(token);
        } else {
            throw error;
        }
    }

    const payload = response?.data;
    if (!payload?.success) {
        throw new Error(payload?.message || 'Failed to fetch latest Locator positions');
    }

    const positions = Array.isArray(payload?.data?.positions)
        ? payload.data.positions.map(normalizeRestPosition)
        : [];

    return {
        positions,
        notexist: payload?.data?.notexist || [],
        total: payload?.data?.total ?? positions.length,
    };
}

export async function fetchLiveByImei(imei) {
    assertLocatorConfig();

    const normalizedImei = String(imei || '').trim();
    if (!normalizedImei) {
        const error = new Error('IMEI is required');
        error.statusCode = 400;
        throw error;
    }

    assertRateLimit('custom-live', 10, 60 * 1000);

    const { username, password } = getLocatorConfig();
    const client = buildApiClient();

    const response = await client.post('/v1/custom/live', {
        username,
        password,
        imei: normalizedImei,
    });

    const payload = response?.data;
    if (!payload?.success) {
        throw new Error(payload?.message || 'Failed to fetch Locator live data');
    }

    return normalizeLiveData(payload.data);
}

export async function getLocatorStatus() {
    const configured = isLocatorConfigured();
    let loggedIn = false;
    let tokenUpdatedAt = null;

    if (configured) {
        const stored = await readLocatorTokens();
        loggedIn = Boolean(stored?.token);
        tokenUpdatedAt = stored?.updated_at || null;
    }

    return {
        configured,
        loggedIn,
        tokenUpdatedAt,
        apiBaseUrl: getLocatorConfig().apiBaseUrl,
        websocketEnabled: process.env.LOCATOR_WS_ENABLED !== 'false',
    };
}

export async function resetLocatorSession() {
    await clearLocatorTokens();
}
