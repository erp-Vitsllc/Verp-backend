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

export function emptyMobileDevice() {
    return {
        deviceId: '',
        deviceName: '',
        location: '',
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
    const hasDevice = Boolean(deviceId || deviceName);
    const ipAddress = hasDevice
        ? (normalizeIp(stored.ipAddress) || normalizeIp(user?.lastLoginIp))
        : '';
    return {
        deviceName: deviceName || '',
        location: location || '',
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
    const lat = body.latitude ?? body.lat;
    const lng = body.longitude ?? body.lng ?? body.lon;
    if (!location && lat != null && lng != null && String(lat) !== '' && String(lng) !== '') {
        location = `${lat}, ${lng}`;
    }
    return {
        deviceId,
        deviceName,
        location,
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
        if (!payload.location) user.mobileDevice.location = '';
        if (payload.ipAddress) user.mobileDevice.ipAddress = normalizeIp(payload.ipAddress);
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
