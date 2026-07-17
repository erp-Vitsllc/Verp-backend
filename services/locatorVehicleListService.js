import AssetItem from '../models/AssetItem.js';
import AssetType from '../models/AssetType.js';
import AssetCategory from '../models/AssetCategory.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { generateNextFleetVehicleAssetId, buildFleetVehicleMongoScope } from '../utils/fleetVehicleAssetId.js';
import { isFleetVehicleAssetFields } from '../utils/assetApprovalHelpers.js';
import { fetchLatestPositions, isLocatorConfigured, locatorLogin } from './locatorService.js';
import { getCachedLocatorPositions } from './locatorWebSocketService.js';
import { readLocatorTokens } from '../utils/locatorTokenStore.js';
import { resolveRegistrationExpiryDate } from '../utils/vehicleDocumentRenewal.js';

const ERP_VEHICLE_LIST_SELECT =
    'assetId name plateEmirate plateNumber modelYear currentKilometer status registrationExpiryDate assignedTo assignedCompany acceptanceStatus vehicleProfileActivationStatus vehicleDispositionStatus onServiceActive onLeaveActive pendingAction actionRequiredBy assignedDate pendingActionDetails updatedAt locatorDeviceId documents.type documents.expiryDate documents.issueDate documents.createdAt documents.status documents.documentStatus documents.description';

let lastLocatorLatestFetchAt = 0;
const LOCATOR_LATEST_MIN_INTERVAL_MS = 60 * 1000;

async function resolveLocatorPositionsForList() {
    const cached = getCachedLocatorPositions();
    const now = Date.now();
    const cacheIsFresh = cached.length > 0 && now - lastLocatorLatestFetchAt < LOCATOR_LATEST_MIN_INTERVAL_MS;

    if (cacheIsFresh) {
        return { positions: cached, source: 'cache' };
    }

    try {
        const latest = await fetchLatestPositions();
        lastLocatorLatestFetchAt = now;
        const positions = latest.positions || [];
        if (positions.length > 0) {
            return { positions, source: 'live' };
        }
        if (cached.length > 0) {
            return { positions: cached, source: 'cache-empty-live' };
        }
        return { positions: [], source: 'live-empty' };
    } catch (error) {
        if (cached.length > 0) {
            return { positions: cached, source: 'cache-fallback', warning: error?.message };
        }
        throw error;
    }
}

function normalizePersonName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function extractLocatorOwnerName(deviceName) {
    const parts = String(deviceName || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (parts.length < 2) return '';

    const ownerParts = [];
    for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (/^\d+$/.test(parts[i])) break;
        ownerParts.unshift(parts[i]);
    }

    return ownerParts.join(' ').trim();
}

function normalizePlateDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function buildPlateNumber(plateCode, plateDigits) {
    const code = String(plateCode || '').trim().toUpperCase();
    const digits = String(plateDigits || '').trim();
    if (code && digits) return `${code} ${digits}`;
    return digits || code;
}

function employeeDisplayName(employee) {
    if (!employee) return '';
    return `${employee.firstName || ''} ${employee.lastName || ''}`.trim();
}

function matchEmployeesByOwnerName(ownerName, employees) {
    const target = normalizePersonName(ownerName);
    if (!target) return [];

    const targetTokens = target.split(' ').filter(Boolean);
    const scored = [];

    for (const employee of employees) {
        const full = normalizePersonName(employeeDisplayName(employee));
        const first = normalizePersonName(employee.firstName);
        const last = normalizePersonName(employee.lastName);

        if (!full) continue;

        let score = 0;
        if (full === target) score = 100;
        else if (`${first} ${last}`.trim() === target) score = 95;
        else if (last === target || first === target) score = 80;
        else if (full.includes(target) || target.includes(full)) score = 70;
        else if (last && target.includes(last)) score = 60;
        else if (first && target.includes(first)) score = 55;
        else if (targetTokens.length > 1) {
            const matchedTokens = targetTokens.filter(
                (token) => full.includes(token) || first.includes(token) || last.includes(token),
            );
            if (matchedTokens.length === targetTokens.length) score = 50 + matchedTokens.length * 5;
            else if (matchedTokens.length > 0) score = 25 + matchedTokens.length * 5;
        }

        if (score > 0) scored.push({ employee, score });
    }

    scored.sort((a, b) => b.score - a.score);

    const seen = new Set();
    const unique = [];
    for (const entry of scored) {
        const id = String(entry.employee._id);
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(entry.employee);
    }

    return unique;
}

