import LocatorGpsSnapshot from '../models/LocatorGpsSnapshot.js';
import AssetItem from '../models/AssetItem.js';
import { fetchLatestPositions, isLocatorConfigured } from './locatorService.js';
import { reconcileLocatorPositionsToErp } from './locatorVehicleListService.js';

const SNAPSHOT_MIN_INTERVAL_MS = 30 * 60 * 1000;
/** While a vehicle is idling, keep samples so Locator idleStart sessions are not missed. */
const SNAPSHOT_IDLING_INTERVAL_MS = 60 * 1000;
const lastSnapshotAtByDevice = new Map();

/** Hourly samples for idle + recent day buckets. Daily first/last covers month/year running KM. */
const DASHBOARD_SNAPSHOT_LOOKBACK_DAYS = 93;
const DASHBOARD_DISTANCE_LOOKBACK_DAYS = 400;
const DASHBOARD_DAY_OPTIONS_MAX = 93;
const DASHBOARD_WEEK_OPTIONS_MAX = 12;
const DASHBOARD_MONTH_OPTIONS_MAX = 12;
/** Reject lifetime-odometer mistaken as period km (UAE fleet will not average this). */
const MAX_RUNNING_KM_PER_DAY = 600;
/** Previous-day odometer may anchor midnight km only if the last ping is recent. */
const MAX_RUNNING_KM_ANCHOR_GAP_MS = 18 * 60 * 60 * 1000;
const MAX_LIVE_TRIP_KM = 1500;
/** Locator Idling Report: only count idle events that stay idling between GPS samples. */
const MAX_IDLE_SAMPLE_GAP_MS = 90 * 60 * 1000;
/** Locator Excessive Idling Report: ignore events shorter than 10 minutes. */
const MIN_IDLE_EVENT_MS = 10 * 60 * 1000;
/** GPS status_duration is the current session, not the period total — cap fallback. */
const MAX_IDLE_GPS_FALLBACK_MS = 24 * 60 * 60 * 1000;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_GPS_RANGE_DAYS = 400;
const EMIRATE_ONLY_LABELS = new Set([
    'dubai',
    'abu dhabi',
    'abudhabi',
    'sharjah',
    'ajman',
    'uaq',
    'umm al quwain',
    'umm al-quwain',
    'ras al khaimah',
    'ras al-khaimah',
    'rak',
    'fujairah',
]);
const RECONCILE_MIN_INTERVAL_MS = 30 * 60 * 1000;
/** Avoid re-scanning tens of thousands of GPS rows on every dashboard tab focus. */
const FLEET_DASHBOARD_CACHE_TTL_MS = 5 * 60 * 1000;

let lastReconcileAt = 0;
let lastReconcileSummary = null;
let reconcileInFlight = null;
let fleetDashboardCache = { at: 0, year: null, payload: null };
let fleetDashboardInFlight = null;
let fleetDashboardInFlightYear = null;

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

function snapshotAttrs(source) {
    return source?.attributes && typeof source.attributes === 'object' ? source.attributes : {};
}

/** Locator idleStart is epoch ms (sometimes seconds) when this idling session began. */
function idleStartMsFromSource(source) {
    const attrs = snapshotAttrs(source);
    const candidates = [attrs.idleStart, attrs.idle_start, source?.idleStart, source?.idle_start];
    for (const raw of candidates) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) continue;
        if (n > 1e12) return Math.round(n);
        if (n > 1e9) return Math.round(n * 1000);
    }
    return 0;
}

function snapshotTiming(position, state) {
    const capturedAt = position?.deviceTime ? new Date(position.deviceTime) : new Date();
    const capturedMs = capturedAt.getTime();
    const idleStart = String(state || '').toLowerCase() === 'idling' ? idleStartMsFromSource(position) : 0;
    let statusDurationSec = statusDurationSecFromPosition(position);
    if (idleStart > 0 && Number.isFinite(capturedMs) && capturedMs >= idleStart) {
        const sec = Math.round((capturedMs - idleStart) / 1000);
        if (sec > 0) statusDurationSec = sec;
    }
    return { capturedAt, idleStart, statusDurationSec };
}

function normalizeRestSnapshot(position) {
    const attrs = position?.attributes || {};
    const totalDistanceM = Number.isFinite(Number(attrs.totalDistance))
        ? Number(attrs.totalDistance)
        : Number((toOdometerKm(attrs) * 1000).toFixed(2));
    const state = String(attrs.state || '').toLowerCase();
    const timing = snapshotTiming(position, state);
    return {
        deviceId: Number(position?.deviceId) || 0,
        deviceName: String(position?.deviceName || '').trim(),
        uniqueId: String(attrs.uniqueId || position?.uniqueId || '').trim(),
        odometer: Number(attrs.odometer) || 0,
        totalDistanceM,
        expenseAed: toSalikPriceAed(position),
        state,
        speedKmh: Number(position?.speedKmh) || 0,
        statusDurationSec: timing.statusDurationSec,
        idleStart: timing.idleStart,
        capturedAt: timing.capturedAt,
    };
}

function normalizeWsSnapshot(position) {
    const totalDistanceM = Number.isFinite(Number(position?.totalDistance))
        ? Number(position.totalDistance)
        : Number.isFinite(Number(position?.totalDistanceKm))
          ? Number(position.totalDistanceKm) * 1000
          : 0;
    const state = String(position?.state || snapshotAttrs(position).state || '').toLowerCase();
    const timing = snapshotTiming(position, state);
    return {
        deviceId: Number(position?.deviceId) || 0,
        deviceName: String(position?.name || position?.deviceName || '').trim(),
        uniqueId: String(position?.uniqueId || '').trim(),
        odometer: Number(position?.odometer) || 0,
        totalDistanceM,
        expenseAed: toSalikPriceAed(position),
        state,
        speedKmh: Number(position?.speedKmh) || 0,
        statusDurationSec: timing.statusDurationSec,
        idleStart: timing.idleStart,
        capturedAt: timing.capturedAt,
    };
}

function shouldCapture(deviceId, snapshot) {
    const key = String(deviceId);
    const lastAt = lastSnapshotAtByDevice.get(key) || 0;
    const minInterval =
        String(snapshot?.state || '').toLowerCase() === 'idling'
            ? SNAPSHOT_IDLING_INTERVAL_MS
            : SNAPSHOT_MIN_INTERVAL_MS;
    return Date.now() - lastAt >= minInterval;
}

export async function recordLocatorSnapshot(rawPosition, source = 'rest') {
    if (!rawPosition) return null;

    const snapshot =
        source === 'ws' ? normalizeWsSnapshot(rawPosition) : normalizeRestSnapshot(rawPosition);

    if (!snapshot.deviceId) return null;
    if (!shouldCapture(snapshot.deviceId, snapshot)) return null;

    lastSnapshotAtByDevice.set(String(snapshot.deviceId), Date.now());

    return LocatorGpsSnapshot.create(snapshot);
}

export async function recordLocatorSnapshotsFromLatest() {
    if (!isLocatorConfigured()) return 0;

    const { positions } = await fetchLatestPositions({ force: true });
    let saved = 0;

    for (const position of positions || []) {
        const row = await recordLocatorSnapshot(position, 'rest');
        if (row) saved += 1;
    }

    return saved;
}

/**
 * Background Locator → ERP DB sync (snapshots + odometer/GPS cache on AssetItem).
 * Runs on a timer — never from vehicle list/detail HTTP handlers.
 */
