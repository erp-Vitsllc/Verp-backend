import LocatorGpsSnapshot from '../models/LocatorGpsSnapshot.js';
import AssetItem from '../models/AssetItem.js';
import { fetchLatestPositions, isLocatorConfigured } from './locatorService.js';

const SNAPSHOT_MIN_INTERVAL_MS = 2 * 60 * 1000;
const lastSnapshotAtByDevice = new Map();

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Standard Dubai Salik gate charge used when Locator reports crossing counts only. */
const SALIK_GATE_FEE_AED = 4;

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

/** Resolve Salik toll price (AED) from Locator position / attributes — not distance. */
function toSalikPriceAed(source = {}) {
    const attrs =
        source?.attributes && typeof source.attributes === 'object' ? source.attributes : source || {};

    const moneyKeys = [
        'expenses',
        'expense',
        'salikCost',
        'salikAmount',
        'salikPrice',
        'tollCost',
        'tollAmount',
        'tollFee',
        'cost',
        'expenseAed',
    ];
    for (const key of moneyKeys) {
        const raw = attrs[key] ?? source?.[key];
        if (raw == null || raw === '') continue;
        const n = Number(String(raw).replace(/,/g, '').replace(/aed/gi, '').trim());
        if (Number.isFinite(n) && n >= 0) return Number(n.toFixed(2));
    }

    const countKeys = ['salik', 'salikCount', 'tollCount', 'gateCount', 'salikGates'];
    for (const key of countKeys) {
        const raw = attrs[key] ?? source?.[key];
        if (raw == null || raw === '') continue;
        const n = Number(String(raw).replace(/,/g, '').trim());
        if (Number.isFinite(n) && n > 0) return Number((n * SALIK_GATE_FEE_AED).toFixed(2));
    }

    return 0;
}

function normalizeRestSnapshot(position) {
    const attrs = position?.attributes || {};
    const totalDistanceM = Number.isFinite(Number(attrs.totalDistance))
        ? Number(attrs.totalDistance)
        : Number((toOdometerKm(attrs) * 1000).toFixed(2));
    return {
        deviceId: Number(position?.deviceId) || 0,
        deviceName: String(position?.deviceName || '').trim(),
        uniqueId: String(attrs.uniqueId || position?.uniqueId || '').trim(),
        odometer: Number(attrs.odometer) || 0,
        totalDistanceM,
        expenseAed: toSalikPriceAed(position),
        state: String(attrs.state || '').toLowerCase(),
        speedKmh: Number(position?.speedKmh) || 0,
        capturedAt: position?.deviceTime ? new Date(position.deviceTime) : new Date(),
    };
}

