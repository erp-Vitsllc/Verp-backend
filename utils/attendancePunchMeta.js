import { parseMobileDeviceCoordinates } from './userMobileDevice.js';

const PUNCH_SOURCES = new Set(['app', 'web', 'manual']);

function finiteNumber(value) {
    if (value == null || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(n) ? n : null;
}

export function normalizePunchSource(value) {
    const raw = String(value || '')
        .trim()
        .toLowerCase();
    if (raw === 'app' || raw === 'portalapp' || raw === 'mobile') return 'app';
    if (raw === 'web' || raw === 'website' || raw === 'dashboard') return 'web';
    if (raw === 'manual' || raw === 'hr' || raw === 'mark') return 'manual';
    return '';
}

export function resolvePunchSource(req, fallback = 'web') {
    const body = req?.body && typeof req.body === 'object' ? req.body : {};
    const explicit = normalizePunchSource(
        body.source || body.channel || body.client || body.punchSource || body.checkType,
    );
    if (PUNCH_SOURCES.has(explicit)) return explicit;
    if (String(body.deviceId || body.deviceID || '').trim()) return 'app';
    const ua = String(req?.headers?.['user-agent'] || '').toLowerCase();
    if (/(okhttp|dart|flutter|capacitor|cordova|reactnative|verp[-_ ]?app|cfnetwork)/i.test(ua)) {
        return 'app';
    }
    return PUNCH_SOURCES.has(fallback) ? fallback : 'web';
}

export function parsePunchLocation(body = {}, source = '') {
    const nested = body.location && typeof body.location === 'object' ? body.location : {};
    const locationText =
        typeof body.location === 'string' ? body.location : body.locationLabel || nested.label || '';
    const coords = parseMobileDeviceCoordinates({
        location: locationText,
        latitude: body.latitude ?? body.lat ?? nested.latitude ?? nested.lat,
        longitude: body.longitude ?? body.lng ?? body.lon ?? nested.longitude ?? nested.lng ?? nested.lon,
    });
    if (!coords) return null;
    const accuracy = finiteNumber(body.accuracy ?? nested.accuracy);
    const label = String(body.locationLabel || body.address || nested.label || '').trim().slice(0, 240);
    const resolvedSource = normalizePunchSource(source) || normalizePunchSource(body.source);
    return {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: accuracy == null ? null : accuracy,
        label,
        source: PUNCH_SOURCES.has(resolvedSource) ? resolvedSource : '',
    };
}

export function punchLocationFields(prefix, location) {
    if (!location) return {};
    return { [prefix]: location };
}