function mapMatchedEmployees(employees) {
    return employees.map((employee) => ({
        _id: employee._id,
        firstName: employee.firstName,
        lastName: employee.lastName,
        employeeId: employee.employeeId,
        displayName: employeeDisplayName(employee),
    }));
}

function employeeIdsMatch(a, b) {
    if (!a || !b) return false;
    return String(a) === String(b);
}

function resolveAssignedEmployeeId(vehicle) {
    const assigned = vehicle?.assignedTo;
    if (!assigned) return null;
    if (typeof assigned === 'object') return assigned._id || assigned.id || null;
    return assigned;
}

function isVehicleWorking(locator) {
    const state = String(locator?.state || '').toLowerCase();
    return state === 'moving' || state === 'idling';
}

function isVehicleAssigned(vehicle) {
    const status = String(vehicle?.status || '').toLowerCase();
    return Boolean(vehicle?.assignedTo) && (status === 'assigned' || status === 'active');
}

function enrichLocatorListRow(row) {
    const ownerName = extractLocatorOwnerName(row.locator?.deviceName || row.name || '');
    const profileInactive =
        String(row.vehicleProfileActivationStatus || 'inactive').toLowerCase().trim() !== 'active';
    const erpUnassigned = !row.assignedTo && !row.assignedCompany;
    const needsLocatorSetup = Boolean(row.locator) && (row.isLocatorOnly || profileInactive);
    const isErpActive =
        !needsLocatorSetup && !profileInactive && isVehicleAssigned(row) && !erpUnassigned;
    const needsPlate =
        !String(row.plateEmirate || '').trim() ||
        !String(row.plateNumber || '').trim() ||
        row.plateNumber === '—';

    return {
        ...row,
        locatorOwnerName: ownerName,
        matchedEmployee: null,
        matchedEmployees: [],
        assignmentMismatch: false,
        needsLocatorSetup,
        locatorListStatus: isErpActive
            ? { label: 'Active', kind: 'active' }
            : { label: 'Inactive', kind: 'inactive' },
        needsPlate,
    };
}

async function loadActiveEmployees() {
    return EmployeeBasic.find({
        status: { $in: ['Active', 'active', 'Permanent', 'permanent'] },
    })
        .select('firstName lastName employeeId status')
        .lean();
}

async function generateNextAssetId() {
    return generateNextFleetVehicleAssetId();
}

async function resolveVehicleTypeAndCategory() {
    let vehicleType = await AssetType.findOne({
        isActive: true,
        name: { $regex: /vehicle|car|fleet|truck|van|pickup|suv|corolla|toyota/i },
    }).lean();

    if (!vehicleType) {
        const fleetSample = await AssetItem.findOne({
            $or: [
                { plateNumber: { $exists: true, $nin: [null, ''] } },
                { locatorDeviceId: { $ne: null } },
            ],
        })
            .select('typeId')
            .lean();

        if (fleetSample?.typeId) {
            vehicleType = await AssetType.findById(fleetSample.typeId).lean();
        }
    }

    if (!vehicleType) {
        vehicleType = await AssetType.findOne({ isActive: true }).sort({ name: 1 }).lean();
    }

    if (!vehicleType) {
        vehicleType = await AssetType.findOne().sort({ name: 1 }).lean();
    }

    if (!vehicleType) {
        const error = new Error('No vehicle asset type configured in ERP');
        error.statusCode = 500;
        throw error;
    }

    let category = await AssetCategory.findOne({
        isActive: true,
        name: { $regex: /vehicle|fleet|car/i },
    }).lean();

    if (!category) {
        category = await AssetCategory.findOne({
            isActive: true,
            typeId: vehicleType._id,
        }).lean();
    }

    if (!category) {
        const fleetSample = await AssetItem.findOne({
            $or: [
                { plateNumber: { $exists: true, $nin: [null, ''] } },
                { locatorDeviceId: { $ne: null } },
            ],
        })
            .select('categoryId')
            .lean();

        if (fleetSample?.categoryId) {
            category = await AssetCategory.findById(fleetSample.categoryId).lean();
        }
    }

    if (!category) {
        category = await AssetCategory.findOne({ isActive: true }).lean();
    }

    if (!category) {
        category = await AssetCategory.findOne().lean();
    }

    if (!category) {
        const error = new Error('No asset category configured in ERP');
        error.statusCode = 500;
        throw error;
    }

    return { typeId: vehicleType._id, categoryId: category._id };
}

