import LocatorGpsSnapshot from '../models/LocatorGpsSnapshot.js';
import { fetchLatestPositions, isLocatorConfigured } from './locatorService.js';

const SNAPSHOT_MIN_INTERVAL_MS = 2 * 60 * 1000;
const lastSnapshotAtByDevice = new Map();

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toOdometerKm(attrs = {}) {
    if (attrs.totalDistanceKm != null && attrs.totalDistanceKm !== '') {
        const parsed = Number(String(attrs.totalDistanceKm).replace(/,/g, ''));
        if (Number.isFinite(parsed)) return Number(parsed.toFixed(2));
    }
    if (Number.isFinite(Number(attrs.totalDistance))) {
        return Number((Number(attrs.totalDistance) / 1000).toFixed(2));
    }
    if (Number.isFinite(Number(attrs.odometer))) {
        return Number((Number(attrs.odometer) / 1000).toFixed(2));
    }
    return 0;
}

function normalizeRestSnapshot(position) {
    const attrs = position?.attributes || {};
    return {
        deviceId: Number(position?.deviceId) || 0,
        deviceName: String(position?.deviceName || '').trim(),
        uniqueId: String(attrs.uniqueId || position?.uniqueId || '').trim(),
        odometer: Number(attrs.odometer) || 0,
        totalDistanceM: Number(attrs.totalDistance) || 0,
        state: String(attrs.state || '').toLowerCase(),
        speedKmh: Number(position?.speedKmh) || 0,
        capturedAt: position?.deviceTime ? new Date(position.deviceTime) : new Date(),
    };
}

function normalizeWsSnapshot(position) {
    return {
        deviceId: Number(position?.deviceId) || 0,
        deviceName: String(position?.name || position?.deviceName || '').trim(),
        uniqueId: String(position?.uniqueId || '').trim(),
        odometer: Number(position?.odometer) || 0,
        totalDistanceM: Number(position?.totalDistance) || 0,
        state: String(position?.state || '').toLowerCase(),
        speedKmh: Number(position?.speedKmh) || 0,
        capturedAt: position?.deviceTime ? new Date(position.deviceTime) : new Date(),
    };
}

function shouldCapture(deviceId) {
    const key = String(deviceId);
    const lastAt = lastSnapshotAtByDevice.get(key) || 0;
    return Date.now() - lastAt >= SNAPSHOT_MIN_INTERVAL_MS;
}

export async function recordLocatorSnapshot(rawPosition, source = 'rest') {
    if (!rawPosition) return null;

    const snapshot =
        source === 'ws' ? normalizeWsSnapshot(rawPosition) : normalizeRestSnapshot(rawPosition);

    if (!snapshot.deviceId) return null;
    if (!shouldCapture(snapshot.deviceId)) return null;

    lastSnapshotAtByDevice.set(String(snapshot.deviceId), Date.now());

    return LocatorGpsSnapshot.create(snapshot);
}

export async function recordLocatorSnapshotsFromLatest() {
    if (!isLocatorConfigured()) return 0;

    const { positions } = await fetchLatestPositions();
    let saved = 0;

    for (const position of positions || []) {
        const row = await recordLocatorSnapshot(position, 'rest');
        if (row) saved += 1;
    }

    return saved;
}

function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function endOfDay(date) {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
}

function formatDayLabel(date) {
    return `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}`;
}

function getMonthLabelsTillNow(now = new Date()) {
    return Array.from({ length: now.getMonth() + 1 }, (_, i) => MONTH_SHORT[i]);
}

function getYearLabelsFromSnapshots(snapshots, now = new Date()) {
    const years = new Set(snapshots.map((row) => new Date(row.capturedAt).getFullYear()));
    years.add(now.getFullYear());
    return [...years].sort((a, b) => a - b).map(String);
}

function getDayLabelsForCurrentMonth(now = new Date()) {
    const labels = [];
    const cursor = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
    const end = startOfDay(now);

    while (cursor <= end) {
        labels.push({
            key: cursor.toISOString().slice(0, 10),
            label: formatDayLabel(cursor),
            start: new Date(cursor),
            end: endOfDay(cursor),
        });
        cursor.setDate(cursor.getDate() + 1);
    }

    return labels;
}

