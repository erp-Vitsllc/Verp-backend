import axios from 'axios';
import { clearLocatorTokens, readLocatorTokens, writeLocatorTokens } from '../utils/locatorTokenStore.js';
import {
    convertKnotsToKmh,
    currentDistanceKm,
    formatDuration,
    locatorSampleTime,
    locatorTemperatureC,
    metersToKm,
    rawOdometerMeters,
} from './locatorUnits.js';

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
    const kmh = convertKnotsToKmh(speedKnots);
    if (kmh == null) return null;
    return Number(kmh.toFixed(2));
}

function normalizeDistanceKm(distanceMeters) {
    const meters = Number(distanceMeters);
    if (!Number.isFinite(meters)) return null;
    return Number((meters / 1000).toFixed(2));
}

function normalizeTemperatureC(source) {
    const value = locatorTemperatureC(source);
    return value == null ? null : Number(value.toFixed(2));
}

export function normalizeWebSocketPosition(position) {
    if (!position || typeof position !== 'object') return position;

    return {
        ...position,
        speedKmh: normalizeSpeedKmh(position.speed),
        totalDistanceKm: normalizeDistanceKm(position.totalDistance),
        temperatureC: normalizeTemperatureC(position),
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
            temperatureC: normalizeTemperatureC(position),
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
    const liveToken = payload?.data?.live_token || payload?.data?.liveToken || payload?.data?.token;
    if (!payload?.success || !liveToken) {
        throw new Error(payload?.message || 'Locator login failed');
    }

    const previous = await readLocatorTokens();
    const reportToken = payload.data.report_token || payload.data.reportToken || previous?.reportToken || null;
    const stored = {
        token: liveToken,
        liveToken,
        reportToken,
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

const LATEST_POSITIONS_CACHE_MS = 25 * 1000;
let latestPositionsCache = { at: 0, data: null };

export async function fetchLatestPositions({ allowStale = false, force = false } = {}) {
    assertLocatorConfig();

    // Dashboard / reconcile paths pass force=true so each load hits Locator live API.
    if (
        !force &&
        latestPositionsCache.data &&
        Date.now() - latestPositionsCache.at < LATEST_POSITIONS_CACHE_MS
    ) {
        return latestPositionsCache.data;
    }

    try {
        // Locator docs: max 3 requests/minute for /v1/position/latest
        assertRateLimit('latest-positions', 3, 60 * 1000);
    } catch (error) {
        if (allowStale && latestPositionsCache.data) {
            return latestPositionsCache.data;
        }
        throw error;
    }

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
        } else if (status === 429 && latestPositionsCache.data) {
            // Locator throttled us (max 3/min). Serve last known positions instead of failing.
            return { ...latestPositionsCache.data, stale: true, rateLimited: true };
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

    const result = {
        positions,
        notexist: payload?.data?.notexist || [],
        total: payload?.data?.total ?? positions.length,
    };

    latestPositionsCache = { at: Date.now(), data: result };
    for (const position of positions) logLocatorPositionComparison(position);
    return result;
}

async function getReportToken({ force = false } = {}) {
    const session = await locatorLogin({ force });
    return session?.reportToken || null;
}

function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function summaryRowsFromPayload(payload) {
    const data = payload?.data ?? payload;
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    for (const key of ['summary', 'vehicles', 'rows', 'list', 'vehicleSummary', 'trips']) {
        if (Array.isArray(data[key])) return data[key];
    }
    if (data.distanceTravelled != null || data.vehicleId != null || data.deviceId != null) return [data];
    return [];
}

function summaryDeviceId(row) {
    const id = Number(row?.vehicleId ?? row?.deviceId ?? row?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
}

export function normalizeVehicleSummaryRow(row) {
    const distanceKm = metersToKm(row?.distanceTravelled);
    const drivingTimeMs = finiteOrNull(row?.drivingTime);
    const idleTimeMs = finiteOrNull(row?.idleTime);
    const startOdometerKm = metersToKm(row?.startOdometer);
    const endOdometerKm = metersToKm(row?.endOdometer);
    return {
        deviceId: summaryDeviceId(row),
        raw: {
            distanceTravelled: row?.distanceTravelled ?? null,
            drivingTime: row?.drivingTime ?? null,
            idleTime: row?.idleTime ?? null,
            averageSpeed: row?.averageSpeed ?? null,
            maxSpeed: row?.maxSpeed ?? null,
            currentBattery: row?.currentBattery ?? null,
            totalTrips: row?.totalTrips ?? null,
            startOdometer: row?.startOdometer ?? null,
            endOdometer: row?.endOdometer ?? null,
        },
        distanceKm: distanceKm == null ? null : Number(distanceKm.toFixed(3)),
        drivingTimeMs,
        idleTimeMs,
        drivingTimeLabel: drivingTimeMs == null ? '' : formatDuration(drivingTimeMs),
        idleTimeLabel: idleTimeMs == null ? '' : formatDuration(idleTimeMs),
        averageSpeedKmh: finiteOrNull(row?.averageSpeed),
        maxSpeedKmh: finiteOrNull(row?.maxSpeed),
        totalTrips: finiteOrNull(row?.totalTrips),
        startOdometerKm: startOdometerKm == null ? null : Number(startOdometerKm.toFixed(2)),
        endOdometerKm: endOdometerKm == null ? null : Number(endOdometerKm.toFixed(2)),
        currentBattery: row?.currentBattery ?? null,
    };
}

export function normalizeTripSummaryRow(row) {
    const distanceKm = metersToKm(row?.distance);
    const drivingTimeMs = finiteOrNull(row?.drivingTime);
    const idleTimeMs = finiteOrNull(row?.idleTime);
    return {
        ...row,
        distanceKm: distanceKm == null ? null : Number(distanceKm.toFixed(3)),
        drivingTimeMs,
        idleTimeMs,
        drivingTimeLabel: drivingTimeMs == null ? '' : formatDuration(drivingTimeMs),
        idleTimeLabel: idleTimeMs == null ? '' : formatDuration(idleTimeMs),
        averageSpeedKmh: finiteOrNull(row?.averageSpeed),
        maxSpeedKmh: finiteOrNull(row?.maxSpeed),
    };
}

async function postLocatorReport(path, body) {
    const client = buildApiClient();
    let token = await getReportToken();
    if (!token) {
        const error = new Error('Locator report token is missing. Summary was not requested with the live token.');
        error.code = 'LOCATOR_REPORT_TOKEN_MISSING';
        throw error;
    }

    const send = (authToken) =>
        client.post(path, body, {
            headers: { Authorization: authToken },
        });

    let response;
    try {
        response = await send(token);
    } catch (error) {
        const status = error?.response?.status;
        if (status === 401 || status === 403) {
            token = await getReportToken({ force: true });
            if (!token) throw error;
            response = await send(token);
        } else {
            throw error;
        }
    }

    const payload = response?.data;
    if (payload?.success === false) {
        throw new Error(payload?.message || 'Locator report request failed');
    }
    return payload;
}

export async function fetchVehicleWiseSummary({ vehicleIds, from, to } = {}) {
    assertRateLimit('vehicle-wise-summary', 6, 60 * 1000);
    const ids = [...new Set((vehicleIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
    if (!ids.length || !from || !to) return [];
    const payload = await postLocatorReport('/v1/summary/vehicle-wise', {
        vehicleIds: ids,
        from,
        to,
    });
    const rows = summaryRowsFromPayload(payload).map(normalizeVehicleSummaryRow).filter((row) => row.deviceId);
    logLocatorSummaryComparison(rows[0], { from, to });
    return rows;
}

const EXCESSIVE_IDLING_REPORT_ID = 62;
/** Portal Excessive Idling Report option labeled "5 Minutes". Value is seconds. */
const EXCESSIVE_IDLING_MIN_SECONDS = 350;
const excessiveIdleCache = new Map();
let gatewaySession = null;

function gatewayBaseUrl() {
    const { apiBaseUrl } = getLocatorConfig();
    const origin = new URL(apiBaseUrl).origin;
    return `${origin}/gateway/index.php`;
}

function cleanLocatorError(error, fallback) {
    const message = error?.response?.data?.message;
    const text = typeof message === 'string' && message.trim() ? message.trim().slice(0, 180) : fallback;
    const wrapped = new Error(text || fallback);
    wrapped.statusCode = error?.response?.status;
    return wrapped;
}

async function gatewayLogin({ force = false } = {}) {
    assertLocatorConfig();
    if (!force && gatewaySession?.token && Date.now() - gatewaySession.at < 20 * 60 * 1000) {
        return gatewaySession;
    }

    const { username, password, isAdmin } = getLocatorConfig();
    let response;
    try {
        response = await axios.post(
            `${gatewayBaseUrl()}/api-v1/user/postlogin`,
            {
                user_name: username,
                user_password: password,
                isAdmin,
            },
            { timeout: 30000 },
        );
    } catch (error) {
        throw cleanLocatorError(error, 'Locator gateway login failed');
    }

    const token = response?.data?.token;
    if (!token) {
        throw new Error('Locator gateway login failed');
    }

    gatewaySession = {
        token,
        vehicles: Array.isArray(response.data?.vehicles) ? response.data.vehicles : [],
        at: Date.now(),
    };
    return gatewaySession;
}

function excessiveIdleCacheKey(vehicleIds, from, to) {
    return `${from}|${to}|${[...vehicleIds].sort((a, b) => a - b).join(',')}`;
}

function excessiveBlocks(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object' && payload.vehicles) return [payload];
    return [];
}

function excessiveEvents(vehicles) {
    const data = vehicles?.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') return Object.values(data);
    return [];
}

/**
 * Official Excessive Idling Report (portal report 62).
 * Durations are milliseconds. Vehicles with no sessions are returned as 0.
 * Does not use the live position token.
 */
export async function fetchExcessiveIdlingReport({ vehicleIds, from, to } = {}) {
    const ids = [...new Set((vehicleIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
    if (!ids.length || !from || !to) return new Map();

    const cacheKey = excessiveIdleCacheKey(ids, from, to);
    const cached = excessiveIdleCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60 * 1000) return cached.map;

    assertRateLimit('excessive-idling', 6, 60 * 1000);

    const session = await gatewayLogin();
    const vehiclesById = new Map(
        (session.vehicles || [])
            .map((vehicle) => [Number(vehicle?.id), vehicle])
            .filter(([id]) => Number.isFinite(id) && id > 0),
    );
    const vehIDs = [];
    const idByUniqueId = new Map();
    for (const id of ids) {
        const vehicle = vehiclesById.get(id);
        if (!vehicle?.name) continue;
        const uniqueId = String(vehicle.uniqueId || '');
        vehIDs.push([vehicle.name, uniqueId, vehicle.id, vehicle.category || '']);
        if (uniqueId) idByUniqueId.set(uniqueId, id);
    }
    if (!vehIDs.length) return new Map();

    const body = {
        reportID: EXCESSIVE_IDLING_REPORT_ID,
        vehIDs,
        fromDate: from,
        toDate: to,
        fromTime: '19:00',
        toTime: '23:00',
        selectedIdlingDuration: EXCESSIVE_IDLING_MIN_SECONDS,
        rptDriverIDs: [],
        rptGzIDs: {},
    };

    const postReport = (token) =>
        axios.post(`${gatewayBaseUrl()}/ReportCreator`, JSON.stringify(body), {
            headers: {
                Xtoken: token,
                'X-XSRF-TOKEN': token,
                'Content-Type': 'application/json',
            },
            timeout: 60000,
            validateStatus: () => true,
        });

    const postWithRetry = async (token) => {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await postReport(token);
            } catch (error) {
                lastError = error;
                if (error?.response) throw cleanLocatorError(error, 'Excessive idling report failed');
                await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
            }
        }
        throw cleanLocatorError(lastError, 'Excessive idling report failed');
    };

    let response = await postWithRetry(session.token);
    const unauthorized =
        response.status === 401 ||
        response.status === 403 ||
        response.data?.message === 'The payload is invalid.';
    if (unauthorized) {
        const refreshed = await gatewayLogin({ force: true });
        response = await postWithRetry(refreshed.token);
    }
    if (response.status >= 400 || response.data?.exception) {
        const message =
            typeof response.data?.message === 'string' ? response.data.message.slice(0, 180) : 'Excessive idling report failed';
        throw new Error(message);
    }

    const totals = new Map();
    for (const block of excessiveBlocks(response.data)) {
        const fallbackId = idByUniqueId.get(String(block?.deviceid || '')) || null;
        const events = excessiveEvents(block?.vehicles);
        if (!events.length) {
            if (fallbackId && !totals.has(fallbackId)) totals.set(fallbackId, 0);
            continue;
        }
        for (const event of events) {
            const deviceId = Number(event?.deviceId) || fallbackId;
            const duration = Number(event?.duration);
            if (!deviceId || !Number.isFinite(duration) || duration < 0) continue;
            totals.set(deviceId, (totals.get(deviceId) || 0) + duration);
        }
    }
    for (const id of ids) {
        if (vehiclesById.has(id) && !totals.has(id)) totals.set(id, 0);
    }

    const map = new Map(
        [...totals.entries()].map(([deviceId, idleTimeMs]) => [
            String(deviceId),
            { deviceId, idleTimeMs },
        ]),
    );
    excessiveIdleCache.set(cacheKey, { at: Date.now(), map });
    return map;
}

export async function fetchTripWiseSummary({ vehicleIds, from, to } = {}) {
    assertRateLimit('trip-wise-summary', 6, 60 * 1000);
    const ids = [...new Set((vehicleIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
    if (!ids.length || !from || !to) return [];
    const payload = await postLocatorReport('/v1/summary/trip-wise', {
        vehicleIds: ids,
        from,
        to,
    });
    return summaryRowsFromPayload(payload).map(normalizeTripSummaryRow);
}

let locatorCompareLogged = false;

export function logLocatorPositionComparison(position) {
    if (process.env.LOCATOR_DEBUG_COMPARE !== 'true' || !position) return;
    const wanted = String(process.env.LOCATOR_DEBUG_DEVICE_ID || '').trim();
    if (wanted && String(position.deviceId) !== wanted) return;
    if (!wanted && locatorCompareLogged) return;
    locatorCompareLogged = true;
    const attrs = position.attributes || {};
    console.info('[LocatorCompare][latest]', {
        deviceId: position.deviceId,
        imei: attrs.uniqueId || position.uniqueId || '',
        rawSpeedKnots: position.speed ?? null,
        speedKmh: position.speedKmh ?? null,
        latitude: position.latitude ?? null,
        longitude: position.longitude ?? null,
        ignition: attrs.ignition ?? null,
        motion: attrs.motion ?? null,
        state: attrs.state ?? null,
        livestatus: position.livestatus ?? null,
        deviceTime: position.deviceTime ?? null,
        serverTime: position.serverTime ?? null,
        fixTime: position.fixTime ?? null,
        outdated: position.outdated ?? null,
        valid: position.valid ?? null,
        rawOdometerMeters: rawOdometerMeters(position),
        totalDistanceKm: currentDistanceKm(position),
        sampleTime: locatorSampleTime(position)?.toISOString() || null,
    });
}

function logLocatorSummaryComparison(row, range) {
    if (process.env.LOCATOR_DEBUG_COMPARE !== 'true' || !row) return;
    console.info('[LocatorCompare][summary]', {
        deviceId: row.deviceId,
        from: range?.from || '',
        to: range?.to || '',
        rawDistanceTravelled: row.raw?.distanceTravelled ?? null,
        distanceKm: row.distanceKm,
        rawDrivingTimeMs: row.raw?.drivingTime ?? null,
        drivingTime: row.drivingTimeLabel,
        rawIdleTimeMs: row.raw?.idleTime ?? null,
        idleTime: row.idleTimeLabel,
        rawStartOdometer: row.raw?.startOdometer ?? null,
        startOdometerKm: row.startOdometerKm,
        rawEndOdometer: row.raw?.endOdometer ?? null,
        endOdometerKm: row.endOdometerKm,
        totalTrips: row.totalTrips,
    });
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

    let reportTokenConfigured = false;

    if (configured) {
        const stored = await readLocatorTokens();
        loggedIn = Boolean(stored?.token);
        tokenUpdatedAt = stored?.updated_at || null;
        reportTokenConfigured = Boolean(stored?.reportToken);
    }

    return {
        configured,
        loggedIn,
        reportTokenConfigured,
        tokenUpdatedAt,
        apiBaseUrl: getLocatorConfig().apiBaseUrl,
        websocketEnabled: process.env.LOCATOR_WS_ENABLED === 'true',
    };
}

export async function resetLocatorSession() {
    await clearLocatorTokens();
}