export async function createLocatorErpVehicle({
    deviceId,
    deviceName,
    plateEmirate,
    plateNumber,
    createdBy,
}) {
    const { typeId, categoryId } = await resolveVehicleTypeAndCategory();
    const assetId = await generateNextAssetId();
    const name = String(deviceName || `Locator ${deviceId || ''}`).trim() || assetId;

    return AssetItem.create({
        typeId,
        categoryId,
        assetId,
        name,
        plateEmirate: String(plateEmirate || 'Dubai').trim(),
        plateNumber,
        locatorDeviceId: deviceId != null ? Number(deviceId) : null,
        status: 'Unassigned',
        assetValue: 0,
        purchaseDate: new Date(),
        vehicleProfileActivationStatus: 'inactive',
        ...(createdBy ? { createdBy } : {}),
    });
}

export async function findErpVehicleForLocatorLink({ deviceId, deviceName, plateNumber, erpVehicleId }) {
    if (erpVehicleId) {
        const byId = await AssetItem.findById(erpVehicleId);
        if (byId) return byId;
    }

    if (deviceId != null) {
        const byDevice = await AssetItem.findOne({ locatorDeviceId: Number(deviceId) });
        if (byDevice) return byDevice;
    }

    const erpVehicles = await loadErpFleetVehicles();
    if (deviceName) {
        const byName = matchErpVehicle(deviceName, erpVehicles);
        if (byName) return await AssetItem.findById(byName._id);
    }

    const digits = normalizePlateDigits(plateNumber);
    if (digits) {
        const byPlate = erpVehicles.find((vehicle) => {
            const erpDigits = normalizePlateDigits(vehicle.plateNumber);
            return erpDigits && (erpDigits === digits || erpDigits.endsWith(digits) || digits.endsWith(erpDigits));
        });
        if (byPlate) return await AssetItem.findById(byPlate._id);
    }

    return null;
}

async function findErpVehicleForPlateSave({ deviceId, deviceName, plateNumber, erpVehicleId }) {
    if (erpVehicleId) {
        const byId = await AssetItem.findById(erpVehicleId);
        if (byId) return byId;
    }

    if (deviceId != null) {
        const byDevice = await AssetItem.findOne({ locatorDeviceId: Number(deviceId) });
        if (byDevice) return byDevice;
    }

    const plate = String(plateNumber || '').trim();
    if (plate) {
        const byPlate = await AssetItem.findOne({ plateNumber: plate });
        if (byPlate) return byPlate;
    }

    const digits = normalizePlateDigits(plateNumber);
    if (digits) {
        const byDigits = await AssetItem.findOne({
            plateNumber: { $regex: new RegExp(`${digits}$`) },
        });
        if (byDigits) return byDigits;
    }

    return null;
}

export async function saveLocatorVehiclePlate({
    deviceId,
    deviceName,
    plateEmirate,
    plateCode,
    plateDigits,
    erpVehicleId,
    createdBy,
}) {
    const plateNumber = buildPlateNumber(plateCode, plateDigits);
    if (!plateNumber) {
        const error = new Error('Plate number is required');
        error.statusCode = 400;
        throw error;
    }

    let asset = await findErpVehicleForPlateSave({
        deviceId,
        deviceName,
        plateNumber,
        erpVehicleId,
    });

    if (!asset) {
        asset = await createLocatorErpVehicle({
            deviceId,
            deviceName,
            plateEmirate,
            plateNumber,
            createdBy,
        });
    } else {
        asset.plateEmirate = String(plateEmirate || 'Dubai').trim();
        asset.plateNumber = plateNumber;
        if (deviceId != null) asset.locatorDeviceId = Number(deviceId);
        await asset.save();
    }

    return asset;
}

function extractPlateCandidatesFromLocatorName(name) {
    const matches = String(name || '').match(/\b\d{3,6}\b/g);
    return matches ? [...new Set(matches.map((m) => normalizePlateDigits(m)).filter(Boolean))] : [];
}

