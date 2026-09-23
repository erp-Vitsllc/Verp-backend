import { getClientIp } from './activityLog.js';

const STATUS_FIXED = 'fixed';
const STATUS_NOT_FIXED = 'not_fixed';
const DEVICE_STORE_MS = 30 * 24 * 60 * 60 * 1000;

function storeUntil(start) {
    const base = start ? new Date(start).getTime() : Date.now();
    const startMs = Number.isFinite(base) ? base : Date.now();
    return new Date(startMs + DEVICE_STORE_MS);
}

function normalizeIp(value) {
    let ip = String(value || '').trim();
    if (!ip) return '';
    if (ip.startsWith('[') && ip.includes(']')) {
        ip = ip.slice(1, ip.indexOf(']'));
    }
    if (ip.toLowerCase().startsWith('::ffff:')) {
        ip = ip.slice(7);
    }
    if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) {
        ip = ip.replace(/:\d+$/, '');
    }
    if (ip === '::1') return '127.0.0.1';
    return ip.slice(0, 64);
}

export function isLoopbackIp(value) {
    const ip = normalizeIp(value);
    return ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0';
}

/** Routable address. Loopback and LAN addresses are not the system's public IP. */
export function isPublicIp(value) {
    const ip = normalizeIp(value);
    if (!ip || isLoopbackIp(ip)) return false;
    if (ip.includes(':')) {
        const lower = ip.toLowerCase();
        if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return false;
        return true;
    }
    const parts = ip.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }
    const [a, b] = parts;
    if (a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
}

function ipFromRequest(req) {
    const body = req?.body && typeof req.body === 'object' ? req.body : {};
    const headers = req?.headers || {};
    const fromApp = [
        body.publicIp,
        body.publicIP,
        body.ipAddress,
        body.ip,
        body.clientIp,
        body.wifiIP,
        body.wifiIp,
        headers['x-verp-public-ip'],
    ].map(normalizeIp).find(isPublicIp);
    if (fromApp) return fromApp;

    const forwarded = headers['x-forwarded-for'];
    const forwardedList = Array.isArray(forwarded)
        ? forwarded
        : String(forwarded || '').split(',');
    const fromHeader = [
        ...forwardedList,
        headers['cf-connecting-ip'],
        headers['true-client-ip'],
        headers['x-client-ip'],
        headers['x-real-ip'],
    ].map(normalizeIp).find(isPublicIp);
    if (fromHeader) return fromHeader;

    const seen = normalizeIp(getClientIp(req));
    return isPublicIp(seen) ? seen : seen;
}

let outboundPublicIpCache = { at: 0, ip: '' };

async function lookupOutboundPublicIp() {
    const now = Date.now();
    if (outboundPublicIpCache.ip && now - outboundPublicIpCache.at < 10 * 60 * 1000) {
        return outboundPublicIpCache.ip;
    }
    try {
        const response = await fetch('https://api.ipify.org?format=json', {
            signal: AbortSignal.timeout(4000),
        });
        const payload = await response.json().catch(() => ({}));
        const ip = normalizeIp(payload?.ip);
        if (isPublicIp(ip)) {
            outboundPublicIpCache = { at: now, ip };
            return ip;
        }
    } catch {
        /* keep the stored address when the lookup is unreachable */
    }
    return outboundPublicIpCache.ip || '';
}

/**
 * Public IP of the browser or phone that made this request.
 * Never substitutes this API machine's own address.
 */
export async function resolvePublicClientIp(req) {
    const seen = ipFromRequest(req);
    if (isPublicIp(seen)) return seen;
    if (seen && !isLoopbackIp(seen)) return seen;
    return '';
}

/**
 * Address to show on Active Session.
 * Loopback and this API machine's own public IP are hidden, because those
 * were stored for every user when the real client address was missing.
 */
export async function displaySessionIp(ip, { clientIp = '', isCurrentDevice = false } = {}) {
    const stored = normalizeIp(ip);
    const client = normalizeIp(clientIp);
    if (isCurrentDevice && isPublicIp(client)) return client;
    if (!stored || isLoopbackIp(stored)) return '';
    if (!isPublicIp(stored)) return stored;
    const serverIp = await lookupOutboundPublicIp();
    if (serverIp && stored === serverIp && client !== serverIp) return '';
    return stored;
}