export async function syncLocatorToErpDatabase() {
    if (!isLocatorConfigured()) {
        return { configured: false, saved: 0, reconcile: null };
    }

    const startedAt = Date.now();
    const { positions } = await fetchLatestPositions({ force: true });
    let saved = 0;

    for (const position of positions || []) {
        // Scheduled sync always captures (bypass in-memory throttle once per run).
        lastSnapshotAtByDevice.delete(String(position?.deviceId ?? ''));
        const row = await recordLocatorSnapshot(position, 'rest');
        if (row) saved += 1;
    }

    const reconcile = await reconcileLocatorPositionsToErp(positions || [], { force: true });
    console.log(
        `[LocatorSync] ERP DB updated in ${Date.now() - startedAt}ms — snapshots=${saved} reconcile=${JSON.stringify(reconcile)}`,
    );

    return { configured: true, saved, reconcile };
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

/** Next calendar day 12:00 AM — exclusive query bound (end of the selected end date). */
function startOfNextDay(date) {
    const d = startOfDay(date);
    d.setDate(d.getDate() + 1);
    return d;
}

function isStartOfDay(date) {
    return (
        date.getHours() === 0 &&
        date.getMinutes() === 0 &&
        date.getSeconds() === 0 &&
        date.getMilliseconds() === 0
    );
}

/** Last included calendar day of a half-open [start, next-midnight) window. */
function inclusiveEndDay(endExclusive) {
    const last = new Date(endExclusive);
    if (isStartOfDay(last)) last.setDate(last.getDate() - 1);
    return startOfDay(last);
}

/** End of the selected To date (23:59:59.999), for labels — not the next day's 12:00 AM. */
function inclusiveRangeEnd(endExclusive) {
    return endOfDay(inclusiveEndDay(endExclusive));
}

/**
 * Selected-day window: From date 12:00 AM through the end of the To date.
 * Stored as [start, next midnight) so the following day is not included.
 */
function locatorDayBounds(fromDate, toDate = fromDate) {
    return { start: startOfDay(fromDate), end: startOfNextDay(toDate) };
}

function isCapturedInRange(at, start, end) {
    const t = new Date(at).getTime();
    return t >= start.getTime() && t < end.getTime();
}

function rangeTouchesToday(start, end, now = new Date()) {
    const today = startOfDay(now);
    return start.getTime() < startOfNextDay(today).getTime() && end.getTime() > today.getTime();
}

function isTodayOnlyRange(start, end, now = new Date()) {
    const today = startOfDay(now);
    if (startOfDay(start).getTime() !== today.getTime()) return false;
    const endDay = startOfDay(end);
    return endDay.getTime() === today.getTime() || endDay.getTime() === startOfNextDay(today).getTime();
}

function periodNowForYear(year, now = new Date()) {
    const y = Number(year);
    if (!Number.isFinite(y) || y === now.getFullYear()) return now;
    if (y > now.getFullYear()) return now;
    return endOfDay(new Date(y, 11, 31));
}

function monthBoundsForKey(monthKey, now = new Date()) {
    const [year, month] = String(monthKey || '').split('-').map(Number);
    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const nextMonth = new Date(year, month, 1, 0, 0, 0, 0);
    const cap = startOfNextDay(now);
    const end = nextMonth.getTime() > cap.getTime() ? cap : nextMonth;
    if (start.getTime() > cap.getTime()) {
        return { start, end: cap };
    }
    return { start, end };
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

function dayBoundsFromKeys(fromKey, toKey, now = new Date()) {
    let start = startOfDayFromLocalKey(fromKey);
    let end = startOfNextDay(startOfDayFromLocalKey(toKey));
    const cap = startOfNextDay(now);
    if (end.getTime() > cap.getTime()) end = cap;
    if (start.getTime() >= end.getTime()) {
        ({ start, end } = locatorDayBounds(now));
        if (end.getTime() > cap.getTime()) end = cap;
    }
    const maxSpanMs = MAX_GPS_RANGE_DAYS * 86_400_000;
    if (end.getTime() - start.getTime() > maxSpanMs) {
        start = startOfDay(new Date(end.getTime() - maxSpanMs));
    }
    return { start, end };
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
    return (snapshots || []).some((row) => isCapturedInRange(row.capturedAt, start, end));
}

function getDayOptionsFromSnapshots(snapshots, now = new Date()) {
    const snapshotDays = new Set(collectSnapshotDayKeys(snapshots, now));
    const labels = [];
    const end = startOfDay(now);
    const windowStart = startOfDay(now);
    windowStart.setDate(windowStart.getDate() - (DASHBOARD_DAY_OPTIONS_MAX - 1));
    const firstData = resolveSnapshotStartDay(snapshots, now);
    const cursor = new Date(Math.max(windowStart.getTime(), firstData.getTime()));
    const todayKey = localDateKey(now);

    while (cursor <= end) {
        const key = localDateKey(cursor);
        const hasSnapshots = snapshotDays.has(key);
        // Skip empty calendar days — previously precomputed ~400 day buckets per chart.
        if (hasSnapshots || key === todayKey) {
            labels.push({
                key,
                label: formatDayLabel(cursor),
                start: new Date(cursor),
                end: startOfNextDay(cursor),
                hasSnapshots,
            });
        }
        cursor.setDate(cursor.getDate() + 1);
    }

    return labels;
}

function getMonthOptionsFromSnapshots(snapshots, now = new Date()) {
    const labels = [];
    const firstDay = resolveSnapshotStartDay(snapshots, now);
    const earliestAllowed = new Date(now.getFullYear(), now.getMonth() - (DASHBOARD_MONTH_OPTIONS_MAX - 1), 1);
    const cursor = new Date(
        Math.max(
            new Date(firstDay.getFullYear(), firstDay.getMonth(), 1).getTime(),
            earliestAllowed.getTime(),
        ),
    );
    const current = new Date(now.getFullYear(), now.getMonth(), 1);

    while (cursor <= current) {
        const { start, end } = monthBoundsForKey(
            `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`,
            now,
        );
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
    const labels = [];
    const cursor = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    while (cursor <= end) {
        labels.push({ label: MONTH_SHORT[cursor.getMonth()], monthIndex: cursor.getMonth() });
        cursor.setMonth(cursor.getMonth() + 1);
    }
    return labels.length ? labels : [{ label: MONTH_SHORT[now.getMonth()], monthIndex: now.getMonth() }];
}

function getYearLabelsFromSnapshots(snapshots, now = new Date()) {
    const years = new Set(snapshots.map((row) => new Date(row.capturedAt).getFullYear()));
    years.add(now.getFullYear());
    return [...years].sort((a, b) => a - b).map(String);
}

function getDayLabelsForCurrentMonth(snapshots, now = new Date()) {
    const monthStart = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
    const firstData = resolveSnapshotStartDay(snapshots, now);
    const cursor = new Date(Math.max(monthStart.getTime(), firstData.getTime()));
    const end = startOfDay(now);
    const labels = [];

    while (cursor <= end) {
        labels.push({
            key: localDateKey(cursor),
            label: formatDayLabel(cursor),
            start: new Date(cursor),
            end: startOfNextDay(cursor),
        });
        cursor.setDate(cursor.getDate() + 1);
    }

    return labels.length
        ? labels
        : [
              {
                  key: localDateKey(now),
                  label: formatDayLabel(now),
                  start: startOfDay(now),
                  end: startOfNextDay(now),
              },
          ];
}

function parseStatusDurationToMs(text) {
    if (text == null || text === '') return 0;
    const raw = String(text).trim();
    const hms = raw.match(/^(\d+):([0-5]?\d):([0-5]?\d)(?:\s*hrs?)?$/i);
    if (hms) {
        return (Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])) * 1000;
    }

    const normalized = raw.toLowerCase();
    let ms = 0;
    const days = normalized.match(/(\d+(?:\.\d+)?)\s*d(?:ays?)?/);
    const hours = normalized.match(/(\d+(?:\.\d+)?)\s*h(?:ours?)?/);
    const mins = normalized.match(/(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?/);
    const secs = normalized.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?/);
    if (days) ms += Number(days[1]) * 24 * 60 * 60 * 1000;
    if (hours) ms += Number(hours[1]) * 60 * 60 * 1000;
    if (mins) ms += Number(mins[1]) * 60 * 1000;
    if (secs) ms += Number(secs[1]) * 1000;
    if (ms > 0) return ms;

    const value = Number.parseFloat(normalized);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (normalized.includes('day')) return value * 24 * 60 * 60 * 1000;
    if (normalized.includes('hour')) return value * 60 * 60 * 1000;
    if (normalized.includes('minute')) return value * 60 * 1000;
    if (normalized.includes('second')) return value * 1000;
    return 0;
}

function parseStatusDurationToMinutes(text) {
    return Math.round(parseStatusDurationToMs(text) / 60000);
}

function statusDurationSecFromPosition(position) {
    const fromText = parseStatusDurationToMs(position?.status_duration);
    if (fromText > 0) return Math.round(fromText / 1000);
    const stopped = Number(position?.attributes?.ifstopped ?? position?.ifstopped);
    if (Number.isFinite(stopped) && stopped > 0) return Math.round(stopped);
    return 0;
}

export function formatLocatorIdleLabel(msOrMinutes, { fromMinutes = false } = {}) {
    const ms = fromMinutes ? (Number(msOrMinutes) || 0) * 60000 : Number(msOrMinutes) || 0;
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')} Hrs`;
}

function isEmirateOnlyLabel(value) {
    return EMIRATE_ONLY_LABELS.has(String(value || '').trim().toLowerCase());
}

function snapshotDistanceM(row) {
    const total = Number(row?.totalDistanceM);
    if (Number.isFinite(total) && total > 0) return total;
    const odo = Number(row?.odometer);
    if (!Number.isFinite(odo) || odo <= 0) return 0;
    return odo >= 10_000 ? odo : odo * 1000;
}

function capTripKm(km) {
    const n = Number(km) || 0;
    if (n <= 0 || n > MAX_LIVE_TRIP_KM) return 0;
    return Number(n.toFixed(2));
}

function runningKmFromPair(first, last) {
    const firstM = snapshotDistanceM(first);
    const lastM = snapshotDistanceM(last);
    if (firstM <= 0 || lastM <= 0 || lastM <= firstM) return 0;
    const firstAt = new Date(first?.capturedAt);
    const lastAt = new Date(last?.capturedAt);
    const spanDays = Math.max(
        1,
        Number.isFinite(firstAt.getTime()) && Number.isFinite(lastAt.getTime())
            ? (lastAt.getTime() - firstAt.getTime()) / 86_400_000
            : 1,
    );
    const km = (lastM - firstM) / 1000;
    if (km / spanDays > MAX_RUNNING_KM_PER_DAY) return 0;
    return Number(km.toFixed(2));
}

function liveDistanceKm(position) {
    const attrs = position?.attributes || {};
    const lifetimeKm = toOdometerKm(attrs);

    const distanceKm = Number(String(attrs.distanceKm ?? '').replace(/,/g, ''));
    if (
        Number.isFinite(distanceKm) &&
        distanceKm > 0 &&
        distanceKm <= MAX_LIVE_TRIP_KM &&
        Math.abs(distanceKm - lifetimeKm) > 1
    ) {
        return Number(distanceKm.toFixed(2));
    }

    const distanceM = Number(attrs.distance);
    if (Number.isFinite(distanceM) && distanceM > 0) {
        const km = distanceM / 1000;
        if (km <= MAX_LIVE_TRIP_KM && Math.abs(km - lifetimeKm) > 1) {
            return Number(km.toFixed(2));
        }
    }

    return 0;
}

function isLiveIdling(position) {
    if (!position) return false;
    const attrs = snapshotAttrs(position);
    const state = String(attrs.state || position?.state || '').toLowerCase();
    if (state !== 'idling') return false;
    const speed = Number(position?.speedKmh ?? position?.speed);
    if (Number.isFinite(speed) && speed > 5) return false;
    return true;
}

function syntheticLiveIdleRow(position) {
    const capturedAt = new Date();
    const idleStart = idleStartMsFromSource(position);
    let statusDurationSec = statusDurationSecFromPosition(position);
    if (idleStart > 0) {
        const sec = Math.round((capturedAt.getTime() - idleStart) / 1000);
        if (sec > 0) statusDurationSec = sec;
    }
    return {
        state: 'idling',
        speedKmh: Number(position?.speedKmh) || 0,
        idleStart,
        statusDurationSec,
        capturedAt,
    };
}

function idleMinutesFromLivePosition(position, { capMinutes = null } = {}) {
    if (!isLiveIdling(position)) return 0;

    const attrs = snapshotAttrs(position);
    const idleStart = idleStartMsFromSource(position);
    let minutes = 0;
    if (idleStart > 0) {
        minutes = Math.round((Date.now() - idleStart) / 60000);
    }
    if (minutes <= 0) {
        minutes = parseStatusDurationToMinutes(position?.status_duration);
    }
    if (minutes <= 0 && Number(attrs.ifstopped) > 0) {
        minutes = Math.round(Number(attrs.ifstopped) / 60);
    }
    if (minutes <= 0) return 0;
    if (capMinutes != null && Number.isFinite(Number(capMinutes))) {
        minutes = Math.min(minutes, Math.max(0, Number(capMinutes)));
    }
    if (minutes * 60000 < MIN_IDLE_EVENT_MS) return 0;
    return minutes;
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
    const sorted = [...(rows || [])].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    const valid = sorted.filter((row) => snapshotDistanceM(row) > 0);
    if (valid.length >= 2) {
        const km = runningKmFromPair(valid[0], valid[valid.length - 1]);
        if (km > 0) return km;
    }
    return livePosition ? capTripKm(liveDistanceKm(livePosition)) : 0;
}

/** Running km for a date range — anchor odometer from last reading before the range start. */
function runningKmForDeviceInRange(deviceRows, start, end, livePosition = null, { calendarMonth = false } = {}) {
    const sorted = [...(deviceRows || [])].sort(
        (a, b) => new Date(a.capturedAt) - new Date(b.capturedAt),
    );
    const inBucket = sorted.filter((row) => isCapturedInRange(row.capturedAt, start, end));
    const rangeIncludesToday = rangeTouchesToday(start, end);
    const liveTrip = rangeIncludesToday && livePosition ? capTripKm(liveDistanceKm(livePosition)) : 0;

    if (!inBucket.length) return liveTrip;

    const beforeRange = sorted.filter(
        (row) => new Date(row.capturedAt) < start && snapshotDistanceM(row) > 0,
    );
    const firstInRange = inBucket.find((row) => snapshotDistanceM(row) > 0);
    const closing = [...inBucket].reverse().find((row) => snapshotDistanceM(row) > 0);
    if (!firstInRange || !closing) return liveTrip;

    // Daily charts: do not pull a missing previous day into the next day.
    // Calendar months: last odometer before the 1st is the month-start reading.
    const prev = beforeRange[beforeRange.length - 1];
    let anchor = firstInRange;
    if (prev) {
        const gapToStart = start.getTime() - new Date(prev.capturedAt).getTime();
        if (calendarMonth || (gapToStart >= 0 && gapToStart <= MAX_RUNNING_KM_ANCHOR_GAP_MS)) {
            anchor = prev;
        }
    }

    const km = runningKmFromPair(anchor, closing);
    if (km > 0) return km;
    return liveTrip;
}

function currentKmFromSnapshot(row) {
    const meters = snapshotDistanceM(row);
    if (!(meters > 0)) return 0;
    return Number((meters / 1000).toFixed(1));
}

/**
 * Period running KM from snapshot odometer deltas — skip GPS glitches and resets.
 * Do not use Locator's live `distance` / `status_duration` as the period total.
 */
function runningKmSumForDeviceInRange(deviceRows, start, end, { calendarMonth = false } = {}) {
    const sorted = [...(deviceRows || [])]
        .filter((row) => snapshotDistanceM(row) > 0)
        .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));

    const before = [...sorted].reverse().find((row) => new Date(row.capturedAt) < start);
    const inRange = sorted.filter((row) => isCapturedInRange(row.capturedAt, start, end));
    if (!inRange.length) return 0;

    let prev = null;
    if (before) {
        const gapToStart = start.getTime() - new Date(before.capturedAt).getTime();
        if (calendarMonth || (gapToStart >= 0 && gapToStart <= MAX_RUNNING_KM_ANCHOR_GAP_MS)) {
            prev = before;
        }
    }

    let total = 0;
    for (const row of inRange) {
        if (prev) {
            const km = (snapshotDistanceM(row) - snapshotDistanceM(prev)) / 1000;
            const spanMs = new Date(row.capturedAt) - new Date(prev.capturedAt);
            const spanDays = Math.max(spanMs / 86_400_000, 1 / 24);
            if (Number.isFinite(km) && km > 0 && km / spanDays <= MAX_RUNNING_KM_PER_DAY) {
                total += km;
            }
        }
        prev = row;
    }
    return Number(total.toFixed(2));
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