function toOdometerKm(position = null) {
    const attrs = position?.attributes || {};

    if (attrs.totalDistanceKm != null && attrs.totalDistanceKm !== '') {
        const parsed = Number(String(attrs.totalDistanceKm).replace(/,/g, ''));
        if (Number.isFinite(parsed)) return Math.round(parsed);
    }

    if (position?.totalDistanceKm != null && position.totalDistanceKm !== '') {
        const parsed = Number(String(position.totalDistanceKm).replace(/,/g, ''));
        if (Number.isFinite(parsed)) return Math.round(parsed);
    }

    if (Number.isFinite(Number(attrs.totalDistance))) {
        return Math.round(Number(attrs.totalDistance) / 1000);
    }

    if (Number.isFinite(Number(position?.totalDistance))) {
        return Math.round(Number(position.totalDistance) / 1000);
    }

    if (Number.isFinite(Number(attrs.odometer))) {
        return Math.round(Number(attrs.odometer) / 1000);
    }

    return null;
}

function formatLocatorGpsStatus(position, registryVehicle) {
    const attrs = position?.attributes || {};
    const state = String(attrs.state || '').trim();
    const live = String(position?.livestatus || registryVehicle?.status || '').trim();

    if (state) {
        const label = state.charAt(0).toUpperCase() + state.slice(1);
        if (live) return `${label} · ${live}`;
        return label;
    }

    if (live) return live;
    return registryVehicle?.status || 'Unknown';
}

function buildPositionMap(positions) {
    const map = new Map();
    for (const position of positions || []) {
        if (position?.deviceId != null) {
            map.set(String(position.deviceId), position);
        }
    }
    return map;
}

function buildRegistryMap(registryVehicles) {
    const map = new Map();
    for (const vehicle of registryVehicles || []) {
        if (vehicle?.id != null) {
            map.set(String(vehicle.id), vehicle);
        }
    }
    return map;
}

function matchErpVehicle(locatorName, erpVehicles) {
    const candidates = extractPlateCandidatesFromLocatorName(locatorName);
    if (!candidates.length) return null;

    for (const erp of erpVehicles) {
        const erpDigits = normalizePlateDigits(erp.plateNumber);
        if (!erpDigits) continue;
        if (candidates.some((c) => erpDigits === c || erpDigits.endsWith(c) || c.endsWith(erpDigits))) {
            return erp;
        }
    }

    return null;
}

async function loadErpFleetVehicles() {
    const vehicleTypeDocs = await AssetType.find({
        isActive: true,
        name: { $regex: /vehicle|car|fleet|truck/i },
    })
        .select('_id')
        .lean();

    const vehicleTypeIds = vehicleTypeDocs.map((t) => t._id);
    const fleetScope = buildFleetVehicleMongoScope({ vehicleTypeIds });

    const items = await AssetItem.find(fleetScope)
        .populate('typeId', 'name')
        .populate('assignedTo', 'firstName lastName employeeId')
        .populate('assignedCompany', 'name nickName companyShortName companyName')
        .select(ERP_VEHICLE_LIST_SELECT)
        .lean();

    return items.filter((it) =>
        isFleetVehicleAssetFields({
            plateNumber: it.plateNumber,
            typeName: it.typeId?.name || '',
            asset: it,
        }),
    );
}

function mapErpVehicleToListRow(erp, locatorOverlay = null) {
    const regExp = resolveRegistrationExpiryDate(erp);

    return {
        _id: erp._id,
        assetId: erp.assetId,
        plateEmirate: erp.plateEmirate || '',
        plateNumber: erp.plateNumber || '',
        modelYear: erp.modelYear || '',
        currentKilometer:
            locatorOverlay?.currentKilometer != null
                ? locatorOverlay.currentKilometer
                : Number(erp.currentKilometer) || 0,
        registrationExpiryDate: regExp,
        status: erp.status,
        vehicleDispositionStatus: erp.vehicleDispositionStatus || 'active',
        vehicleProfileActivationStatus: erp.vehicleProfileActivationStatus || '',
        assignedTo: erp.assignedTo,
        assignedCompany: erp.assignedCompany,
        acceptanceStatus: erp.acceptanceStatus || '',
        pendingAction: erp.pendingAction || '',
        pendingActionDetails: erp.pendingActionDetails || null,
        assignedDate: erp.assignedDate || null,
        updatedAt: erp.updatedAt || null,
        onServiceActive: erp.onServiceActive === true,
        onLeaveActive: erp.onLeaveActive === true,
        locator: locatorOverlay,
        locatorDeviceId: erp.locatorDeviceId ?? locatorOverlay?.deviceId ?? null,
        isLocatorOnly: false,
    };
}