function parseStatusDurationToMinutes(text) {
    if (!text) return 0;
    const normalized = String(text).toLowerCase().trim();
    const value = Number.parseFloat(normalized);
    if (!Number.isFinite(value)) return 0;

    if (normalized.includes('day')) return Math.round(value * 24 * 60);
    if (normalized.includes('hour')) return Math.round(value * 60);
    if (normalized.includes('minute')) return Math.round(value);
    if (normalized.includes('second')) return Math.round(value / 60);
    return 0;
}

function liveDistanceKm(position) {
    const attrs = position?.attributes || {};
    const distanceKm = Number(String(attrs.distanceKm ?? '').replace(/,/g, ''));
    if (Number.isFinite(distanceKm) && distanceKm > 0) return distanceKm;

    const distanceM = Number(attrs.distance);
    if (Number.isFinite(distanceM) && distanceM > 0) return Number((distanceM / 1000).toFixed(2));

    return 0;
}

function idleMinutesFromLivePosition(position) {
    const attrs = position?.attributes || {};
    const state = String(attrs.state || '').toLowerCase();

    if (state === 'idling') {
        const fromDuration = parseStatusDurationToMinutes(position?.status_duration);
        if (fromDuration > 0) return fromDuration;
        if (Number(attrs.ifstopped) > 0) return Math.round(Number(attrs.ifstopped) / 60);
    }

    if (state === 'parking') {
        const fromDuration = parseStatusDurationToMinutes(position?.status_duration);
        if (fromDuration > 0) return fromDuration;
        if (Number(attrs.ifstopped) > 0) return Math.round(Number(attrs.ifstopped) / 60);
    }

    return 0;
}

function buildLivePositionMap(positions) {
    const map = new Map();
    for (const position of positions || []) {
        if (position?.deviceId != null) {
            map.set(String(position.deviceId), position);
        }
    }
    return map;
}

function isSameDay(a, b) {
    return (
        a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate()
    );
}
function runningKmBetweenSnapshots(rows, livePosition = null) {
    if (!rows?.length) {
        return livePosition ? liveDistanceKm(livePosition) : 0;
    }

    const sorted = [...rows].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const deltaM = (Number(last.totalDistanceM) || 0) - (Number(first.totalDistanceM) || 0);
    if (deltaM > 0) return Number((deltaM / 1000).toFixed(2));

    return livePosition ? liveDistanceKm(livePosition) : 0;
}

function idleMinutesBetweenSnapshots(rows, livePosition = null) {
    if (rows.length < 2) {
        return livePosition ? idleMinutesFromLivePosition(livePosition) : 0;
    }

    const sorted = [...rows].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    let idleMs = 0;

    for (let i = 1; i < sorted.length; i += 1) {
        const prev = sorted[i - 1];
        const next = sorted[i];
        if (!['idling', 'parking'].includes(prev.state)) continue;

        const gap = new Date(next.capturedAt) - new Date(prev.capturedAt);
        if (gap > 0 && gap < 6 * 60 * 60 * 1000) {
            idleMs += gap;
        }
    }

    const snapshotIdle = Math.round(idleMs / 60000);
    if (snapshotIdle > 0) return snapshotIdle;

    return livePosition ? idleMinutesFromLivePosition(livePosition) : 0;
}