function isIdlingSnapshot(row) {
    if (String(row?.state || '').toLowerCase() !== 'idling') return false;
    const speed = Number(row?.speedKmh);
    if (Number.isFinite(speed) && speed > 5) return false;
    return true;
}

function snapshotIdleDurationMs(row) {
    const sec = Number(row?.statusDurationSec);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
    const idleStart = Number(row?.idleStart);
    const at = new Date(row?.capturedAt).getTime();
    if (idleStart > 0 && Number.isFinite(at) && at >= idleStart) return at - idleStart;
    return 0;
}

/**
 * One Locator-style idling event: engine-on `idling` until the next GPS state.
 * Prefer attributes.idleStart; otherwise span consecutive samples and the gap to the next state.
 */
function measureIdleEvent(first, last, next) {
    const firstAt = new Date(first.capturedAt).getTime();
    const lastAt = new Date(last.capturedAt).getTime();
    const idleStart = Number(last?.idleStart || first?.idleStart) || 0;
    const gpsMs = Math.min(
        Math.max(snapshotIdleDurationMs(first), snapshotIdleDurationMs(last)),
        MAX_IDLE_GPS_FALLBACK_MS,
    );
    const nextAt = next ? new Date(next.capturedAt).getTime() : 0;

    let startMs;
    let endMs;

    if (idleStart > 0 && idleStart <= lastAt + 1000) {
        startMs = idleStart;
        endMs = lastAt;
    } else if (gpsMs >= MIN_IDLE_EVENT_MS) {
        startMs = lastAt - gpsMs;
        endMs = lastAt;
    } else {
        startMs = firstAt;
        endMs = lastAt > firstAt ? lastAt : firstAt;
        // Isolated pings and short streaks have no idleStart — extend to the next GPS state
        // so a 7–9 min sample gap is not dropped when Locator's event was ≥ 10 min.
        if (
            endMs - startMs < MIN_IDLE_EVENT_MS &&
            nextAt > endMs &&
            nextAt - startMs <= MAX_IDLE_SAMPLE_GAP_MS
        ) {
            endMs = nextAt;
        }
    }

    return {
        startMs,
        endMs,
        durationMs: Math.max(0, endMs - startMs),
    };
}