/** Keep the saved session address in step with the system that is using it. */
export function noteWebDeviceIp(user, deviceId, ipAddress) {
    const id = String(deviceId || '').trim();
    const ip = normalizeIp(ipAddress);
    if (!user || !id || !isPublicIp(ip)) return false;
    let changed = false;
    const rows = Array.isArray(user.webLoginDevices) ? user.webLoginDevices : [];
    const row = rows.find((item) => rememberedWebDeviceId(item) === id);
    if (row && normalizeIp(row.ipAddress) !== ip) {
        row.ipAddress = ip;
        user.markModified?.('webLoginDevices');
        changed = true;
    }
    if (String(user.webLogin?.deviceId || '').trim() === id && normalizeIp(user.webLogin?.ipAddress) !== ip) {
        user.webLogin.ipAddress = ip;
        user.markModified?.('webLogin');
        changed = true;
    }
    return changed;
}

function toFiniteNumber(value) {
    if (value == null || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(n) ? n : null;
}

/** GPS from app lat/lng fields, or from a "lat, lng" location string. */
export function parseMobileDeviceCoordinates({ location, latitude, longitude } = {}) {
    let lat = toFiniteNumber(latitude);
    let lng = toFiniteNumber(longitude);
    if (lat == null || lng == null) {
        const text = String(location || '').trim();
        const match = text.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
        if (match) {
            lat = toFiniteNumber(match[1]);
            lng = toFiniteNumber(match[2]);
        }
    }
    if (lat == null || lng == null) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { latitude: lat, longitude: lng };
}

export function emptyMobileDevice() {
    return {
        deviceId: '',
        deviceName: '',
        location: '',
        latitude: null,
        longitude: null,
        ipAddress: '',
        lastSeenAt: null,
        storedAt: null,
        trustedUntil: null,
        status: STATUS_NOT_FIXED,
    };
}

export function getDeviceTrust(user) {
    const until = user?.mobileDevice?.trustedUntil;
    const untilMs = until ? new Date(until).getTime() : 0;
    const daysLeft = untilMs > Date.now() ? Math.ceil((untilMs - Date.now()) / 86400000) : 0;
    return {
        fixed: daysLeft > 0,
        daysLeft,
        trustedUntil: daysLeft > 0 ? until : null,
    };
}

export function expireDeviceTrustIfNeeded(user) {
    if (!user?.mobileDevice) return;
    const device = user.mobileDevice;
    const trusted = device.status === STATUS_FIXED || device.trustedUntil;
    if (!trusted) return;
    if (!device.storedAt) {
        device.storedAt = device.lastSeenAt || new Date();
        user.markModified?.('mobileDevice');
    }
    const maxUntil = storeUntil(device.storedAt);
    const current = device.trustedUntil ? new Date(device.trustedUntil).getTime() : 0;
    if (!current || current > maxUntil.getTime()) {
        device.trustedUntil = maxUntil;
        user.markModified?.('mobileDevice');
    }
    if (maxUntil.getTime() <= Date.now()) {
        user.mobileDevice = emptyMobileDevice();
        user.markModified?.('mobileDevice');
    }
}

export function isDeviceTrustedForOtp(user, deviceId) {
    expireDeviceTrustIfNeeded(user);
    const storedId = String(user?.mobileDevice?.deviceId || '').trim();
    const nextId = String(deviceId || '').trim();
    if (!storedId || !nextId || storedId !== nextId) return false;
    return getDeviceTrust(user).fixed;
}

export function isMobileReviewBypass(user) {
    return user?.mobileReviewBypass === true;
}

export async function employeeHasMobileReviewBypass(employee) {
    const employeeId = String(employee?.employeeId || '').trim();
    if (!employeeId) return false;
    const User = (await import('../models/User.js')).default;
    const user = await User.findOne({ employeeId }).select('mobileReviewBypass').lean();
    return user?.mobileReviewBypass === true;
}

export function applyDeviceTrust(user, enabled) {
    if (!user?.mobileDevice || typeof user.mobileDevice !== 'object') {
        user.mobileDevice = emptyMobileDevice();
    }
    // Review login must work from whatever iPhone Apple uses.
    if (enabled && isMobileReviewBypass(user)) {
        enabled = false;
    }
    if (enabled) {
        const now = new Date();
        user.mobileDevice.status = STATUS_FIXED;
        user.mobileDevice.storedAt = now;
        user.mobileDevice.trustedUntil = storeUntil(now);
    } else {
        user.mobileDevice.status = STATUS_NOT_FIXED;
        user.mobileDevice.storedAt = null;
        user.mobileDevice.trustedUntil = null;
    }
    user.markModified?.('mobileDevice');
}

export function serializeMobileDevice(user) {
    expireDeviceTrustIfNeeded(user);
    const stored = user?.mobileDevice && typeof user.mobileDevice === 'object'
        ? user.mobileDevice
        : {};
    const trust = getDeviceTrust(user);
    const status = trust.fixed ? STATUS_FIXED : STATUS_NOT_FIXED;
    const deviceName = String(stored.deviceName || '').trim();
    const location = String(stored.location || '').trim();
    const deviceId = String(stored.deviceId || '').trim();
    const coords = parseMobileDeviceCoordinates(stored);
    const hasDevice = Boolean(deviceId || deviceName || location || stored.ipAddress || coords);
    const ipAddress = hasDevice
        ? (normalizeIp(stored.ipAddress) || normalizeIp(user?.lastLoginIp))
        : '';
    return {
        deviceName: deviceName || '',
        location: location || '',
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
        ipAddress: ipAddress || '',
        lastSeenAt: stored.lastSeenAt || null,
        status,
        statusLabel: status === STATUS_FIXED ? 'Fixed' : 'Not Fixed',
        hasDevice,
        canFix: Boolean(deviceId),
        ...trust,
    };
}

export function readMobileDeviceFromRequest(req) {
    const body = req?.body && typeof req.body === 'object' ? req.body : {};
    const nested =
        body.location && typeof body.location === 'object' && !Array.isArray(body.location)
            ? body.location
            : {};
    const deviceId = String(body.deviceId || body.deviceID || '').trim();
    const deviceName = String(body.deviceName || body.device || '').trim();
    let location =
        typeof body.location === 'string'
            ? body.location.trim()
            : String(body.deviceLocation || nested.label || '').trim();
    const coords = parseMobileDeviceCoordinates({
        location,
        latitude: body.latitude ?? body.lat ?? nested.latitude ?? nested.lat,
        longitude:
            body.longitude ??
            body.lng ??
            body.lon ??
            nested.longitude ??
            nested.lng ??
            nested.lon,
    });
    return {
        deviceId,
        deviceName,
        location,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
        ipAddress: ipFromRequest(req),
    };
}

function applyIncomingDevice(user, incoming) {
    if (!user.mobileDevice || typeof user.mobileDevice !== 'object') {
        user.mobileDevice = emptyMobileDevice();
    }
    if (incoming.deviceId) user.mobileDevice.deviceId = incoming.deviceId;
    if (incoming.deviceName) user.mobileDevice.deviceName = incoming.deviceName;
    if (incoming.location) user.mobileDevice.location = incoming.location;
    if (incoming.latitude != null && incoming.longitude != null) {
        user.mobileDevice.latitude = incoming.latitude;
        user.mobileDevice.longitude = incoming.longitude;
    }
    if (incoming.ipAddress) {
        user.mobileDevice.ipAddress = normalizeIp(incoming.ipAddress);
        user.lastLoginIp = user.mobileDevice.ipAddress;
    }
    user.mobileDevice.lastSeenAt = new Date();
    user.markModified?.('mobileDevice');
}

/** Block app login when the account is fixed to a different phone. */
export function mobileDeviceLoginDenied(user, incoming, { isSystemAdmin = false } = {}) {
    if (isSystemAdmin || isMobileReviewBypass(user)) return null;
    const stored = user?.mobileDevice;
    if (!stored || stored.status !== STATUS_FIXED) return null;
    const lockedId = String(stored.deviceId || '').trim();
    if (!lockedId) return null;
    const nextId = String(incoming?.deviceId || '').trim();
    if (!nextId) {
        return 'This account is fixed to one mobile. Open the VeRP app from that phone, or ask admin to change device details.';
    }
    if (nextId !== lockedId) {
        return 'This account can only be used from the fixed mobile device. Ask admin to change device details.';
    }
    return null;
}

/** Update current phone when not fixed; refresh last-seen when fixed and same phone. */
export function recordMobileDeviceOnUser(user, incoming, { isSystemAdmin = false } = {}) {
    if (!user || isSystemAdmin) return;
    const payload = incoming && typeof incoming === 'object' ? incoming : {};
    if (!payload.deviceId && !payload.deviceName && !payload.ipAddress) return;

    const stored = user.mobileDevice;
    const isFixed = stored?.status === STATUS_FIXED;
    const previousId = String(stored?.deviceId || '').trim();
    if (isFixed) {
        const lockedId = previousId;
        const nextId = String(payload.deviceId || '').trim();
        if (lockedId && nextId && lockedId !== nextId) return;
        applyIncomingDevice(user, payload);
        return;
    }
    applyIncomingDevice(user, payload);
    user.mobileDevice.status = STATUS_NOT_FIXED;
    const nextId = String(payload.deviceId || '').trim();
    if (nextId && previousId && nextId !== previousId) {
        if (!payload.deviceName) user.mobileDevice.deviceName = '';
        if (!payload.location && payload.latitude == null && payload.longitude == null) {
            user.mobileDevice.location = '';
            user.mobileDevice.latitude = null;
            user.mobileDevice.longitude = null;
        }
        user.markModified?.('mobileDevice');
    }
}

export function fixMobileDeviceOnUser(user) {
    if (!user) return { ok: false, message: 'User not found' };
    if (isMobileReviewBypass(user)) {
        applyDeviceTrust(user, false);
        return {
            ok: false,
            message: 'This review account can sign in from any phone. It is not locked to one device.',
        };
    }
    if (!user.mobileDevice || typeof user.mobileDevice !== 'object') {
        user.mobileDevice = emptyMobileDevice();
    }
    const deviceId = String(user.mobileDevice.deviceId || '').trim();
    if (!deviceId) {
        return {
            ok: false,
            message: 'No mobile has logged in yet. Ask the user to open the VeRP app first, then click Fix.',
        };
    }
    applyDeviceTrust(user, true);
    return { ok: true };
}

export function changeMobileDeviceOnUser(user) {
    if (!user) return { ok: false, message: 'User not found' };
    user.mobileDevice = emptyMobileDevice();
    user.markModified?.('mobileDevice');
    return { ok: true };
}

function deviceNameFromUserAgent(ua) {
    const text = String(ua || '');
    if (/Windows/i.test(text)) return 'Windows PC';
    if (/Mac OS X|Macintosh/i.test(text)) return 'Mac';
    if (/CrOS/i.test(text)) return 'Chromebook';
    if (/Linux/i.test(text)) return 'Linux PC';
    if (/Android/i.test(text)) return 'Android browser';
    if (/iPhone|iPad|iPod/i.test(text)) return 'iOS browser';
    return text ? 'Web browser' : '';
}

export function osFromUserAgent(ua) {
    const text = String(ua || '');
    if (/Windows NT|Windows/i.test(text)) return 'Windows';
    if (/Mac OS X|Macintosh/i.test(text)) return 'macOS';
    if (/CrOS/i.test(text)) return 'ChromeOS';
    if (/Android/i.test(text)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(text)) return 'iOS';
    if (/Linux/i.test(text)) return 'Linux';
    return '';
}

export function emptyWebLogin() {
    return {
        deviceId: '',
        deviceName: '',
        os: '',
        latitude: null,
        longitude: null,
        location: '',
        ipAddress: '',
        userAgent: '',
        lastSeenAt: null,
        trustedUntil: null,
        status: STATUS_NOT_FIXED,
    };
}

export function getWebDeviceTrust(user) {
    const until = user?.webLogin?.trustedUntil;
    const untilMs = until ? new Date(until).getTime() : 0;
    const daysLeft = untilMs > Date.now() ? Math.ceil((untilMs - Date.now()) / 86400000) : 0;
    return {
        fixed: daysLeft > 0,
        daysLeft,
        trustedUntil: daysLeft > 0 ? until : null,
    };
}

function webDeviceStillStored(row, now = Date.now()) {
    const id = rememberedWebDeviceId(row);
    if (!id) return false;
    if (!row.storedAt) {
        row.storedAt = row.lastSeenAt || new Date();
    }
    const maxUntil = storeUntil(row.storedAt);
    const current = row.trustedUntil ? new Date(row.trustedUntil).getTime() : 0;
    if (!current || current > maxUntil.getTime()) {
        row.trustedUntil = maxUntil;
    }
    return maxUntil.getTime() > now;
}

export function expireWebDevicesIfNeeded(user) {
    if (!user) return;
    const now = Date.now();
    const rows = Array.isArray(user.webLoginDevices) ? user.webLoginDevices : [];
    const keep = [];
    let changed = false;
    for (const row of rows) {
        const hadWindow = Boolean(row?.storedAt && row?.trustedUntil);
        const alive = webDeviceStillStored(row, now);
        if (!alive) {
            changed = true;
            continue;
        }
        if (!hadWindow) changed = true;
        keep.push(row);
    }
    if (changed || keep.length !== rows.length) {
        user.webLoginDevices = keep;
        user.markModified?.('webLoginDevices');
    }
    const liveIds = new Set(keep.map((row) => rememberedWebDeviceId(row)));
    const currentId = String(user.webLogin?.deviceId || '').trim();
    if (currentId && !liveIds.has(currentId)) {
        user.webLogin.deviceId = '';
        user.webLogin.trustedUntil = null;
        user.webLogin.status = STATUS_NOT_FIXED;
        user.markModified?.('webLogin');
    } else if (user.webLogin?.trustedUntil && new Date(user.webLogin.trustedUntil).getTime() <= now) {
        user.webLogin.trustedUntil = null;
        user.webLogin.status = STATUS_NOT_FIXED;
        user.markModified?.('webLogin');
    }
}

export function expireWebTrustIfNeeded(user) {
    expireWebDevicesIfNeeded(user);
}

function rememberedWebDeviceId(row) {
    return String(row?.deviceId || '').trim();
}

function rememberedWebDevices(user) {
    const rows = [];
    const seen = new Set();
    const push = (row) => {
        const id = rememberedWebDeviceId(row);
        if (!id || seen.has(id)) return;
        seen.add(id);
        rows.push(row);
    };
    if (Array.isArray(user?.webLoginDevices)) {
        user.webLoginDevices.forEach(push);
    }
    push(user?.webLogin);
    return rows;
}

export function isWebDeviceTrusted(user, deviceId, os) {
    expireWebDevicesIfNeeded(user);
    const nextId = String(deviceId || '').trim();
    if (!nextId) return false;
    const nextOs = String(os || '').trim().toLowerCase();
    return rememberedWebDevices(user).some((row) => {
        if (rememberedWebDeviceId(row) !== nextId) return false;
        const rowOs = String(row.os || osFromUserAgent(row.userAgent) || '').trim().toLowerCase();
        if (rowOs && nextOs && rowOs !== nextOs) return false;
        return true;
    });
}

export function applyWebDeviceTrust(user, enabled) {
    if (!user?.webLogin || typeof user.webLogin !== 'object') {
        user.webLogin = emptyWebLogin();
    }
    if (enabled) {
        user.webLogin.status = STATUS_FIXED;
        user.webLogin.trustedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    } else {
        user.webLogin.status = STATUS_NOT_FIXED;
        user.webLogin.trustedUntil = null;
    }
    user.markModified?.('webLogin');
}

export function webDeviceLoginDenied() {
    return null;
}

function rememberWebDeviceOnUser(user, incoming = {}) {
    const id = String(incoming.deviceId || user?.webLogin?.deviceId || '').trim();
    if (!id || !user) return;
    if (!Array.isArray(user.webLoginDevices)) user.webLoginDevices = [];
    const idx = user.webLoginDevices.findIndex((row) => rememberedWebDeviceId(row) === id);
    const prev = idx >= 0 ? user.webLoginDevices[idx] : null;
    const storedAt = prev?.storedAt ? new Date(prev.storedAt) : new Date();
    const trustedUntil = prev?.trustedUntil && new Date(prev.trustedUntil).getTime() > Date.now()
        ? new Date(prev.trustedUntil)
        : storeUntil(storedAt);
    const next = {
        deviceId: id,
        deviceName: String(incoming.deviceName || prev?.deviceName || user.webLogin?.deviceName || '').trim().slice(0, 80),
        os: String(incoming.os || prev?.os || user.webLogin?.os || '').trim().slice(0, 40),
        userAgent: String(incoming.userAgent || prev?.userAgent || user.webLogin?.userAgent || '').trim().slice(0, 240),
        ipAddress: normalizeIp(incoming.ipAddress || prev?.ipAddress || user.webLogin?.ipAddress),
        location: String(incoming.location || incoming.label || prev?.location || user.webLogin?.location || '').trim(),
        latitude: toFiniteNumber(incoming.latitude) ?? toFiniteNumber(prev?.latitude) ?? user.webLogin?.latitude ?? null,
        longitude: toFiniteNumber(incoming.longitude) ?? toFiniteNumber(prev?.longitude) ?? user.webLogin?.longitude ?? null,
        lastSeenAt: new Date(),
        storedAt,
        trustedUntil: storeUntil(storedAt).getTime() < new Date(trustedUntil).getTime()
            ? storeUntil(storedAt)
            : trustedUntil,
    };
    if (idx >= 0) user.webLoginDevices[idx] = next;
    else user.webLoginDevices.push(next);
    if (user.webLoginDevices.length > 15) {
        user.webLoginDevices.sort((a, b) => {
            const at = a?.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
            const bt = b?.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
            return bt - at;
        });
        user.webLoginDevices = user.webLoginDevices.slice(0, 15);
    }
    user.markModified?.('webLoginDevices');
}

export function serializeWebLogin(user) {
    expireWebTrustIfNeeded(user);
    const stored = user?.webLogin && typeof user.webLogin === 'object' ? user.webLogin : {};
    const trust = getWebDeviceTrust(user);
    const status = trust.fixed ? STATUS_FIXED : STATUS_NOT_FIXED;
    const coords = parseMobileDeviceCoordinates(stored);
    const userAgent = String(stored.userAgent || '').trim();
    const os = String(stored.os || osFromUserAgent(userAgent)).trim();
    const deviceName = String(stored.deviceName || deviceNameFromUserAgent(userAgent)).trim();
    const ipAddress = normalizeIp(stored.ipAddress) || '';
    const location = String(stored.location || '').trim();
    const deviceId = String(stored.deviceId || '').trim();
    const hasSession = Boolean(deviceId || coords || location || ipAddress || stored.lastSeenAt || userAgent || deviceName);
    return {
        deviceId,
        deviceName: deviceName || '',
        os: os || '',
        location: location || '',
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
        ipAddress: hasSession ? (ipAddress || normalizeIp(user?.lastLoginIp)) : '',
        userAgent,
        lastSeenAt: stored.lastSeenAt || null,
        status,
        statusLabel: status === STATUS_FIXED ? 'Fixed' : 'Not Fixed',
        hasSession,
        canChange: hasSession || trust.fixed || rememberedWebDevices(user).length > 0,
        deviceCount: rememberedWebDevices(user).length,
        ...trust,
    };
}

export function changeWebDeviceOnUser(user) {
    if (!user) return { ok: false, message: 'User not found' };
    user.webLogin = emptyWebLogin();
    user.webLoginDevices = [];
    user.markModified?.('webLogin');
    user.markModified?.('webLoginDevices');
    return { ok: true };
}

export function recordWebLoginOnUser(user, incoming = {}) {
    if (!user) return;
    if (!user.webLogin || typeof user.webLogin !== 'object') {
        user.webLogin = emptyWebLogin();
    }
    const lat = toFiniteNumber(incoming.latitude);
    const lng = toFiniteNumber(incoming.longitude);
    if (lat != null && lng != null) {
        user.webLogin.latitude = lat;
        user.webLogin.longitude = lng;
        if (incoming.location || incoming.label) {
            user.webLogin.location = String(incoming.location || incoming.label).trim();
        }
    } else if (incoming.location) {
        user.webLogin.location = String(incoming.location).trim();
        const parsed = parseMobileDeviceCoordinates({ location: incoming.location });
        if (parsed) {
            user.webLogin.latitude = parsed.latitude;
            user.webLogin.longitude = parsed.longitude;
        }
    }
    if (incoming.ipAddress) {
        user.webLogin.ipAddress = normalizeIp(incoming.ipAddress);
    }
    if (incoming.userAgent) {
        user.webLogin.userAgent = String(incoming.userAgent).trim().slice(0, 240);
    }
    if (incoming.deviceId) user.webLogin.deviceId = String(incoming.deviceId).trim();
    if (incoming.deviceName) user.webLogin.deviceName = String(incoming.deviceName).trim().slice(0, 80);
    else if (!user.webLogin.deviceName && incoming.userAgent) {
        user.webLogin.deviceName = deviceNameFromUserAgent(incoming.userAgent);
    }
    if (incoming.os) user.webLogin.os = String(incoming.os).trim().slice(0, 40);
    else if (!user.webLogin.os && incoming.userAgent) {
        user.webLogin.os = osFromUserAgent(incoming.userAgent);
    }
    user.webLogin.lastSeenAt = new Date();
    user.markModified?.('webLogin');
    rememberWebDeviceOnUser(user, incoming);
}

function sessionPlaceLabel(row) {
    const label = String(row?.location || '').trim();
    if (!label || /^-?\d+(?:\.\d+)?\s*[, ]\s*-?\d+(?:\.\d+)?$/.test(label)) return '';
    return label;
}

export function collectStoredDeviceSessions(user) {
    expireDeviceTrustIfNeeded(user);
    expireWebDevicesIfNeeded(user);
    const sessions = [];
    const seen = new Set();
    const pushWeb = (row) => {
        if (!row || typeof row !== 'object') return;
        const userAgent = String(row.userAgent || '');
        const deviceId = rememberedWebDeviceId(row);
        const deviceName = String(row.deviceName || deviceNameFromUserAgent(userAgent) || '').trim();
        const os = String(row.os || osFromUserAgent(userAgent) || '').trim();
        const ipAddress = normalizeIp(row.ipAddress);
        const coords = parseMobileDeviceCoordinates(row);
        const hasTrace = Boolean(deviceId || deviceName || os || ipAddress || row.lastSeenAt || row.location || coords);
        if (!hasTrace) return;
        const id = deviceId || 'web-latest';
        if (seen.has(id)) return;
        seen.add(id);
        sessions.push({
            source: 'web',
            deviceId: id,
            deviceName: deviceName || 'Web browser',
            os,
            ipAddress,
            location: sessionPlaceLabel(row),
            latitude: coords?.latitude ?? null,
            longitude: coords?.longitude ?? null,
            lastSeenAt: row.lastSeenAt || null,
            trustedUntil: row.trustedUntil || null,
        });
    };
    const webRows = Array.isArray(user?.webLoginDevices) ? user.webLoginDevices : [];
    for (const row of webRows) pushWeb(row);
    pushWeb(user?.webLogin);
    const trust = getDeviceTrust(user);
    const mobileId = String(user?.mobileDevice?.deviceId || '').trim();
    if (trust.fixed && mobileId) {
        const mobile = user.mobileDevice;
        const mobileCoords = parseMobileDeviceCoordinates(mobile);
        sessions.push({
            source: 'app',
            deviceId: mobileId,
            deviceName: String(mobile.deviceName || 'Mobile').trim(),
            os: '',
            ipAddress: normalizeIp(mobile.ipAddress),
            location: sessionPlaceLabel(mobile),
            latitude: mobileCoords?.latitude ?? null,
            longitude: mobileCoords?.longitude ?? null,
            lastSeenAt: mobile.lastSeenAt || null,
            trustedUntil: mobile.trustedUntil || null,
        });
    }
    return sessions;
}

export function removeStoredDevice(user, { source, deviceId } = {}) {
    const id = String(deviceId || '').trim();
    const kind = String(source || '').trim().toLowerCase();
    if (!user || !id) return false;
    if (kind === 'app') {
        if (String(user.mobileDevice?.deviceId || '').trim() !== id) return false;
        changeMobileDeviceOnUser(user);
        return true;
    }
    if (kind === 'web') {
        const rows = Array.isArray(user.webLoginDevices) ? user.webLoginDevices : [];
        const next = rows.filter((row) => rememberedWebDeviceId(row) !== id);
        const clearsLatest = id === 'web-latest' || String(user.webLogin?.deviceId || '').trim() === id;
        if (next.length === rows.length && !clearsLatest) return false;
        user.webLoginDevices = next;
        user.markModified?.('webLoginDevices');
        if (String(user.webLogin?.deviceId || '').trim() === id || id === 'web-latest') {
            user.webLogin = emptyWebLogin();
            user.markModified?.('webLogin');
        }
        return true;
    }
    return false;
}