function groupSnapshotsByDevice(snapshots) {
    const map = new Map();
    for (const row of snapshots) {
        const key = String(row.deviceId);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

function sortVehicleBars(rows) {
    return [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}

function buildOdometerChart(positions) {
    return sortVehicleBars(
        (positions || []).map((position) => {
            const attrs = position?.attributes || {};
            return {
                name: position?.deviceName || `Device ${position?.deviceId}`,
                value: toOdometerKm(attrs),
                deviceId: position?.deviceId,
            };
        }),
    );
}

function buildRunningKmDaySeries(snapshots, positions, now = new Date()) {
    const labels = getDayLabelsForCurrentMonth(now);
    const byDevice = groupSnapshotsByDevice(snapshots);
    const liveMap = buildLivePositionMap(positions);
    const today = startOfDay(now);

    return labels.map((bucket) => {
        let total = 0;
        const isToday = isSameDay(bucket.start, today);

        for (const [deviceId, deviceRows] of byDevice.entries()) {
            const inBucket = deviceRows.filter((row) => {
                const at = new Date(row.capturedAt);
                return at >= bucket.start && at <= bucket.end;
            });
            const livePosition = isToday ? liveMap.get(deviceId) || null : null;
            total += runningKmBetweenSnapshots(inBucket, livePosition);
        }

        if (isToday && total === 0) {
            for (const position of positions || []) {
                total += liveDistanceKm(position);
            }
        }

        return {
            label: bucket.label,
            value: Number(total.toFixed(2)),
        };
    });
}

function buildRunningKmMonthSeries(snapshots, positions, now = new Date()) {
    const monthLabels = getMonthLabelsTillNow(now);
    const liveMap = buildLivePositionMap(positions);
    const currentMonth = now.getMonth();

    return monthLabels.map((label, monthIndex) => {
        const start = new Date(now.getFullYear(), monthIndex, 1);
        const end = endOfDay(new Date(now.getFullYear(), monthIndex + 1, 0));
        const byDevice = groupSnapshotsByDevice(snapshots);
        let total = 0;

        for (const [deviceId, deviceRows] of byDevice.entries()) {
            const inBucket = deviceRows.filter((row) => {
                const at = new Date(row.capturedAt);
                return at >= start && at <= end;
            });
            const livePosition = monthIndex === currentMonth ? liveMap.get(deviceId) || null : null;
            total += runningKmBetweenSnapshots(inBucket, livePosition);
        }

        if (monthIndex === currentMonth && total === 0) {
            for (const position of positions || []) {
                total += liveDistanceKm(position);
            }
        }

        return { label, value: Number(total.toFixed(2)) };
    });
}

function buildRunningKmYearSeries(snapshots, positions, now = new Date()) {
    const years = getYearLabelsFromSnapshots(snapshots, now);
    const liveMap = buildLivePositionMap(positions);
    const currentYear = now.getFullYear();

    return years.map((yearLabel) => {
        const year = Number(yearLabel);
        const start = new Date(year, 0, 1);
        const end = endOfDay(new Date(year, 11, 31));
        const byDevice = groupSnapshotsByDevice(snapshots);
        let total = 0;

        for (const [deviceId, deviceRows] of byDevice.entries()) {
            const inBucket = deviceRows.filter((row) => {
                const at = new Date(row.capturedAt);
                return at >= start && at <= end;
            });
            const livePosition = year === currentYear ? liveMap.get(deviceId) || null : null;
            total += runningKmBetweenSnapshots(inBucket, livePosition);
        }

        if (year === currentYear && total === 0) {
            for (const position of positions || []) {
                total += liveDistanceKm(position);
            }
        }

        return { label: yearLabel, value: Number(total.toFixed(2)) };
    });
}

function buildIdleByVehicle(snapshots, positions, start, end) {
    const byDevice = groupSnapshotsByDevice(snapshots);
    const liveMap = buildLivePositionMap(positions);
    const rows = [];
    const seen = new Set();

    for (const [deviceId, deviceRows] of byDevice.entries()) {
        const inBucket = deviceRows.filter((row) => {
            const at = new Date(row.capturedAt);
            return at >= start && at <= end;
        });
        if (!inBucket.length) continue;

        const name = inBucket[inBucket.length - 1]?.deviceName || `Device ${deviceId}`;
        seen.add(String(deviceId));
        rows.push({
            name,
            value: idleMinutesBetweenSnapshots(inBucket, liveMap.get(deviceId) || null) ||
                idleMinutesFromLivePosition(liveMap.get(deviceId) || null),
        });
    }

    for (const position of positions || []) {
        const deviceId = String(position?.deviceId || '');
        if (!deviceId || seen.has(deviceId)) continue;
        rows.push({
            name: position?.deviceName || `Device ${deviceId}`,
            value: idleMinutesFromLivePosition(position),
        });
    }

    return sortVehicleBars(rows);
}

function buildSalikWiseSeries(snapshots, positions, mode, now = new Date()) {
    let start;
    let end;

    if (mode === 'day') {
        start = startOfDay(now);
        start.setDate(start.getDate() - 1);
        end = endOfDay(start);
    } else if (mode === 'week') {
        ({ start, end } = getWeekRange(now));
    } else {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = endOfDay(now);
    }

    const byDevice = groupSnapshotsByDevice(snapshots);
    const liveMap = buildLivePositionMap(positions);
    const rows = [];
    const seen = new Set();

    for (const [deviceId, deviceRows] of byDevice.entries()) {
        const inBucket = deviceRows.filter((row) => {
            const at = new Date(row.capturedAt);
            return at >= start && at <= end;
        });
        if (!inBucket.length) continue;

        const name = inBucket[inBucket.length - 1]?.deviceName || `Device ${deviceId}`;
        seen.add(String(deviceId));
        let value = runningKmBetweenSnapshots(inBucket, liveMap.get(deviceId) || null);
        if (value === 0 && liveMap.get(deviceId)) {
            value = liveDistanceKm(liveMap.get(deviceId));
        }

        rows.push({ name, value });
    }

    for (const position of positions || []) {
        const deviceId = String(position?.deviceId || '');
        const name = position?.deviceName || `Device ${deviceId}`;
        const liveKm = liveDistanceKm(position);
        const existing = rows.find((row) => row.name === name);

        if (existing) {
            if (existing.value === 0 && liveKm > 0) existing.value = liveKm;
            continue;
        }

        if (mode === 'month' || mode === 'week') {
            rows.push({ name, value: liveKm });
        }
    }

    return sortVehicleBars(rows);
}

function getWeekRange(now = new Date()) {
    const start = startOfDay(now);
    const day = start.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + mondayOffset);

    const end = endOfDay(new Date(start));
    end.setDate(start.getDate() + 6);

    return { start, end };
}

export async function buildLocatorFleetDashboard() {
    if (!isLocatorConfigured()) {
        return {
            configured: false,
            message: 'Locator GPS is not configured.',
        };
    }

    const now = new Date();
    const yearStart = new Date(now.getFullYear() - 1, 0, 1);

    let positions = [];
    try {
        const latest = await fetchLatestPositions();
        positions = latest.positions || [];
        await Promise.all((positions || []).map((position) => recordLocatorSnapshot(position, 'rest')));
    } catch (error) {
        return {
            configured: true,
            connected: false,
            message: error?.message || 'Failed to load Locator positions',
        };
    }

    const snapshots = await LocatorGpsSnapshot.find({
        capturedAt: { $gte: yearStart },
    })
        .sort({ capturedAt: 1 })
        .lean();

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearOnlyStart = new Date(now.getFullYear(), 0, 1);

    return {
        configured: true,
        connected: true,
        generatedAt: now.toISOString(),
        odometerByVehicle: buildOdometerChart(positions),
        runningKm: {
            day: buildRunningKmDaySeries(snapshots, positions, now),
            month: buildRunningKmMonthSeries(snapshots, positions, now),
            year: buildRunningKmYearSeries(snapshots, positions, now),
        },
        idleTimeByVehicle: {
            day: buildIdleByVehicle(snapshots, positions, monthStart, endOfDay(now)),
            month: buildIdleByVehicle(snapshots, positions, yearOnlyStart, endOfDay(now)),
            year: buildIdleByVehicle(snapshots, positions, yearStart, endOfDay(now)),
        },
        salikWise: {
            day: buildSalikWiseSeries(snapshots, positions, 'day', now),
            week: buildSalikWiseSeries(snapshots, positions, 'week', now),
            month: buildSalikWiseSeries(snapshots, positions, 'month', now),
        },
        snapshotCount: snapshots.length,
    };
}