function collectIdleEvents(rows) {
    const sorted = [...(rows || [])].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    const events = [];
    let i = 0;
    while (i < sorted.length) {
        if (!isIdlingSnapshot(sorted[i])) {
            i += 1;
            continue;
        }
        let lastIdx = i;
        let j = i + 1;
        while (j < sorted.length && isIdlingSnapshot(sorted[j])) {
            const gap = new Date(sorted[j].capturedAt) - new Date(sorted[lastIdx].capturedAt);
            if (gap <= 0 || gap > MAX_IDLE_SAMPLE_GAP_MS) break;
            lastIdx = j;
            j += 1;
        }
        const next = lastIdx + 1 < sorted.length ? sorted[lastIdx + 1] : null;
        events.push(measureIdleEvent(sorted[i], sorted[lastIdx], next));
        i = lastIdx + 1;
    }
    return events;
}

function idleOverlapMs(startMs, endMs, rangeStart, rangeEnd) {
    return Math.max(0, Math.min(endMs, rangeEnd.getTime()) - Math.max(startMs, rangeStart.getTime()));
}

function rowsWithLiveIdle(rows, livePosition, includeLiveSession) {
    const out = [...(rows || [])];
    if (includeLiveSession && isLiveIdling(livePosition)) {
        out.push(syntheticLiveIdleRow(livePosition));
    }
    return out;
}

function idleMsBetweenSnapshots(rows, livePosition = null, { includeLiveSession = false } = {}) {
    const events = collectIdleEvents(rowsWithLiveIdle(rows, livePosition, includeLiveSession));
    let totalMs = 0;
    for (const event of events) {
        if (event.durationMs >= MIN_IDLE_EVENT_MS) totalMs += event.durationMs;
    }
    return totalMs;
}

function idleMinutesBetweenSnapshots(rows, livePosition = null, options = {}) {
    return Math.round(idleMsBetweenSnapshots(rows, livePosition, options) / 60000);
}

function idleMsForDeviceInRange(deviceRows, start, end, livePosition = null, options = {}) {
    const lookback = start.getTime() - MAX_IDLE_SAMPLE_GAP_MS;
    const lookahead = end.getTime() + MAX_IDLE_SAMPLE_GAP_MS;
    const windowed = [...(deviceRows || [])].filter((row) => {
        const at = new Date(row.capturedAt).getTime();
        return Number.isFinite(at) && at >= lookback && at < lookahead;
    });
    const events = collectIdleEvents(
        rowsWithLiveIdle(windowed, livePosition, Boolean(options.includeLiveSession)),
    );
    let totalMs = 0;
    for (const event of events) {
        if (event.durationMs < MIN_IDLE_EVENT_MS) continue;
        totalMs += idleOverlapMs(event.startMs, event.endMs, start, end);
    }
    return totalMs;
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
    const number = String(vehicle?.plateNumber || '').trim();
    if (!number) return '';
    const emirate = String(vehicle?.plateEmirate || '').trim();
    return emirate ? `${emirate} ${number}` : number;
}

