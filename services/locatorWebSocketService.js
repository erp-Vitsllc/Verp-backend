import {
    buildLocatorWebSocketUrl,
    isLocatorConfigured,
    normalizeWebSocketPosition,
} from './locatorService.js';

const RECONNECT_DELAY_MS = 10 * 1000;

let socket = null;
let reconnectTimer = null;
let started = false;

const latestByDeviceId = new Map();
const latestByUniqueId = new Map();

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function scheduleReconnect() {
    if (!started || reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectLocatorWebSocket();
    }, RECONNECT_DELAY_MS);
}

function ingestPositions(positions) {
    if (!Array.isArray(positions)) return;

    for (const rawPosition of positions) {
        const position = normalizeWebSocketPosition(rawPosition);
        if (!position || typeof position !== 'object') continue;

        if (position.deviceId != null) {
            latestByDeviceId.set(String(position.deviceId), position);
        }

        if (position.uniqueId) {
            latestByUniqueId.set(String(position.uniqueId), position);
        }
        // Intentionally do NOT write Mongo from WS — ERP DB sync runs on a 10-min
        // REST job so continuous WS traffic never slows Vehicle Asset pages.
    }
}

function handleMessage(rawData) {
    const text = typeof rawData === 'string' ? rawData : String(rawData ?? '');
    if (!text.trim()) return;

    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            ingestPositions(parsed);
            return;
        }

        if (parsed && typeof parsed === 'object') {
            ingestPositions([parsed]);
        }
    } catch (error) {
        console.error('[LocatorWS] Failed to parse message:', error?.message || error);
    }
}

function closeActiveSocket() {
    if (!socket) return;

    try {
        socket.close();
    } catch {
        // ignore close errors while replacing the socket
    }

    socket = null;
}

function connectLocatorWebSocket() {
    if (!started || !isLocatorConfigured()) return;
    if (typeof globalThis.WebSocket !== 'function') {
        console.warn('[LocatorWS] Native WebSocket is unavailable in this Node runtime');
        return;
    }

    closeActiveSocket();

    try {
        const url = buildLocatorWebSocketUrl();
        const nextSocket = new globalThis.WebSocket(url);

        nextSocket.addEventListener('open', () => {
            console.log('[LocatorWS] Connected to Locator real-time feed');
        });

        nextSocket.addEventListener('message', (event) => {
            handleMessage(event.data);
        });

        nextSocket.addEventListener('close', () => {
            if (socket !== nextSocket) return;
            socket = null;
            console.warn('[LocatorWS] Connection closed. Reconnecting soon…');
            scheduleReconnect();
        });

        nextSocket.addEventListener('error', () => {
            console.error('[LocatorWS] Socket error');
        });

        socket = nextSocket;
    } catch (error) {
        console.error('[LocatorWS] Failed to connect:', error?.message || error);
        scheduleReconnect();
    }
}

export function startLocatorWebSocket() {
    if (started) return;
    if (!isLocatorConfigured()) {
        console.log('[LocatorWS] Skipped — LOCATOR_USERNAME / LOCATOR_PASSWORD not set');
        return;
    }
    // Opt-in only. Vehicle pages read ERP DB; scheduled 30-min REST sync owns Mongo updates.
    // Set LOCATOR_WS_ENABLED=true only if you need an in-memory live cache for admin tools.
    if (process.env.LOCATOR_WS_ENABLED !== 'true') {
        console.log('[LocatorWS] Skipped — set LOCATOR_WS_ENABLED=true to enable real-time feed');
        return;
    }

    started = true;
    connectLocatorWebSocket();
}

export function stopLocatorWebSocket() {
    started = false;
    clearReconnectTimer();
    closeActiveSocket();
}

export function getLocatorWebSocketStatus() {
    return {
        enabled: started,
        connected: socket?.readyState === globalThis.WebSocket?.OPEN,
        trackedDevices: latestByDeviceId.size,
        trackedUniqueIds: latestByUniqueId.size,
        lastUpdatedAt: getLatestCachedUpdatedAt(),
    };
}

function getLatestCachedUpdatedAt() {
    let latest = null;

    for (const position of latestByDeviceId.values()) {
        const deviceTime = position?.deviceTime ? Date.parse(position.deviceTime) : NaN;
        if (Number.isFinite(deviceTime) && (!latest || deviceTime > latest)) {
            latest = deviceTime;
        }
    }

    return latest;
}

export function getCachedLocatorPositions() {
    return Array.from(latestByDeviceId.values());
}

export function getCachedLocatorPositionByUniqueId(uniqueId) {
    if (!uniqueId) return null;
    return latestByUniqueId.get(String(uniqueId)) || null;
}
