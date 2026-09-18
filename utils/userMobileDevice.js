import { getClientIp } from './activityLog.js';

const STATUS_FIXED = 'fixed';
const STATUS_NOT_FIXED = 'not_fixed';

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

function ipFromRequest(req) {
    const body = req?.body && typeof req.body === 'object' ? req.body : {};
    const fromApp = [
        body.ipAddress,
        body.ip,
        body.clientIp,
        body.publicIp,
        body.publicIP,
        body.wifiIP,
        body.wifiIp,
    ].map(normalizeIp).find(Boolean);
    if (fromApp) return fromApp;

    const headers = req?.headers || {};
    const fromHeader = [
        headers['cf-connecting-ip'],
        headers['true-client-ip'],
        headers['x-client-ip'],
        headers['x-real-ip'],
    ].map(normalizeIp).find(Boolean);
    if (fromHeader) return fromHeader;

    return normalizeIp(getClientIp(req));
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
        status: STATUS_NOT_FIXED,
    };
}

export function serializeMobileDevice(user) {
    const stored = user?.mobileDevice && typeof user.mobileDevice === 'object'
        ? user.mobileDevice
        : {};
    const status = stored.status === STATUS_FIXED ? STATUS_FIXED : STATUS_NOT_FIXED;
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
    };
}

export function readMobileDeviceFromRequest(req) {
    const body = req?.body && typeof req.body === 'object' ? req.body : {};
    const deviceId = String(body.deviceId || body.deviceID || '').trim();
    const deviceName = String(body.deviceName || body.device || '').trim();
    let location = String(body.location || body.deviceLocation || '').trim();
    const coords = parseMobileDeviceCoordinates({
        location,
        latitude: body.latitude ?? body.lat,
        longitude: body.longitude ?? body.lng ?? body.lon,
    });
    if (!location && coords) {
        location = `${coords.latitude}, ${coords.longitude}`;
    }
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
        if (!incoming.location) {
            user.mobileDevice.location = `${incoming.latitude}, ${incoming.longitude}`;
        }
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
    if (isSystemAdmin) return null;
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
    user.mobileDevice.status = STATUS_FIXED;
    user.markModified?.('mobileDevice');
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

export function emptyWebLogin() {
    return {
        latitude: null,
        longitude: null,
        location: '',
        ipAddress: '',
        userAgent: '',
        lastSeenAt: null,
    };
}

export function serializeWebLogin(user) {
    const stored = user?.webLogin && typeof user.webLogin === 'object' ? user.webLogin : {};
    const coords = parseMobileDeviceCoordinates(stored);
    const userAgent = String(stored.userAgent || '').trim();
    const ipAddress = normalizeIp(stored.ipAddress) || '';
    const location = String(stored.location || '').trim();
    const hasSession = Boolean(coords || location || ipAddress || stored.lastSeenAt || userAgent);
    return {
        deviceName: deviceNameFromUserAgent(userAgent),
        location: location || '',
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
        ipAddress: hasSession ? (ipAddress || normalizeIp(user?.lastLoginIp)) : '',
        userAgent,
        lastSeenAt: stored.lastSeenAt || null,
        hasSession,
    };
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
        user.webLogin.location = String(incoming.location || incoming.label || `${lat}, ${lng}`).trim();
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
    user.webLogin.lastSeenAt = new Date();
    user.markModified?.('webLogin');
}