function mapLocatorOnlyRow(deviceId, registryVehicle, position) {
    const attrs = position?.attributes || {};
    const driver = position?.driver || {};
    const deviceName = position?.deviceName || registryVehicle?.name || '';

    return {
        _id: `locator-${deviceId}`,
        assetId: '',
        name: deviceName,
        plateEmirate: '',
        plateNumber: '',
        modelYear: '',
        currentKilometer: toOdometerKm(position),
        registrationExpiryDate: null,
        status: 'Unassigned',
        vehicleDispositionStatus: 'active',
        vehicleProfileActivationStatus: 'inactive',
        assignedTo: null,
        assignedCompany: null,
        acceptanceStatus: '',
        onServiceActive: false,
        onLeaveActive: false,
        locator: {
            deviceId: Number(deviceId),
            deviceName: position?.deviceName || registryVehicle?.name || '',
            uniqueId: registryVehicle?.uniqueId || '',
            gpsStatus: formatLocatorGpsStatus(position, registryVehicle),
            state: attrs.state || '',
            livestatus: position?.livestatus || registryVehicle?.status || '',
            address: position?.address || '',
            speedKmh: position?.speedKmh ?? null,
            ignition: attrs.ignition === true,
            currentKilometer: toOdometerKm(position),
            driverName: driver?.driver_name || '',
            lastUpdate: position?.deviceTime || registryVehicle?.lastUpdate || null,
        },
        isLocatorOnly: true,
    };
}

async function resolveLocatorErpListRow({ deviceId, deviceName, locatorOverlay }) {
    await ensureLocatorErpVehicle({
        deviceId: Number(deviceId),
        deviceName: deviceName || `Locator ${deviceId}`,
    });

    const erp = await loadErpVehicleByLocatorDeviceId(deviceId);
    if (!erp) return null;

    return mapErpVehicleToListRow(erp, locatorOverlay);
}

export async function buildLocatorVehicleList() {
    if (!isLocatorConfigured()) {
        return {
            configured: false,
            vehicles: [],
            message: 'Locator GPS is not configured.',
        };
    }

    let positions = [];
    let registryVehicles = [];
    let positionsSource = 'unknown';

    try {
        const resolved = await resolveLocatorPositionsForList();
        positions = resolved.positions || [];
        positionsSource = resolved.source || 'unknown';

        const stored = await readLocatorTokens();
        registryVehicles = stored?.vehicles || [];

        if (!registryVehicles.length) {
            const session = await locatorLogin();
            registryVehicles = session?.vehicles || [];
        }
    } catch (error) {
        return {
            configured: true,
            connected: false,
            vehicles: [],
            message: error?.message || 'Failed to load Locator vehicles',
        };
    }

    const positionMap = buildPositionMap(positions);
    const registryMap = buildRegistryMap(registryVehicles);
    const erpVehicles = await loadErpFleetVehicles();
    const matchedErpIds = new Set();
    const mergedRows = [];

    const deviceIds = new Set([
        ...positions.map((p) => String(p.deviceId)),
        ...registryVehicles.map((v) => String(v.id)),
    ]);

    for (const deviceId of deviceIds) {
        const position = positionMap.get(deviceId) || null;
        const registryVehicle = registryMap.get(deviceId) || null;
        const locatorName = position?.deviceName || registryVehicle?.name || '';
        const erpMatch =
            matchErpVehicle(locatorName, erpVehicles) ||
            erpVehicles.find((erp) => Number(erp.locatorDeviceId) === Number(deviceId)) ||
            null;
        const attrs = position?.attributes || {};
        const driver = position?.driver || {};

        const locatorOverlay = {
            deviceId: Number(deviceId),
            deviceName: locatorName,
            uniqueId: registryVehicle?.uniqueId || '',
            gpsStatus: formatLocatorGpsStatus(position, registryVehicle),
            state: attrs.state || '',
            livestatus: position?.livestatus || registryVehicle?.status || '',
            address: position?.address || '',
            speedKmh: position?.speedKmh ?? null,
            ignition: attrs.ignition === true,
            currentKilometer: toOdometerKm(position),
            driverName: driver?.driver_name || '',
            lastUpdate: position?.deviceTime || registryVehicle?.lastUpdate || null,
        };

        if (erpMatch) {
            matchedErpIds.add(String(erpMatch._id));
            mergedRows.push(mapErpVehicleToListRow(erpMatch, locatorOverlay));
        } else {
            let locatorRow = null;
            try {
                locatorRow = await resolveLocatorErpListRow({
                    deviceId,
                    deviceName: locatorName,
                    locatorOverlay,
                });
            } catch (error) {
                console.warn(
                    `[LocatorList] Failed to ensure ERP vehicle for device ${deviceId}:`,
                    error?.message,
                );
            }

            if (locatorRow) {
                matchedErpIds.add(String(locatorRow._id));
                mergedRows.push(locatorRow);
            } else {
                mergedRows.push(mapLocatorOnlyRow(deviceId, registryVehicle, position));
            }
        }
    }

    for (const erp of erpVehicles) {
        if (matchedErpIds.has(String(erp._id))) continue;
        mergedRows.push(mapErpVehicleToListRow(erp, null));
    }

    const enrichedRows = mergedRows.map((row) => enrichLocatorListRow(row));

    enrichedRows.sort((a, b) => {
        const aName = String(a.locator?.deviceName || a.name || a.assetId || '');
        const bName = String(b.locator?.deviceName || b.name || b.assetId || '');
        return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
    });

    return {
        configured: true,
        connected: true,
        vehicles: enrichedRows,
        locatorCount: deviceIds.size,
        erpCount: erpVehicles.length,
        generatedAt: new Date().toISOString(),
    };
}