/** Unique GPS chart label — plate number, else Locator device name, never emirate-only. */
function resolveLocatorChartVehicleLabel(vehicle, fallbackGpsName = '', deviceId = '') {
    const plate = formatVehiclePlateLabel(vehicle);
    if (plate) return plate;
    const gps = String(fallbackGpsName || '').trim();
    if (gps && !isEmirateOnlyLabel(gps)) return gps;
    const assetId = String(vehicle?.assetId || '').trim();
    if (assetId) return assetId;
    if (deviceId) return `GPS ${deviceId}`;
    return gps || 'Vehicle';
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
        return resolveLocatorChartVehicleLabel(erp, gps || `Device ${id || ''}`.trim(), id);
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
        year: mapLocatorDashboardBucketLabels(dashboard.year, resolveLabel),
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
    const labels = getDayLabelsForCurrentMonth(snapshots, now);
    const byDevice = groupSnapshotsByDevice(snapshots);
    const liveMap = buildLivePositionMap(positions);
    const today = startOfDay(now);

    return labels.map((bucket) => {
        let total = 0;
        const isToday = isSameDay(bucket.start, today);

        for (const [deviceId, deviceRows] of byDevice.entries()) {
            const livePosition = isToday ? liveMap.get(deviceId) || null : null;
            total += runningKmForDeviceInRange(deviceRows, bucket.start, bucket.end, livePosition);
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
    const byDevice = groupSnapshotsByDevice(snapshots);

    return monthLabels.map(({ label, monthIndex }) => {
        const { start, end } = monthBoundsForKey(
            `${now.getFullYear()}-${String(monthIndex + 1).padStart(2, '0')}`,
            now,
        );
        let total = 0;

        for (const [deviceId, deviceRows] of byDevice.entries()) {
            const livePosition = monthIndex === currentMonth ? liveMap.get(deviceId) || null : null;
            total += runningKmForDeviceInRange(deviceRows, start, end, livePosition, { calendarMonth: true });
        }

        return { label, value: Number(total.toFixed(2)) };
    });
}

function buildRunningKmYearSeries(snapshots, positions, now = new Date()) {
    const years = getYearLabelsFromSnapshots(snapshots, now);
    const liveMap = buildLivePositionMap(positions);
    const currentYear = now.getFullYear();
    const byDevice = groupSnapshotsByDevice(snapshots);

    return years.map((yearLabel) => {
        const year = Number(yearLabel);
        const start = new Date(year, 0, 1);
        const end = year === now.getFullYear() ? startOfNextDay(now) : new Date(year + 1, 0, 1);
        let total = 0;

        for (const [deviceId, deviceRows] of byDevice.entries()) {
            const livePosition = year === currentYear ? liveMap.get(deviceId) || null : null;
            total += runningKmForDeviceInRange(deviceRows, start, end, livePosition);
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
    const todayOnly = isTodayOnlyRange(start, end);
    const includeLive = rangeTouchesToday(start, end);

    for (const [deviceId, deviceRows] of byDevice.entries()) {
        const inBucket = deviceRows.filter((row) => isCapturedInRange(row.capturedAt, start, end));
        if (!inBucket.length && !includeLive) continue;

        const name =
            inBucket[inBucket.length - 1]?.deviceName ||
            liveMap.get(deviceId)?.deviceName ||
            `Device ${deviceId}`;
        seen.add(String(deviceId));
        const liveForRange = includeLive ? liveMap.get(deviceId) || null : null;
        const idleMs = idleMsForDeviceInRange(deviceRows, start, end, liveForRange, {
            includeLiveSession: includeLive,
        });
        rows.push({
            name,
            value: Math.round(idleMs / 60000),
            deviceId,
        });
    }

    // Live-only vehicles (no snapshots yet) belong on today's idle chart only.
    if (todayOnly) {
        const minutesToday = Math.max(0, (Date.now() - today.getTime()) / 60000);
        for (const position of positions || []) {
            const deviceId = String(position?.deviceId || '');
            if (!deviceId || seen.has(deviceId)) continue;
            const value = idleMinutesFromLivePosition(position, { capMinutes: minutesToday });
            if (value <= 0) continue;
            rows.push({
                name: position?.deviceName || `Device ${deviceId}`,
                value,
                deviceId,
            });
        }
    }

    return sortVehicleBars(rows.filter((row) => Number(row.value) > 0));
}

function getWeekRange(now = new Date()) {
    const start = startOfDay(now);
    const day = start.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + mondayOffset);

    const end = startOfDay(start);
    end.setDate(start.getDate() + 7);

    return { start, end };
}

function formatExclusiveEndLabel(endExclusive) {
    return formatDayLabel(inclusiveEndDay(endExclusive));
}

function getWeekOptionsFromSnapshots(snapshots, now = new Date()) {
    const options = [];
    const seen = new Set();
    const windowStart = startOfDay(now);
    windowStart.setDate(windowStart.getDate() - DASHBOARD_WEEK_OPTIONS_MAX * 7);
    const firstData = resolveSnapshotStartDay(snapshots, now);
    let cursor = new Date(Math.max(windowStart.getTime(), firstData.getTime()));
    const cap = startOfNextDay(now);

    while (cursor <= now) {
        const { start, end } = getWeekRange(cursor);
        const key = localDateKey(start);
        if (!seen.has(key)) {
            seen.add(key);
            const effectiveEnd = end > cap ? cap : end;
            options.push({
                key,
                label: `Week of ${formatDayLabel(start)}`,
                sublabel: `${formatDayLabel(start)} – ${formatExclusiveEndLabel(effectiveEnd)}`,
                start,
                end: effectiveEnd,
                hasSnapshots: rangeHasSnapshots(snapshots, start, effectiveEnd),
            });
        }
        cursor = new Date(end);
    }

    return options.slice(-DASHBOARD_WEEK_OPTIONS_MAX);
}

function buildRunningKmByVehicleForRange(snapshots, positions, start, end) {
    const byDevice = groupSnapshotsByDevice(snapshots);
    const liveMap = buildLivePositionMap(positions);
    const rows = [];
    const seen = new Set();
    const rangeIncludesToday = rangeTouchesToday(start, end);

    for (const [deviceId, deviceRows] of byDevice.entries()) {
        const sorted = [...deviceRows].sort(
            (a, b) => new Date(a.capturedAt) - new Date(b.capturedAt),
        );
        const inBucket = sorted.filter((row) => isCapturedInRange(row.capturedAt, start, end));
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
        year: buildLocatorPeriodBucket(
            [
                {
                    key: String(now.getFullYear()),
                    label: String(now.getFullYear()),
                    sublabel: String(now.getFullYear()),
                    start: new Date(now.getFullYear(), 0, 1),
                    end: startOfNextDay(now),
                    hasSnapshots: rangeHasSnapshots(
                        snapshots,
                        new Date(now.getFullYear(), 0, 1),
                        startOfNextDay(now),
                    ),
                },
            ],
            buildRows,
        ),
    };
}

function buildSalikWiseForRange(snapshots, positions, start, end, now = new Date()) {
    const byDevice = groupSnapshotsByDevice(snapshots);
    const liveMap = buildLivePositionMap(positions);
    const rows = [];
    const seen = new Set();
    const rangeIncludesToday = rangeTouchesToday(start, end, now);

    for (const [deviceId, deviceRows] of byDevice.entries()) {
        const inBucket = deviceRows.filter((row) => isCapturedInRange(row.capturedAt, start, end));
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
        ({ start, end } = locatorDayBounds(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)));
    } else if (mode === 'week') {
        ({ start, end } = getWeekRange(now));
    } else {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = startOfNextDay(now);
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
        year: buildLocatorPeriodBucket(
            [
                {
                    key: String(now.getFullYear()),
                    label: String(now.getFullYear()),
                    sublabel: String(now.getFullYear()),
                    start: new Date(now.getFullYear(), 0, 1),
                    end: startOfNextDay(now),
                    hasSnapshots: rangeHasSnapshots(
                        snapshots,
                        new Date(now.getFullYear(), 0, 1),
                        startOfNextDay(now),
                    ),
                },
            ],
            buildRows,
        ),
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

function scheduleLocatorReconcile(positions) {
    const nowMs = Date.now();
    if (reconcileInFlight) {
        return { summary: lastReconcileSummary, deferred: true, inFlight: true };
    }
    if (nowMs - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS && lastReconcileSummary) {
        return { summary: lastReconcileSummary, deferred: true, inFlight: false };
    }

    lastReconcileAt = nowMs;
    reconcileInFlight = reconcileLocatorPositionsToErp(positions)
        .then((summary) => {
            lastReconcileSummary = summary;
            return summary;
        })
        .catch((error) => {
            console.warn(
                '[LocatorFleetDashboard] Background reconcile failed:',
                error?.message || error,
            );
            return null;
        })
        .finally(() => {
            reconcileInFlight = null;
        });

    return { summary: lastReconcileSummary, deferred: true, inFlight: true };
}

/**
 * Chart builders only need odometer/state trends — not every 30-min raw row.
 * One sample per device per hour cuts ~60k → ~15k and keeps Mongo work off the Node heap.
 */
async function loadDashboardChartSnapshots(lookbackStart) {
    return LocatorGpsSnapshot.aggregate([
        { $match: { capturedAt: { $gte: lookbackStart } } },
        { $sort: { capturedAt: 1 } },
        {
            $group: {
                _id: {
                    deviceId: '$deviceId',
                    y: { $year: { date: '$capturedAt', timezone: 'Asia/Dubai' } },
                    m: { $month: { date: '$capturedAt', timezone: 'Asia/Dubai' } },
                    d: { $dayOfMonth: { date: '$capturedAt', timezone: 'Asia/Dubai' } },
                    h: { $hour: { date: '$capturedAt', timezone: 'Asia/Dubai' } },
                },
                deviceId: { $first: '$deviceId' },
                deviceName: { $last: '$deviceName' },
                odometer: { $last: '$odometer' },
                totalDistanceM: { $last: '$totalDistanceM' },
                expenseAed: { $last: '$expenseAed' },
                state: { $last: '$state' },
                speedKmh: { $avg: '$speedKmh' },
                statusDurationSec: { $max: '$statusDurationSec' },
                idleStart: { $last: '$idleStart' },
                capturedAt: { $last: '$capturedAt' },
            },
        },
        {
            $project: {
                _id: 0,
                deviceId: 1,
                deviceName: 1,
                odometer: 1,
                totalDistanceM: 1,
                expenseAed: 1,
                state: 1,
                speedKmh: 1,
                statusDurationSec: 1,
                idleStart: 1,
                capturedAt: 1,
            },
        },
        { $sort: { capturedAt: 1 } },
    ])
        .option({ allowDiskUse: true, maxTimeMS: 20000 })
        .exec();
}

async function loadDailyDistanceSnapshots(lookbackStart) {
    const grouped = await LocatorGpsSnapshot.aggregate([
        { $match: { capturedAt: { $gte: lookbackStart } } },
        { $sort: { capturedAt: 1 } },
        {
            $group: {
                _id: {
                    deviceId: '$deviceId',
                    y: { $year: { date: '$capturedAt', timezone: 'Asia/Dubai' } },
                    m: { $month: { date: '$capturedAt', timezone: 'Asia/Dubai' } },
                    d: { $dayOfMonth: { date: '$capturedAt', timezone: 'Asia/Dubai' } },
                },
                deviceId: { $first: '$deviceId' },
                deviceName: { $last: '$deviceName' },
                firstDistanceM: { $first: '$totalDistanceM' },
                lastDistanceM: { $last: '$totalDistanceM' },
                firstOdometer: { $first: '$odometer' },
                lastOdometer: { $last: '$odometer' },
                firstAt: { $first: '$capturedAt' },
                lastAt: { $last: '$capturedAt' },
            },
        },
    ])
        .option({ allowDiskUse: true, maxTimeMS: 20000 })
        .exec();

    const rows = [];
    for (const group of grouped || []) {
        rows.push({
            deviceId: group.deviceId,
            deviceName: group.deviceName || '',
            totalDistanceM: group.firstDistanceM,
            odometer: group.firstOdometer,
            capturedAt: group.firstAt,
            state: '',
        });
        if (new Date(group.lastAt).getTime() !== new Date(group.firstAt).getTime()) {
            rows.push({
                deviceId: group.deviceId,
                deviceName: group.deviceName || '',
                totalDistanceM: group.lastDistanceM,
                odometer: group.lastOdometer,
                capturedAt: group.lastAt,
                state: '',
            });
        }
    }
    rows.sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    return rows;
}

async function buildLocatorFleetDashboardUncached(selectedYear) {
    const startedAt = Date.now();
    const clockNow = new Date();
    const periodNow = periodNowForYear(selectedYear, clockNow);
    const yearStart = new Date(periodNow.getFullYear(), 0, 1, 0, 0, 0, 0);
    const lookbackStart = new Date(clockNow);
    lookbackStart.setDate(lookbackStart.getDate() - DASHBOARD_SNAPSHOT_LOOKBACK_DAYS);
    if (yearStart.getTime() < lookbackStart.getTime()) lookbackStart.setTime(yearStart.getTime());
    const distanceLookbackStart = new Date(clockNow);
    distanceLookbackStart.setDate(distanceLookbackStart.getDate() - DASHBOARD_DISTANCE_LOOKBACK_DAYS);
    if (yearStart.getTime() < distanceLookbackStart.getTime()) {
        distanceLookbackStart.setTime(yearStart.getTime());
    }

    let positions = [];
    let snapshotWarning = null;
    let reconcileSummary = null;
    let reconcileWarning = null;
    let positionsStale = false;

    try {
        // Pull current GPS on each load. A short shared cache keeps us under Locator's
        // 3 requests/minute limit; allowStale returns last positions if throttled.
        const latest = await fetchLatestPositions({ allowStale: true });
        positions = latest.positions || [];
        positionsStale = Boolean(latest.stale);
    } catch (error) {
        return {
            configured: true,
            connected: false,
            message: error?.message || 'Failed to load Locator positions',
        };
    }

    // Do not block dashboard paint on per-device ERP create/patch (was N sequential DB round-trips).
    const reconcileSchedule = scheduleLocatorReconcile(positions);
    reconcileSummary = reconcileSchedule.summary;

    // Snapshot writes are best-effort — don't delay chart query on inserts.
    void Promise.all((positions || []).map((position) => recordLocatorSnapshot(position, 'rest'))).catch(
        (error) => {
            snapshotWarning = error?.message || 'Failed to save GPS snapshots';
            console.warn('[LocatorFleetDashboard] Snapshot capture failed:', snapshotWarning);
        },
    );

    const [hourlySnapshots, dailySnapshots, resolveLabel, gpsTrackedVehicles] = await Promise.all([
        loadDashboardChartSnapshots(lookbackStart),
        loadDailyDistanceSnapshots(distanceLookbackStart),
        createLocatorChartLabelResolver(positions),
        buildGpsTrackedVehicles(positions),
    ]);
    const snapshots = hourlySnapshots;
    const distanceSnapshots = dailySnapshots?.length ? dailySnapshots : hourlySnapshots;

    const trackingFrom = distanceSnapshots[0]?.capturedAt || snapshots[0]?.capturedAt || null;
    const trackingDaysWithData = collectSnapshotDayKeys(distanceSnapshots, periodNow).length;
    const odometerByVehicle = applyLocatorChartLabels(buildOdometerChart(positions), resolveLabel);

    const payload = {
        configured: true,
        connected: true,
        generatedAt: clockNow.toISOString(),
        periodYear: periodNow.getFullYear(),
        positionsSource: positionsStale ? 'cached' : 'live',
        positionsStale,
        snapshotWarning,
        reconcileSummary,
        reconcileDeferred: reconcileSchedule.deferred === true,
        reconcileWarning,
        trackingFrom,
        trackingDaysWithData,
        vehicleCount: positions.length,
        // Live from Locator /v1/position/latest — totalDistanceKm / odometer (no history API in Locator docs)
        odometerByVehicle,
        currentKmByVehicle: odometerByVehicle,
        gpsTrackedVehicles,
        runningKmByVehicle: mapLocatorPeriodDashboardLabels(
            buildRunningKmByVehicleDashboard(distanceSnapshots, positions, periodNow),
            resolveLabel,
        ),
        runningKm: {
            day: buildRunningKmDaySeries(distanceSnapshots, positions, periodNow),
            month: buildRunningKmMonthSeries(distanceSnapshots, positions, periodNow),
            year: buildRunningKmYearSeries(distanceSnapshots, positions, periodNow),
        },
        idleTimeByVehicle: mapLocatorPeriodDashboardLabels(
            buildIdleTimeByVehicleDashboard(snapshots, positions, periodNow),
            resolveLabel,
        ),
        salikWise: mapLocatorPeriodDashboardLabels(
            buildSalikWiseByVehicleDashboard(snapshots, positions, periodNow),
            resolveLabel,
        ),
        snapshotCount: snapshots.length,
        distanceSnapshotCount: distanceSnapshots.length,
        // Locator client API (per docs) only exposes latest + live WS — daily history is from our snapshots
        historySource: 'local_snapshots',
        locatorApiSupportsHistory: false,
    };

    console.log(
        `[LocatorFleetDashboard] positions=${positions.length} hourly=${snapshots.length} daily=${distanceSnapshots.length} total=${Date.now() - startedAt}ms`,
    );

    return payload;
}

function monthIdleKmPayload(allRows, inMonth, start, end) {
    const idleMs = idleMsForDeviceInRange(allRows, start, end);
    const lastInRange = [...(inMonth || [])].reverse().find((row) => snapshotDistanceM(row) > 0);
    const lastOverall = [...(allRows || [])].reverse().find((row) => snapshotDistanceM(row) > 0);
    const kmRun = Number(runningKmSumForDeviceInRange(allRows, start, end, { calendarMonth: true })) || 0;
    return {
        kmRun,
        runningKm: kmRun,
        currentKm: currentKmFromSnapshot(lastInRange) || currentKmFromSnapshot(lastOverall) || 0,
        idleTimeMinutes: Math.round(idleMs / 60000),
        idleTimeSeconds: Math.round(idleMs / 1000),
        idleTimeLabel: formatLocatorIdleLabel(idleMs),
        rangeStart: start.toISOString(),
        rangeEnd: inclusiveRangeEnd(end).toISOString(),
    };
}

function emptyMonthStats(start = null, end = null) {
    return {
        kmRun: 0,
        runningKm: 0,
        currentKm: 0,
        deviceName: '',
        idleTimeMinutes: 0,
        idleTimeSeconds: 0,
        idleTimeLabel: '00:00:00 Hrs',
        rangeStart: start ? start.toISOString() : null,
        rangeEnd: end ? inclusiveRangeEnd(end).toISOString() : null,
    };
}

function emptyRangeStats(start = null, end = null) {
    return emptyMonthStats(start, end);
}

function defaultRangeDayKeys(now = new Date()) {
    return {
        from: localDateKey(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: localDateKey(now),
    };
}

async function lastOdometerRowsBefore(deviceIds, before) {
    const ids = (deviceIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length || !before) return [];
    return LocatorGpsSnapshot.aggregate([
        { $match: { deviceId: { $in: ids }, capturedAt: { $lt: before } } },
        { $sort: { capturedAt: -1 } },
        {
            $group: {
                _id: '$deviceId',
                deviceId: { $first: '$deviceId' },
                deviceName: { $first: '$deviceName' },
                totalDistanceM: { $first: '$totalDistanceM' },
                odometer: { $first: '$odometer' },
                state: { $first: '$state' },
                speedKmh: { $first: '$speedKmh' },
                statusDurationSec: { $first: '$statusDurationSec' },
                idleStart: { $first: '$idleStart' },
                capturedAt: { $first: '$capturedAt' },
            },
        },
    ]);
}

/**
 * Monthly running km + idle for one GPS device — snapshots in that calendar month only.
 * KM is first-to-last odometer in the month; idle matches Locator Excessive Idling (10 min minimum).
 */
export async function getLocatorMonthStatsMap(deviceId, monthKeys = []) {
    const keys = [...new Set((monthKeys || []).map((key) => String(key || '').trim()))].filter((key) =>
        /^\d{4}-(0[1-9]|1[0-2])$/.test(key),
    );
    const now = new Date();
    const bounds = keys.map((key) => ({ key, ...monthBoundsForKey(key, now) }));
    const result = Object.fromEntries(
        bounds.map(({ key, start, end }) => [key, emptyMonthStats(start, end)]),
    );
    const id = Number(deviceId);
    if (!Number.isFinite(id) || id <= 0 || keys.length === 0) return result;

    const minStart = new Date(Math.min(...bounds.map((b) => b.start.getTime())));
    const maxEnd = new Date(Math.max(...bounds.map((b) => b.end.getTime())));
    const [priorRows, rows] = await Promise.all([
        lastOdometerRowsBefore([id], minStart),
        LocatorGpsSnapshot.find({
            deviceId: id,
            capturedAt: { $gte: minStart, $lt: maxEnd },
        })
            .select('deviceId totalDistanceM odometer state speedKmh statusDurationSec idleStart capturedAt')
            .sort({ capturedAt: 1 })
            .lean(),
    ]);
    const allRows = [...priorRows, ...rows].sort(
        (a, b) => new Date(a.capturedAt) - new Date(b.capturedAt),
    );

    for (const { key, start, end } of bounds) {
        const inMonth = allRows.filter((row) => isCapturedInRange(row.capturedAt, start, end));
        result[key] = monthIdleKmPayload(allRows, inMonth, start, end);
    }
    return result;
}

export async function getLocatorMonthStatsForDevice(deviceId, monthKey) {
    const map = await getLocatorMonthStatsMap(deviceId, [monthKey]);
    const now = new Date();
    const { start, end } = monthBoundsForKey(monthKey, now);
    return map[String(monthKey)] || emptyMonthStats(start, end);
}

/** One month of running KM + idle for many GPS devices (fuel list). */
export async function getLocatorMonthStatsByDevices(deviceIds = [], monthKey) {
    const key = String(monthKey || '').trim();
    const now = new Date();
    const { start, end } = monthBoundsForKey(key, now);
    const ids = [...new Set((deviceIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))];
    const result = Object.fromEntries(ids.map((id) => [String(id), emptyMonthStats(start, end)]));
    if (!ids.length || !/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return result;

    const [priorRows, rows] = await Promise.all([
        lastOdometerRowsBefore(ids, start),
        LocatorGpsSnapshot.find({
            deviceId: { $in: ids },
            capturedAt: { $gte: start, $lt: end },
        })
            .select('deviceId totalDistanceM odometer state speedKmh statusDurationSec idleStart capturedAt')
            .sort({ capturedAt: 1 })
            .lean(),
    ]);

    const byDevice = new Map();
    for (const row of [...priorRows, ...rows]) {
        const id = String(row.deviceId);
        if (!byDevice.has(id)) byDevice.set(id, []);
        byDevice.get(id).push(row);
    }

    for (const id of ids) {
        const deviceRows = (byDevice.get(String(id)) || []).sort(
            (a, b) => new Date(a.capturedAt) - new Date(b.capturedAt),
        );
        const inMonth = deviceRows.filter((row) => isCapturedInRange(row.capturedAt, start, end));
        result[String(id)] = monthIdleKmPayload(deviceRows, inMonth, start, end);
    }

    return result;
}

/**
 * Custom-day GPS stats for fuel: current odometer, running KM, and idle time.
 * Window is From date 12:00 AM through the end of the To date (not the next calendar day).
 * Idle ignores events shorter than 10 minutes (Excessive Idling Report).
 */
export async function getLocatorRangeStatsByDevices(deviceIds = [], fromKey, toKey, liveByDevice = null) {
    const now = new Date();
    const defaults = defaultRangeDayKeys(now);
    const from = DAY_KEY_RE.test(String(fromKey || '').trim()) ? String(fromKey).trim() : defaults.from;
    const to = DAY_KEY_RE.test(String(toKey || '').trim()) ? String(toKey).trim() : defaults.to;
    const { start, end } = dayBoundsFromKeys(from, to, now);
    const displayFrom = localDateKey(start);
    const displayTo = localDateKey(inclusiveEndDay(end));
    const displayRangeEnd = inclusiveRangeEnd(end).toISOString();
    const ids = [...new Set((deviceIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))];
    const result = Object.fromEntries(ids.map((id) => [String(id), emptyRangeStats(start, end)]));
    if (!ids.length) {
        return { from: displayFrom, to: displayTo, start, end, byDevice: result };
    }

    const idleLookaheadEnd = new Date(end.getTime() + MAX_IDLE_SAMPLE_GAP_MS);
    const includeLive = rangeTouchesToday(start, end);

    const [priorRows, rows, latestRows] = await Promise.all([
        lastOdometerRowsBefore(ids, start),
        LocatorGpsSnapshot.find({
            deviceId: { $in: ids },
            capturedAt: { $gte: start, $lt: idleLookaheadEnd },
        })
            .select('deviceId deviceName totalDistanceM odometer state speedKmh statusDurationSec idleStart capturedAt')
            .sort({ capturedAt: 1 })
            .lean(),
        lastOdometerRowsBefore(ids, new Date(Date.now() + 60_000)),
    ]);

    const byDevice = new Map();
    for (const row of [...priorRows, ...rows]) {
        const id = String(row.deviceId);
        if (!byDevice.has(id)) byDevice.set(id, []);
        byDevice.get(id).push(row);
    }

    const latestByDevice = new Map();
    for (const row of latestRows || []) {
        latestByDevice.set(String(row.deviceId), row);
    }

    for (const id of ids) {
        const deviceRows = (byDevice.get(String(id)) || []).sort(
            (a, b) => new Date(a.capturedAt) - new Date(b.capturedAt),
        );
        const livePosition = includeLive ? liveByDevice?.get?.(String(id)) || null : null;
        const idleMs = idleMsForDeviceInRange(deviceRows, start, end, livePosition, {
            includeLiveSession: includeLive,
        });
        const runningKm = runningKmSumForDeviceInRange(deviceRows, start, end);
        const latest = latestByDevice.get(String(id));
        const namedRow = [...deviceRows].reverse().find((row) => String(row?.deviceName || '').trim()) || latest;
        result[String(id)] = {
            currentKm: currentKmFromSnapshot(latest),
            runningKm,
            kmRun: runningKm,
            deviceName: String(namedRow?.deviceName || latest?.deviceName || '').trim(),
            idleTimeMinutes: Math.round(idleMs / 60000),
            idleTimeSeconds: Math.round(idleMs / 1000),
            idleTimeLabel: formatLocatorIdleLabel(idleMs),
            rangeStart: start.toISOString(),
            rangeEnd: displayRangeEnd,
        };
    }

    return { from: displayFrom, to: displayTo, start, end, byDevice: result };
}

function gpsVehicleNumberFromPosition(position, fallback = '') {
    const name = String(position?.deviceName || position?.name || '').trim();
    if (name && !isEmirateOnlyLabel(name)) return name;
    return String(fallback || '').trim();
}

/**
 * Fuel GPS page: one row per Locator GPS vehicle, labelled with the GPS device name.
 */
export async function buildFuelGpsPageStats({ fromKey, toKey, erpVehicles = [] } = {}) {
    const now = new Date();
    const defaults = defaultRangeDayKeys(now);
    const from = DAY_KEY_RE.test(String(fromKey || '').trim()) ? String(fromKey).trim() : defaults.from;
    const to = DAY_KEY_RE.test(String(toKey || '').trim()) ? String(toKey).trim() : defaults.to;
    const { start, end } = dayBoundsFromKeys(from, to, now);
    const configured = isLocatorConfigured();

    let positions = [];
    if (configured) {
        try {
            const latest = await fetchLatestPositions({ allowStale: true });
            positions = Array.isArray(latest?.positions) ? latest.positions : [];
        } catch {
            positions = [];
        }
    }

    const deviceIds = new Set();
    const positionByDevice = new Map();
    for (const position of positions) {
        const id = Number(position?.deviceId);
        if (!Number.isFinite(id) || id <= 0) continue;
        deviceIds.add(id);
        positionByDevice.set(String(id), position);
    }

    const snapshotIds = await LocatorGpsSnapshot.distinct('deviceId', {
        capturedAt: { $gte: start, $lt: end },
    });
    for (const raw of snapshotIds || []) {
        const id = Number(raw);
        if (Number.isFinite(id) && id > 0) deviceIds.add(id);
    }

    const erpByDevice = new Map();
    for (const vehicle of erpVehicles || []) {
        const id = Number(vehicle?.locatorDeviceId);
        if (!Number.isFinite(id) || id <= 0) continue;
        deviceIds.add(id);
        erpByDevice.set(String(id), vehicle);
    }

    const ids = [...deviceIds];
    if (configured && positions.length) {
        void Promise.all(positions.map((position) => recordLocatorSnapshot(position, 'rest'))).catch(() => {});
    }
    const gps = await getLocatorRangeStatsByDevices(ids, from, to, positionByDevice);
    const byDevice = gps?.byDevice || {};

    const rows = ids.map((id) => {
        const key = String(id);
        const stats = byDevice[key] || emptyRangeStats(start, end);
        const position = positionByDevice.get(key);
        const erp = erpByDevice.get(key);
        const gpsNumber =
            gpsVehicleNumberFromPosition(position, stats.deviceName) ||
            String(stats.deviceName || '').trim() ||
            (id ? `GPS ${id}` : '—');
        const liveKm = position ? toOdometerKm(position.attributes || position) : 0;
        const currentKm = Number(stats.currentKm) > 0 ? Number(stats.currentKm) : Number(liveKm) || 0;

        return {
            deviceId: id,
            vehicleNumber: gpsNumber,
            gpsVehicleNumber: gpsNumber,
            vehicleId: erp?._id || null,
            plateNo: erp ? [erp.plateEmirate, erp.plateNumber].filter(Boolean).join(' ').trim() : '',
            vehicleName: erp?.name || gpsNumber,
            vehicleAssetNo: erp?.assetId || '',
            hasGps: true,
            currentKm,
            runningKm: Number(stats.runningKm ?? stats.kmRun) || 0,
            idleTimeMinutes: Number(stats.idleTimeMinutes) || 0,
            idleTimeSeconds: Number(stats.idleTimeSeconds) || 0,
            idleTimeLabel: stats.idleTimeLabel || formatLocatorIdleLabel(0),
        };
    });

    rows.sort((a, b) =>
        String(a.vehicleNumber).localeCompare(String(b.vehicleNumber), undefined, {
            numeric: true,
            sensitivity: 'base',
        }),
    );

    return {
        from,
        to,
        rangeStart: start,
        rangeEnd: inclusiveRangeEnd(end),
        configured,
        rows,
    };
}

export async function buildLocatorFleetDashboard({ year } = {}) {
    if (!isLocatorConfigured()) {
        return {
            configured: false,
            message: 'Locator GPS is not configured.',
        };
    }

    const selectedYear = Number(year) || new Date().getFullYear();
    const cached = fleetDashboardCache.payload;
    if (
        cached &&
        fleetDashboardCache.year === selectedYear &&
        Date.now() - fleetDashboardCache.at < FLEET_DASHBOARD_CACHE_TTL_MS
    ) {
        return cached;
    }

    if (fleetDashboardInFlight && fleetDashboardInFlightYear === selectedYear) {
        return fleetDashboardInFlight;
    }

    fleetDashboardInFlightYear = selectedYear;
    fleetDashboardInFlight = buildLocatorFleetDashboardUncached(selectedYear)
        .then((payload) => {
            if (payload?.connected) {
                fleetDashboardCache = { at: Date.now(), year: selectedYear, payload };
            }
            return payload;
        })
        .finally(() => {
            fleetDashboardInFlight = null;
            fleetDashboardInFlightYear = null;
        });

    return fleetDashboardInFlight;
}