function normalizeWsSnapshot(position) {
    const totalDistanceM = Number.isFinite(Number(position?.totalDistance))
        ? Number(position.totalDistance)
        : Number.isFinite(Number(position?.totalDistanceKm))
          ? Number(position.totalDistanceKm) * 1000
          : 0;
    return {
        deviceId: Number(position?.deviceId) || 0,
        deviceName: String(position?.name || position?.deviceName || '').trim(),
        uniqueId: String(position?.uniqueId || '').trim(),
        odometer: Number(position?.odometer) || 0,
        totalDistanceM,
        expenseAed: toSalikPriceAed(position),
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

/** Local calendar date key — avoids UTC day shifts from `toISOString().slice(0, 10)`. */
function localDateKey(date) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDayFromLocalKey(key) {
    const [year, month, day] = String(key || '').split('-').map((part) => Number(part));
    if (!year || !month || !day) return startOfDay(new Date());
    return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function collectSnapshotDayKeys(snapshots, now = new Date()) {
    const keys = new Set();
    for (const row of snapshots || []) {
        const key = localDateKey(row?.capturedAt);
        if (key) keys.add(key);
    }
    keys.add(localDateKey(now));
    return [...keys].sort();
}

function resolveSnapshotStartDay(snapshots, now = new Date()) {
    const keys = collectSnapshotDayKeys(snapshots, now);
    if (!keys.length) return startOfDay(now);
    return startOfDayFromLocalKey(keys[0]);
}

function rangeHasSnapshots(snapshots, start, end) {
    return (snapshots || []).some((row) => {
        const at = new Date(row.capturedAt);
        return at >= start && at <= end;
    });
}

function getDayOptionsFromSnapshots(snapshots, now = new Date()) {
    const snapshotDays = new Set(collectSnapshotDayKeys(snapshots, now));
    const labels = [];
    const cursor = resolveSnapshotStartDay(snapshots, now);
    const end = startOfDay(now);

    while (cursor <= end) {
        const key = localDateKey(cursor);
        labels.push({
            key,
            label: formatDayLabel(cursor),
            start: new Date(cursor),
            end: endOfDay(cursor),
            hasSnapshots: snapshotDays.has(key),
        });
        cursor.setDate(cursor.getDate() + 1);
    }

    return labels;
}

function getMonthOptionsFromSnapshots(snapshots, now = new Date()) {
    const labels = [];
    const firstDay = resolveSnapshotStartDay(snapshots, now);
    const cursor = new Date(firstDay.getFullYear(), firstDay.getMonth(), 1);
    const current = new Date(now.getFullYear(), now.getMonth(), 1);

    while (cursor <= current) {
        const isCurrentMonth =
            cursor.getFullYear() === now.getFullYear() && cursor.getMonth() === now.getMonth();
        const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
        const end = isCurrentMonth
            ? endOfDay(now)
            : endOfDay(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0));
        labels.push({
            key: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`,
            label: start.toLocaleDateString('en-US', { month: 'long' }),
            sublabel: String(cursor.getFullYear()),
            start,
            end,
            hasSnapshots: rangeHasSnapshots(snapshots, start, end),
        });
        cursor.setMonth(cursor.getMonth() + 1);
    }

    return labels;
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
            key: localDateKey(cursor),
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

    // Match Locator "idling" (engine on, not moving) — not parking/ignition-off.
    if (state !== 'idling') return 0;

    const fromDuration = parseStatusDurationToMinutes(position?.status_duration);
    if (fromDuration > 0) return fromDuration;
    if (Number(attrs.ifstopped) > 0) return Math.round(Number(attrs.ifstopped) / 60);
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

/** Running km for a date range — anchor odometer from last reading before the range start. */
function runningKmForDeviceInRange(deviceRows, start, end, livePosition = null) {
    const sorted = [...(deviceRows || [])].sort(
        (a, b) => new Date(a.capturedAt) - new Date(b.capturedAt),
    );
    const inBucket = sorted.filter((row) => {
        const at = new Date(row.capturedAt);
        return at >= start && at <= end;
    });
    const today = startOfDay(new Date());
    const rangeIncludesToday = start <= endOfDay(today) && end >= today;

    if (!inBucket.length) {
        return rangeIncludesToday && livePosition ? liveDistanceKm(livePosition) : 0;
    }

    const beforeRange = sorted.filter((row) => new Date(row.capturedAt) < start);
    const anchor = beforeRange.length ? beforeRange[beforeRange.length - 1] : inBucket[0];
    const closing = inBucket[inBucket.length - 1];
    const deltaM =
        (Number(closing.totalDistanceM) || 0) - (Number(anchor.totalDistanceM) || 0);

    if (deltaM > 0) return Number((deltaM / 1000).toFixed(2));

    return runningKmBetweenSnapshots(
        inBucket,
        rangeIncludesToday ? livePosition : null,
    );
}

/** Period Salik spend (AED): cumulative expense counter delta, not distance. */
function salikPriceBetweenSnapshots(rows, livePosition = null) {
    const livePrice = livePosition ? toSalikPriceAed(livePosition) : 0;
    if (!rows?.length) return livePrice;

    const sorted = [...rows].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    const readings = sorted
        .map((row) => Number(row.expenseAed))
        .filter((n) => Number.isFinite(n) && n >= 0);

    if (livePrice > 0) readings.push(livePrice);

    if (readings.length >= 2) {
        const first = readings[0];
        const last = readings[readings.length - 1];
        const delta = last - first;
        if (delta > 0) return Number(delta.toFixed(2));
        // Counter reset / non-cumulative samples: use max reading in the window.
        const max = Math.max(...readings);
        if (max > 0) return Number(max.toFixed(2));
    }

    if (readings.length === 1 && readings[0] > 0) return Number(readings[0].toFixed(2));
    return livePrice > 0 ? livePrice : 0;
}

function idleMinutesBetweenSnapshots(rows, livePosition = null) {
    if (!rows?.length) {
        return livePosition ? idleMinutesFromLivePosition(livePosition) : 0;
    }

    if (rows.length < 2) {
        const only = rows[0];
        if (String(only?.state || '').toLowerCase() === 'idling') {
            // Single sample while idling: credit at least the snapshot spacing (2 min) when known.
            return livePosition ? idleMinutesFromLivePosition(livePosition) || 2 : 2;
        }
        return livePosition ? idleMinutesFromLivePosition(livePosition) : 0;
    }

    const sorted = [...rows].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    let idleMs = 0;

    for (let i = 1; i < sorted.length; i += 1) {
        const prev = sorted[i - 1];
        const next = sorted[i];
        // Only engine-on idling — parking is ignition-off and is not Locator "Excessive Idling".
        if (String(prev.state || '').toLowerCase() !== 'idling') continue;

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
            const currentKm = toOdometerKm(attrs);
            const rawOdometerM = Number(attrs.odometer);
            return {
                name: position?.deviceName || `Device ${position?.deviceId}`,
                value: currentKm,
                currentKm,
                // Device odometer from Locator (meters → km when value looks like meters)
                odometerKm: Number.isFinite(rawOdometerM)
                    ? Number((rawOdometerM >= 1000 ? rawOdometerM / 1000 : rawOdometerM).toFixed(2))
                    : currentKm,
                totalDistanceKm: currentKm,
                deviceId: position?.deviceId,
            };
        }),
    );
}

function normalizePlateDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function extractPlateCandidatesFromLocatorName(name) {
    const text = String(name || '');
    const matches = text.match(/\d{3,6}/g) || [];
    return [...new Set(matches.map(normalizePlateDigits).filter(Boolean))];
}

function matchFleetVehicleByGpsName(gpsName, fleetVehicles) {
    const candidates = extractPlateCandidatesFromLocatorName(gpsName);
    if (!candidates.length) return null;

    for (const vehicle of fleetVehicles) {
        const plateDigits = normalizePlateDigits(vehicle.plateNumber);
        if (!plateDigits) continue;
        if (
            candidates.some(
                (candidate) =>
                    plateDigits === candidate ||
                    plateDigits.endsWith(candidate) ||
                    candidate.endsWith(plateDigits),
            )
        ) {
            return vehicle;
        }
    }

    return null;
}

function formatVehiclePlateLabel(vehicle) {
    const plate = [vehicle?.plateEmirate, vehicle?.plateNumber]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
    if (plate) return plate;
    if (String(vehicle?.plateNumber || '').trim()) return String(vehicle.plateNumber).trim();
    return '';
}

/** Chart axis label: Assigned → assignee first name; otherwise plate (or “no plate not added”). */
function resolveLocatorChartVehicleLabel(vehicle, fallbackGpsName = '') {
    const status = String(vehicle?.status || '').trim().toLowerCase();
    if (status === 'assigned') {
        const firstName = String(vehicle?.assignedTo?.firstName || '').trim();
        if (firstName) return firstName;
    }
    const plate = formatVehiclePlateLabel(vehicle);
    if (plate) return plate;
    if (vehicle) return 'no plate not added';
    const fallback = String(fallbackGpsName || '').trim();
    return fallback || 'no plate not added';
}

async function createLocatorChartLabelResolver(positions) {
    const fleetVehicles = await AssetItem.find({
        $or: [
            { locatorDeviceId: { $ne: null } },
            { plateNumber: { $exists: true, $nin: [null, ''] } },
        ],
    })
        .select(
            'assetId name plateNumber plateEmirate status locatorDeviceId assignedTo',
        )
        .populate('assignedTo', 'firstName lastName')
        .lean();

    const byDeviceId = new Map();
    for (const vehicle of fleetVehicles) {
        if (vehicle.locatorDeviceId != null) {
            byDeviceId.set(String(vehicle.locatorDeviceId), vehicle);
        }
    }

    const positionNameByDevice = new Map();
    for (const position of positions || []) {
        if (position?.deviceId == null) continue;
        positionNameByDevice.set(
            String(position.deviceId),
            String(position?.deviceName || '').trim(),
        );
    }

    return (deviceId, gpsName = '') => {
        const id = deviceId != null && deviceId !== '' ? String(deviceId) : '';
        const gps =
            String(gpsName || '').trim() ||
            (id ? positionNameByDevice.get(id) || '' : '') ||
            '';
        const erp =
            (id ? byDeviceId.get(id) : null) ||
            matchFleetVehicleByGpsName(gps, fleetVehicles);
        return resolveLocatorChartVehicleLabel(erp, gps || `Device ${id || ''}`.trim());
    };
}

function applyLocatorChartLabels(rows, resolveLabel) {
    return (rows || []).map((row) => {
        const gpsName = String(row?.name || row?.label || '').trim();
        const label = resolveLabel(row?.deviceId, gpsName);
        return {
            ...row,
            name: label,
            chartLabel: label,
        };
    });
}

function mapLocatorDashboardBucketLabels(dashboard, resolveLabel) {
    if (!dashboard?.byKey) return dashboard;
    const byKey = {};
    for (const [key, rows] of Object.entries(dashboard.byKey)) {
        byKey[key] = applyLocatorChartLabels(rows, resolveLabel);
    }
    return { ...dashboard, byKey };
}

function mapLocatorPeriodDashboardLabels(dashboard, resolveLabel) {
    if (!dashboard) return dashboard;
    return {
        day: mapLocatorDashboardBucketLabels(dashboard.day, resolveLabel),
        week: mapLocatorDashboardBucketLabels(dashboard.week, resolveLabel),
        month: mapLocatorDashboardBucketLabels(dashboard.month, resolveLabel),
    };
}

async function buildGpsTrackedVehicles(positions) {
    const fleetVehicles = await AssetItem.find({
        $or: [
            { locatorDeviceId: { $ne: null } },
            { plateNumber: { $exists: true, $nin: [null, ''] } },
        ],
    })
        .select(
            'assetId name plateNumber plateEmirate modelYear assetValue vehicleBrand locatorDeviceId',
        )
        .lean();

    const byDeviceId = new Map();
    for (const vehicle of fleetVehicles) {
        if (vehicle.locatorDeviceId != null) {
            byDeviceId.set(String(vehicle.locatorDeviceId), vehicle);
        }
    }

    const rows = (positions || []).map((position) => {
        const deviceId = position?.deviceId;
        const gpsName = position?.deviceName || `Device ${deviceId}`;
        const erp =
            byDeviceId.get(String(deviceId)) || matchFleetVehicleByGpsName(gpsName, fleetVehicles);
        const attrs = position?.attributes || {};

        return {
            deviceId,
            gpsName,
            vehicleName: erp
                ? [erp.vehicleBrand, erp.name].filter(Boolean).join(' ') || gpsName
                : gpsName,
            plateNumber: erp?.plateNumber || '',
            modelYear: erp?.modelYear || '',
            assetValue: erp ? Number(erp.assetValue || 0) : null,
            currentKm: toOdometerKm(attrs),
            matched: Boolean(erp),
        };
    });

    return rows.sort((a, b) => String(a.gpsName).localeCompare(String(b.gpsName)));
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
    const today = startOfDay(new Date());
    const rangeIncludesToday = start <= endOfDay(today) && end >= today;

    for (const [deviceId, deviceRows] of byDevice.entries()) {
        const inBucket = deviceRows.filter((row) => {
            const at = new Date(row.capturedAt);
            return at >= start && at <= end;
        });
        if (!inBucket.length) continue;

        const name =
            inBucket[inBucket.length - 1]?.deviceName ||
            liveMap.get(deviceId)?.deviceName ||
            `Device ${deviceId}`;
        seen.add(String(deviceId));
        // Never mix today's live idle into a past day/week/month bucket.
        const liveForRange = rangeIncludesToday ? liveMap.get(deviceId) || null : null;
        rows.push({
            name,
            value: idleMinutesBetweenSnapshots(inBucket, liveForRange),
            deviceId,
        });
    }

    // Live-only vehicles only belong on charts that include today.
    if (rangeIncludesToday) {
        for (const position of positions || []) {
            const deviceId = String(position?.deviceId || '');
            if (!deviceId || seen.has(deviceId)) continue;
            const value = idleMinutesFromLivePosition(position);
            if (value <= 0) continue;
            rows.push({
                name: position?.deviceName || `Device ${deviceId}`,
                value,
                deviceId,
            });
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

function getWeekOptionsFromSnapshots(snapshots, now = new Date()) {
    const options = [];
    const seen = new Set();
    let cursor = resolveSnapshotStartDay(snapshots, now);

    while (cursor <= now) {
        const { start, end } = getWeekRange(cursor);
        const key = localDateKey(start);
        if (!seen.has(key)) {
            seen.add(key);
            const effectiveEnd = end > endOfDay(now) ? endOfDay(now) : end;
            options.push({
                key,
                label: `Week of ${formatDayLabel(start)}`,
                sublabel: `${formatDayLabel(start)} – ${formatDayLabel(effectiveEnd)}`,
                start,
                end: effectiveEnd,
                hasSnapshots: rangeHasSnapshots(snapshots, start, effectiveEnd),
            });
        }
        const next = new Date(end);
        next.setDate(next.getDate() + 1);
        cursor = next;
    }

    return options;
}

function buildRunningKmByVehicleForRange(snapshots, positions, start, end) {
    const byDevice = groupSnapshotsByDevice(snapshots);
    const liveMap = buildLivePositionMap(positions);
    const rows = [];
    const seen = new Set();
    const today = startOfDay(new Date());
    const rangeIncludesToday = start <= endOfDay(today) && end >= today;

    for (const [deviceId, deviceRows] of byDevice.entries()) {
        const sorted = [...deviceRows].sort(
            (a, b) => new Date(a.capturedAt) - new Date(b.capturedAt),
        );
        const inBucket = sorted.filter((row) => {
            const at = new Date(row.capturedAt);
            return at >= start && at <= end;
        });
        if (!inBucket.length && !rangeIncludesToday) continue;

        const liveForRange = rangeIncludesToday ? liveMap.get(deviceId) || null : null;
        const name =
            inBucket[inBucket.length - 1]?.deviceName ||
            liveMap.get(deviceId)?.deviceName ||
            `Device ${deviceId}`;
        seen.add(String(deviceId));
        const value = runningKmForDeviceInRange(sorted, start, end, liveForRange);
        rows.push({ name, value: Number(value.toFixed(2)), deviceId });
    }

    for (const position of positions || []) {
        const deviceId = String(position?.deviceId || '');
        if (!deviceId || seen.has(deviceId)) continue;
        if (!rangeIncludesToday) continue;
        rows.push({
            name: position?.deviceName || `Device ${deviceId}`,
            value: liveDistanceKm(position),
            deviceId,
        });
    }

    return sortVehicleBars(rows);
}

function buildLocatorPeriodBucket(options, buildRows) {
    const byKey = {};
    for (const option of options) {
        byKey[option.key] = buildRows(option.start, option.end);
    }
    return {
        defaultKey: options[options.length - 1]?.key || '',
        options: options.map(({ key, label, sublabel, hasSnapshots }) => ({
            key,
            label,
            sublabel,
            hasSnapshots: hasSnapshots !== false,
        })),
        byKey,
    };
}
function buildDayOptionsFromSnapshots(snapshots, now = new Date()) {
    return getDayOptionsFromSnapshots(snapshots, now).map((bucket) => ({
        key: bucket.key,
        label: bucket.start.toLocaleDateString('en-US', { weekday: 'long' }),
        sublabel: formatDayLabel(bucket.start),
        start: bucket.start,
        end: bucket.end,
        hasSnapshots: bucket.hasSnapshots !== false,
    }));
}

function buildRunningKmByVehicleDashboard(snapshots, positions, now = new Date()) {
    const dayOptions = buildDayOptionsFromSnapshots(snapshots, now);
    const weekOptions = getWeekOptionsFromSnapshots(snapshots, now);
    const monthOptions = getMonthOptionsFromSnapshots(snapshots, now);

    const buildRows = (start, end) =>
        buildRunningKmByVehicleForRange(snapshots, positions, start, end);

    return {
        day: buildLocatorPeriodBucket(dayOptions, buildRows),
        week: buildLocatorPeriodBucket(weekOptions, buildRows),
        month: buildLocatorPeriodBucket(monthOptions, buildRows),
    };
}

function buildSalikWiseForRange(snapshots, positions, start, end, now = new Date()) {
    const byDevice = groupSnapshotsByDevice(snapshots);
    const liveMap = buildLivePositionMap(positions);
    const rows = [];
    const seen = new Set();
    const today = startOfDay(now);
    const rangeIncludesToday = start <= endOfDay(today) && end >= today;

    for (const [deviceId, deviceRows] of byDevice.entries()) {
        const inBucket = deviceRows.filter((row) => {
            const at = new Date(row.capturedAt);
            return at >= start && at <= end;
        });
        if (!inBucket.length && !(rangeIncludesToday && liveMap.get(deviceId))) continue;

        const name =
            inBucket[inBucket.length - 1]?.deviceName ||
            liveMap.get(deviceId)?.deviceName ||
            `Device ${deviceId}`;
        seen.add(String(deviceId));
        const value = salikPriceBetweenSnapshots(
            inBucket,
            rangeIncludesToday ? liveMap.get(deviceId) || null : null,
        );
        rows.push({ name, value, deviceId });
    }

    for (const position of positions || []) {
        const deviceId = String(position?.deviceId || '');
        const name = position?.deviceName || `Device ${deviceId}`;
        if (!deviceId || seen.has(deviceId)) continue;

        const livePrice = toSalikPriceAed(position);
        const existing = rows.find(
            (row) => String(row.deviceId || '') === deviceId || row.name === name,
        );

        if (existing) {
            if (existing.value === 0 && livePrice > 0) existing.value = livePrice;
            continue;
        }

        if (rangeIncludesToday && livePrice > 0) {
            rows.push({ name, value: livePrice, deviceId });
        }
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

    return buildSalikWiseForRange(snapshots, positions, start, end, now);
}

function buildIdleTimeByVehicleDashboard(snapshots, positions, now = new Date()) {
    const dayOptions = buildDayOptionsFromSnapshots(snapshots, now);
    const weekOptions = getWeekOptionsFromSnapshots(snapshots, now);
    const monthOptions = getMonthOptionsFromSnapshots(snapshots, now);

    const buildRows = (start, end) => buildIdleByVehicle(snapshots, positions, start, end);

    return {
        day: buildLocatorPeriodBucket(dayOptions, buildRows),
        week: buildLocatorPeriodBucket(weekOptions, buildRows),
        month: buildLocatorPeriodBucket(monthOptions, buildRows),
    };
}

function buildSalikWiseByVehicleDashboard(snapshots, positions, now = new Date()) {
    const dayOptions = buildDayOptionsFromSnapshots(snapshots, now);
    const weekOptions = getWeekOptionsFromSnapshots(snapshots, now);
    const monthOptions = getMonthOptionsFromSnapshots(snapshots, now);
    const buildRows = (start, end) => buildSalikWiseForRange(snapshots, positions, start, end, now);

    return {
        day: buildLocatorPeriodBucket(dayOptions, buildRows),
        week: buildLocatorPeriodBucket(weekOptions, buildRows),
        month: buildLocatorPeriodBucket(monthOptions, buildRows),
    };
}

export async function buildLocatorFleetDashboard() {
    if (!isLocatorConfigured()) {
        return {
            configured: false,
            message: 'Locator GPS is not configured.',
        };
    }

    const now = new Date();
    // Match LocatorGpsSnapshot TTL (~400 days) so all stored days feed the charts.
    const lookbackStart = new Date(now);
    lookbackStart.setDate(lookbackStart.getDate() - 400);

    let positions = [];
    let snapshotWarning = null;

    try {
        const latest = await fetchLatestPositions({ allowStale: true });
        positions = latest.positions || [];
    } catch (error) {
        return {
            configured: true,
            connected: false,
            message: error?.message || 'Failed to load Locator positions',
        };
    }

    try {
        await Promise.all(
            (positions || []).map((position) => recordLocatorSnapshot(position, 'rest')),
        );
    } catch (error) {
        snapshotWarning = error?.message || 'Failed to save GPS snapshots';
        console.warn('[LocatorFleetDashboard] Snapshot capture failed:', snapshotWarning);
    }

    const snapshots = await LocatorGpsSnapshot.find({
        capturedAt: { $gte: lookbackStart },
    })
        .sort({ capturedAt: 1 })
        .lean();

    const resolveLabel = await createLocatorChartLabelResolver(positions);
    const trackingFrom = snapshots[0]?.capturedAt || null;
    const trackingDaysWithData = collectSnapshotDayKeys(snapshots, now).length;
    const odometerByVehicle = applyLocatorChartLabels(buildOdometerChart(positions), resolveLabel);

    return {
        configured: true,
        connected: true,
        generatedAt: now.toISOString(),
        snapshotWarning,
        trackingFrom,
        trackingDaysWithData,
        vehicleCount: positions.length,
        // Live from Locator /v1/position/latest — totalDistanceKm / odometer (no history API in Locator docs)
        odometerByVehicle,
        currentKmByVehicle: odometerByVehicle,
        gpsTrackedVehicles: await buildGpsTrackedVehicles(positions),
        runningKmByVehicle: mapLocatorPeriodDashboardLabels(
            buildRunningKmByVehicleDashboard(snapshots, positions, now),
            resolveLabel,
        ),
        runningKm: {
            day: buildRunningKmDaySeries(snapshots, positions, now),
            month: buildRunningKmMonthSeries(snapshots, positions, now),
            year: buildRunningKmYearSeries(snapshots, positions, now),
        },
        idleTimeByVehicle: mapLocatorPeriodDashboardLabels(
            buildIdleTimeByVehicleDashboard(snapshots, positions, now),
            resolveLabel,
        ),
        salikWise: mapLocatorPeriodDashboardLabels(
            buildSalikWiseByVehicleDashboard(snapshots, positions, now),
            resolveLabel,
        ),
        snapshotCount: snapshots.length,
        // Locator client API (per docs) only exposes latest + live WS — daily history is from our snapshots
        historySource: 'local_snapshots',
        locatorApiSupportsHistory: false,
    };
}