async function loadErpVehicleByLocatorDeviceId(deviceId) {
    const item = await AssetItem.findOne({ locatorDeviceId: Number(deviceId) })
        .populate('typeId', 'name')
        .populate('assignedTo', 'firstName lastName employeeId')
        .populate('assignedCompany', 'name nickName companyShortName companyName')
        .select(ERP_VEHICLE_LIST_SELECT)
        .lean();

    return item || null;
}

function buildLocatorOverlay(deviceId, registryVehicle, position) {
    const attrs = position?.attributes || {};
    const driver = position?.driver || {};
    const locatorName = position?.deviceName || registryVehicle?.name || '';

    return {
        deviceId: Number(deviceId),
        deviceName: locatorName,
        uniqueId: registryVehicle?.uniqueId || '',
        gpsStatus: formatLocatorGpsStatus(position, registryVehicle),
        state: attrs.state || '',
        livestatus: position?.livestatus || registryVehicle?.status || '',
        address: position?.address || '',
        speedKmh: position?.speedKmh ?? null,
        ignition: attrs.ignition === true,
        currentKilometer: toOdometerKm(position),
        driverName: driver?.driver_name || '',
        lastUpdate: position?.deviceTime || registryVehicle?.lastUpdate || null,
    };
}

export async function buildLocatorDeviceContext(deviceId) {
    const id = String(deviceId);
    const stored = await readLocatorTokens();
    let registryVehicles = stored?.vehicles || [];

    if (!registryVehicles.length) {
        try {
            const session = await locatorLogin();
            registryVehicles = session?.vehicles || [];
        } catch {
            // ERP link may still exist even when live login fails.
        }
    }

    const registryMap = buildRegistryMap(registryVehicles);
    let registryVehicle = registryMap.get(id) || null;

    let position = getCachedLocatorPositions().find((row) => String(row.deviceId) === id) || null;

    if (!registryVehicle && !position) {
        try {
            const session = await locatorLogin({ force: true });
            registryVehicles = session?.vehicles || [];
            registryVehicle = buildRegistryMap(registryVehicles).get(id) || null;
        } catch {
            // Fall back to minimal device row below.
        }
    }

    if (!position) {
        try {
            const resolved = await resolveLocatorPositionsForList();
            position = (resolved.positions || []).find((row) => String(row.deviceId) === id) || null;
        } catch {
            // Live position is optional for details view.
        }
    }

    const locatorOverlay = buildLocatorOverlay(deviceId, registryVehicle, position);

    let erpMatch = await loadErpVehicleByLocatorDeviceId(deviceId);
    if (!erpMatch) {
        try {
            await ensureLocatorErpVehicle({
                deviceId: Number(deviceId),
                deviceName: locatorOverlay.deviceName || `Locator ${deviceId}`,
            });
            erpMatch = await loadErpVehicleByLocatorDeviceId(deviceId);
        } catch (error) {
            console.warn(
                `[LocatorContext] Failed to ensure ERP vehicle for device ${deviceId}:`,
                error?.message,
            );
        }
    }

    let row;
    if (erpMatch) {
        row = mapErpVehicleToListRow(erpMatch, locatorOverlay);
    } else if (registryVehicle || position) {
        row = mapLocatorOnlyRow(deviceId, registryVehicle, position);
    } else {
        row = mapLocatorOnlyRow(
            deviceId,
            { id: Number(deviceId), name: `Locator ${deviceId}` },
            null,
        );
        row.locator = locatorOverlay.deviceName
            ? locatorOverlay
            : {
                  ...locatorOverlay,
                  deviceName: row.name || `Locator ${deviceId}`,
              };
    }

    return enrichLocatorListRow(row);
}

export async function buildLocatorVehicleDetail(deviceId) {
    return buildLocatorDeviceContext(deviceId);
}

export async function buildLocatorDeviceOverlay(deviceId) {
    const row = await buildLocatorDeviceContext(deviceId);
    return {
        locator: row.locator,
        locatorOwnerName: row.locatorOwnerName,
        matchedEmployee: row.matchedEmployee,
        matchedEmployees: row.matchedEmployees,
        assignmentMismatch: row.assignmentMismatch,
        locatorListStatus: row.locatorListStatus,
        isLocatorLinked: true,
        currentKilometer: row.locator?.currentKilometer ?? null,
    };
}

export async function ensureLocatorErpVehicle({
    deviceId,
    deviceName,
    plateEmirate,
    plateNumber,
    createdBy,
}) {
    let asset = await findErpVehicleForLocatorLink({
        deviceId,
        deviceName,
        plateNumber,
    });

    if (!asset) {
        return createLocatorErpVehicle({
            deviceId,
            deviceName: deviceName || `Locator ${deviceId || ''}`,
            plateEmirate: plateEmirate || 'Dubai',
            plateNumber: plateNumber || '',
            createdBy,
        });
    }

    let dirty = false;
    if (deviceId != null && Number(asset.locatorDeviceId) !== Number(deviceId)) {
        asset.locatorDeviceId = Number(deviceId);
        dirty = true;
    }

    const locatorLabel = String(deviceName || '').trim();
    if (locatorLabel && (!asset.name || asset.name === asset.assetId)) {
        asset.name = locatorLabel;
        dirty = true;
    }

    const emirate = String(plateEmirate || '').trim();
    const plate = String(plateNumber || '').trim();
    if (plate && plate !== '—' && !String(asset.plateNumber || '').trim()) {
        asset.plateNumber = plate;
        dirty = true;
    }
    if (emirate && !String(asset.plateEmirate || '').trim()) {
        asset.plateEmirate = emirate;
        dirty = true;
    }

    if (dirty) await asset.save();
    return asset;
}

/**
 * For each live Locator position: match/create/patch the ERP vehicle and sync odometer.
 * Used by fleet dashboard (and can be reused by list) so every GPS load keeps DB aligned.
 */
export async function reconcileLocatorPositionsToErp(positions = [], { createdBy } = {}) {
    const summary = {
        processed: 0,
        created: 0,
        linked: 0,
        odometerUpdated: 0,
        failed: 0,
    };

    for (const position of positions || []) {
        const deviceId = position?.deviceId;
        if (deviceId == null || deviceId === '') continue;

        const deviceName = String(position?.deviceName || position?.name || '').trim();

        try {
            const existing = await findErpVehicleForLocatorLink({ deviceId, deviceName });
            const asset = await ensureLocatorErpVehicle({
                deviceId,
                deviceName: deviceName || `Locator ${deviceId}`,
                createdBy,
            });

            summary.processed += 1;
            if (!existing) summary.created += 1;
            else if (Number(existing.locatorDeviceId) !== Number(deviceId)) summary.linked += 1;

            const km = toOdometerKm(position);
            if (km != null && Number.isFinite(km) && km >= 0) {
                const current = Number(asset.currentKilometer);
                if (!Number.isFinite(current) || current !== km) {
                    asset.currentKilometer = km;
                    await asset.save();
                    summary.odometerUpdated += 1;
                }
            }
        } catch (error) {
            summary.failed += 1;
            console.warn(
                `[LocatorReconcile] device ${deviceId}:`,
                error?.message || error,
            );
        }
    }

    return summary;
}
