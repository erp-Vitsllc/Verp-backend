import mongoose from 'mongoose';
import VehicleFuelBill from '../models/VehicleFuelBill.js';
import AssetItem from '../models/AssetItem.js';
import AssetType from '../models/AssetType.js';
import Company from '../models/Company.js';
import { buildFleetVehicleMongoScope } from '../utils/fleetVehicleAssetId.js';
import { isFleetVehicleAsset } from '../utils/assetApprovalHelpers.js';
import {
    getLocatorMonthStatsForDevice,
    getLocatorMonthStatsMap,
    getLocatorMonthStatsByDevices,
    formatLocatorIdleLabel,
} from '../services/locatorSnapshotService.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import {
    employeeHasActivePortalUser,
    resolveAdminOfficerEmployee,
    resolveHrEmployee,
} from '../utils/vehicleHandoverApprovalFlow.js';
import {
    pickEffectiveEmail,
    resolveEmployeeEmailWithReporteeLoaded,
    employeeDisplayName,
} from '../utils/resolveEmployeeEmail.js';
import { sendVehicleFuelBillEmail } from '../utils/sendVehicleFuelBillEmail.js';
import { getUserPermissions, isUserAdministrator } from '../services/permissionService.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';
import { isReqUserAdmin } from '../utils/sendAdminDeletionNotificationEmails.js';
import { awaitAdminDeletionArchive } from '../utils/adminDeletionArchiveRun.js';

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ADD_FUEL_PERMISSION = 'hrm_asset_vehicle_add_fuel';
const ADD_FUEL_FLAGS = ['isView', 'isActive', 'isCreate', 'isEdit', 'isDelete', 'isDownload'];

function currentMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabelFromKey(monthKey) {
    const [year, month] = String(monthKey || '').split('-').map(Number);
    if (!year || !month) return String(monthKey || '');
    return new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function formatIdleTime(minutes) {
    return formatLocatorIdleLabel(minutes, { fromMinutes: true });
}

function formatIdleTimeHoursMinutes(minutes, seconds) {
    if (seconds != null && Number.isFinite(Number(seconds))) {
        return formatLocatorIdleLabel(Number(seconds) * 1000);
    }
    return formatLocatorIdleLabel(minutes, { fromMinutes: true });
}

function lastFuelUpdateAtFromBill(bill) {
    const dates = (bill?.entries || [])
        .map((entry) => (entry?.createdAt ? new Date(entry.createdAt) : null))
        .filter((d) => d && !Number.isNaN(d.getTime()));
    if (dates.length) return new Date(Math.max(...dates.map((d) => d.getTime())));
    if (bill?.updatedAt) return new Date(bill.updatedAt);
    if (bill?.createdAt) return new Date(bill.createdAt);
    return null;
}

function plateOf(asset) {
    return [asset?.plateEmirate, asset?.plateNumber].filter(Boolean).join(' ').trim();
}

function ownerOf(asset) {
    if (asset?.assignedToType === 'Company' && asset?.assignedCompany) {
        const company = asset.assignedCompany;
        return company?.name || company?.nickName || 'Company';
    }
    const emp = asset?.assignedTo;
    if (emp && typeof emp === 'object') {
        const name = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
        return name || emp.employeeId || 'Assigned';
    }
    return 'Unassigned';
}

async function locatorStatsForVehicle(asset, monthKey) {
    return getLocatorMonthStatsForDevice(asset?.locatorDeviceId, monthKey);
}

async function loadFleetVehicle(vehicleId) {
    return AssetItem.findById(vehicleId)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail primaryReportee status profileStatus enablePortalAccess',
            populate: {
                path: 'primaryReportee',
                select: 'firstName lastName employeeId companyEmail workEmail status profileStatus',
            },
        })
        .populate('assignedCompany', 'name nickName email')
        .populate('typeId', 'name')
        .lean();
}

function draftVisibilityQuery(reqUser) {
    const uid = reqUser?._id || reqUser?.id;
    if (uid && mongoose.Types.ObjectId.isValid(String(uid))) {
        return {
            $or: [{ status: { $ne: 'Draft' } }, { createdBy: new mongoose.Types.ObjectId(String(uid)) }],
        };
    }
    return { status: { $ne: 'Draft' } };
}

const FUEL_FLEET_SELECT =
    'assetId name vehicleBrand vehicleCode plateEmirate plateNumber assignedTo assignedToType assignedCompany status fuelMonthlyLimit locatorDeviceId vehicleProfileActivationStatus vehicleInspectionStatus vehicleDispositionStatus documents.type documents.description';

async function loadFuelFleetVehicles(req) {
    const vehicleTypeDocs = await AssetType.find({
        isActive: true,
        name: { $regex: /vehicle|car|fleet|truck/i },
    })
        .select('_id')
        .lean();
    const vehicleTypeIds = vehicleTypeDocs.map((t) => t._id);
    const items = await AssetItem.find({
        $and: [draftVisibilityQuery(req.user), buildFleetVehicleMongoScope({ vehicleTypeIds })],
    })
        .select(FUEL_FLEET_SELECT)
        .populate('assignedTo', 'firstName lastName employeeId')
        .populate('assignedCompany', 'name nickName')
        .populate('typeId', 'name')
        .sort({ plateNumber: 1, assetId: 1 })
        .lean();
    return items.filter(isFleetVehicleAsset);
}

function fuelUsageRatio(amount, limit) {
    const used = Number(amount);
    const cap = Number(limit);
    if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return 0;
    return used / cap;
}

function isLimitWarning80(amount, limit) {
    return fuelUsageRatio(amount, limit) >= 0.8;
}

function isLimitExceeded(amount, limit) {
    return fuelUsageRatio(amount, limit) >= 1;
}

function serializeBill(bill, asset, gpsStats = null) {
    const amountUsed = Number(bill.amountUsed) || 0;
    const monthlyLimit = Number(bill.monthlyLimit) || 0;
    const kmRun = gpsStats?.kmRun != null ? Number(gpsStats.kmRun) || 0 : Number(bill.kmRun) || 0;
    const idleTimeMinutes =
        gpsStats?.idleTimeMinutes != null
            ? Number(gpsStats.idleTimeMinutes) || 0
            : Number(bill.idleTimeMinutes) || 0;
    const entries = (bill.entries || []).map((entry) => ({
        _id: entry._id,
        amount: entry.amount,
        createdAt: entry.createdAt,
        hasAttachment: Boolean(entry.attachment?.data || entry.attachment?.name),
        attachmentName: entry.attachment?.name || '',
        attachmentMime: entry.attachment?.mimeType || '',
    }));
    return {
        _id: bill._id,
        vehicleId: bill.vehicleId?._id || bill.vehicleId,
        monthKey: bill.monthKey,
        monthLabel: monthLabelFromKey(bill.monthKey),
        status: bill.status,
        amountUsed,
        monthlyLimit,
        limitPercent: Math.round(fuelUsageRatio(amountUsed, monthlyLimit) * 100),
        limitWarning80: isLimitWarning80(amountUsed, monthlyLimit) && !isLimitExceeded(amountUsed, monthlyLimit),
        limitExceeded: isLimitExceeded(amountUsed, monthlyLimit),
        kmRun,
        idleTimeMinutes,
        idleTimeLabel: gpsStats?.idleTimeLabel || formatIdleTimeHoursMinutes(idleTimeMinutes, gpsStats?.idleTimeSeconds),
        coverageStart: gpsStats?.rangeStart || gpsStats?.coverageStart || null,
        coverageEnd: gpsStats?.rangeEnd || gpsStats?.coverageEnd || null,
        rangeStart: gpsStats?.rangeStart || null,
        rangeEnd: gpsStats?.rangeEnd || null,
        vehicleNumber: plateOf(asset) || asset?.assetId || '—',
        vehicleName: asset?.name || '—',
        vehicleAssetNo: asset?.assetId || '—',
        plateNo: plateOf(asset) || '—',
        vehicleOwner: ownerOf(asset),
        closedAt: bill.closedAt || null,
        entries,
        createdAt: bill.createdAt,
        updatedAt: bill.updatedAt,
    };
}

function parseAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Number(n.toFixed(2));
}

function petrolCardMonthlyLimit(asset) {
    const docs = Array.isArray(asset?.documents) ? asset.documents : [];
    const petrol = docs.find((d) => String(d.type || '').toLowerCase() === 'petrol');
    if (!petrol?.description) return null;
    try {
        const parsed = JSON.parse(petrol.description);
        const n = parseAmount(parsed?.limit);
        if (n != null && n > 0) return n;
        const cleaned = Number(String(parsed?.limit ?? '').replace(/[^\d.]/g, ''));
        return Number.isFinite(cleaned) && cleaned > 0 ? Number(cleaned.toFixed(2)) : null;
    } catch {
        return null;
    }
}

/** Prefer Basic Details, then petrol-card monthly limit. Treat 0 as unset. */
function resolveVehicleMonthlyLimit(asset, fromBody = null) {
    if (fromBody != null && fromBody > 0) return fromBody;
    const fromAsset = parseAmount(asset?.fuelMonthlyLimit);
    if (fromAsset != null && fromAsset > 0) return fromAsset;
    return petrolCardMonthlyLimit(asset);
}

function serializeFuelVehicle(v) {
    return {
        _id: v._id,
        assetId: v.assetId,
        name: v.name,
        plate: plateOf(v) || v.assetId,
        owner: ownerOf(v),
        fuelMonthlyLimit: resolveVehicleMonthlyLimit(v) || 0,
    };
}

function parseAttachment(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const data = String(raw.data || '').trim();
    if (!data) return null;
    return {
        name: String(raw.name || 'fuel-bill').trim() || 'fuel-bill',
        mimeType: String(raw.mimeType || 'application/pdf').trim() || 'application/pdf',
        data,
    };
}

function noUserAccountFallbackNote(employeeName, reporteeName) {
    return `
    <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 12px; border-radius: 6px; margin-bottom: 20px; font-size: 13px;">
        <strong>Note:</strong> This notification was sent to you (${reporteeName}) because <strong>${employeeName}</strong> does not have a user account. Please ensure they are informed.
    </div>`;
}

async function collectAssigneeAndAdminFuelEmails(asset, { includeHr = false } = {}) {
    const emails = [];
    const seen = new Set();
    let greetingName = '';
    let fallbackNoteHtml = '';

    const add = (addr) => {
        const mail = String(addr || '').trim();
        if (!mail) return;
        const key = mail.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        emails.push(mail);
    };

    if (asset?.assignedToType === 'Company' && asset?.assignedCompany) {
        const company =
            typeof asset.assignedCompany === 'object'
                ? asset.assignedCompany
                : await Company.findById(asset.assignedCompany).select('name email').lean();
        add(company?.email);
        if (!greetingName) greetingName = company?.name || 'there';
    }

    const assignee = asset?.assignedTo;
    if (assignee) {
        const emp = typeof assignee === 'object' && assignee.employeeId ? assignee : null;
        if (emp) {
            const hasUser = await employeeHasActivePortalUser(emp);
            if (hasUser) {
                const { email, employee } = await resolveEmployeeEmailWithReporteeLoaded(emp);
                add(email);
                if (!greetingName) greetingName = employeeDisplayName(employee || emp);
            } else {
                const { employee } = await resolveEmployeeEmailWithReporteeLoaded(emp);
                const reportee = employee?.primaryReportee;
                const reporteeEmail = pickEffectiveEmail(reportee);
                add(reporteeEmail);
                if (reportee) {
                    fallbackNoteHtml = noUserAccountFallbackNote(
                        employeeDisplayName(employee || emp),
                        employeeDisplayName(reportee),
                    );
                    if (!greetingName) greetingName = reportee.firstName || employeeDisplayName(reportee);
                }
            }
        }
    }

    const adminOfficer = await resolveAdminOfficerEmployee().catch(() => null);
    add(pickEffectiveEmail(adminOfficer));
    if (!greetingName && adminOfficer) {
        greetingName = adminOfficer.firstName || employeeDisplayName(adminOfficer);
    }

    if (includeHr) {
        const hr = await resolveHrEmployee().catch(() => null);
        add(pickEffectiveEmail(hr));
        if (!greetingName && hr) greetingName = hr.firstName || employeeDisplayName(hr);
    }

    return {
        to: emails[0] || null,
        cc: emails.slice(1),
        greetingName: greetingName || 'there',
        fallbackNoteHtml,
    };
}

async function collectFuelEmailTargets(asset) {
    return collectAssigneeAndAdminFuelEmails(asset, { includeHr: true });
}

async function collectFuelLimitEmailTargets(asset) {
    return collectAssigneeAndAdminFuelEmails(asset, { includeHr: false });
}

async function actorIsFlowchartHr(user) {
    if (!user) return false;
    if (await isUserInFlowchart(user, 'hr')) return true;
    const hod = await getDepartmentHOD('hr');
    if (!hod) return false;
    if (hod._id && user.employeeObjectId && String(hod._id) === String(user.employeeObjectId)) return true;
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
    if (hod.employeeId && user.employeeId && norm(hod.employeeId) === norm(user.employeeId)) return true;
    return false;
}

async function actorHasAddFuelPermission(user) {
    const uid = user?.id || user?._id;
    if (!uid) return false;
    if (await isUserAdministrator(uid)) return true;
    const packed = await getUserPermissions(uid);
    if (packed?.isAdministrator) return true;
    const row = packed?.permissions?.[ADD_FUEL_PERMISSION];
    if (!row) return false;
    return ADD_FUEL_FLAGS.some((flag) => row[flag] === true);
}

async function actorCanManageFuel(user) {
    if (!user) return false;
    if (isJwtSystemSuperUser(user)) return true;
    if (user.isAdministrator || user.role === 'admin') return true;
    if (await actorHasAddFuelPermission(user)) return true;
    return actorIsFlowchartHr(user);
}

async function actorCanDeleteFuel(user) {
    if (!user) return false;
    if (isJwtSystemSuperUser(user)) return true;
    return isReqUserAdmin(user);
}

/** Portal Super User only — monthly limit is otherwise locked after create. */
async function actorCanEditFuelMonthlyLimit(user) {
    return actorCanDeleteFuel(user);
}

async function notifyFuelLimitThreshold(asset, bill, action) {
    const targets = await collectFuelLimitEmailTargets(asset);
    if (!targets.to) return;
    const stats = await locatorStatsForVehicle(asset, bill.monthKey);
    await sendVehicleFuelBillEmail({
        to: targets.to,
        cc: targets.cc,
        asset,
        monthLabel: monthLabelFromKey(bill.monthKey),
        amountUsed: bill.amountUsed,
        monthlyLimit: bill.monthlyLimit,
        kmRun: stats.kmRun,
        idleTimeLabel: formatIdleTimeHoursMinutes(stats.idleTimeMinutes, stats.idleTimeSeconds),
        lastFuelUpdateAt: lastFuelUpdateAtFromBill(bill),
        action,
        fallbackNoteHtml: targets.fallbackNoteHtml,
        greetingName: targets.greetingName,
    });
}

async function maybeNotifyFuelLimitThresholds(asset, bill) {
    const ratio = fuelUsageRatio(bill.amountUsed, bill.monthlyLimit);
    if (ratio < 0.8) return;

    const sent80 = Boolean(bill.limitAlert80SentAt);
    const sent100 = Boolean(bill.limitAlert100SentAt);
    const reached100 = ratio >= 1;
    const need100 = reached100 && !sent100;
    const need80 = ratio >= 0.8 && !sent80 && !reached100;

    if (!need80 && !need100) return;

    await notifyFuelLimitThreshold(asset, bill, need100 ? 'limitExceeded' : 'limitWarning80');

    const patch = {};
    if (need80 || need100) patch.limitAlert80SentAt = new Date();
    if (need100) patch.limitAlert100SentAt = new Date();
    if (Object.keys(patch).length) {
        await VehicleFuelBill.updateOne({ _id: bill._id }, { $set: patch });
    }
}

async function notifyFuelBill(asset, bill, action) {
    const targets =
        action === 'added'
            ? await collectAssigneeAndAdminFuelEmails(asset, { includeHr: false })
            : await collectFuelEmailTargets(asset);
    if (!targets.to) return;
    const stats =
        action === 'closed' ? await locatorStatsForVehicle(asset, bill.monthKey) : null;
    await sendVehicleFuelBillEmail({
        to: targets.to,
        cc: targets.cc,
        asset,
        monthLabel: monthLabelFromKey(bill.monthKey),
        amountUsed: bill.amountUsed,
        monthlyLimit: bill.monthlyLimit,
        kmRun: stats?.kmRun ?? bill.kmRun,
        idleTimeLabel:
            action === 'closed'
                ? formatIdleTimeHoursMinutes(stats?.idleTimeMinutes ?? bill.idleTimeMinutes, stats?.idleTimeSeconds)
                : formatIdleTime(bill.idleTimeMinutes),
        lastFuelUpdateAt: lastFuelUpdateAtFromBill(bill),
        action,
        fallbackNoteHtml: targets.fallbackNoteHtml,
        greetingName: targets.greetingName,
    });
}

export async function requireCanManageFuel(req, res, next) {
    try {
        const ok = await actorCanManageFuel(req.user);
        if (!ok) {
            return res.status(403).json({ message: 'You do not have permission to manage vehicle fuel bills.' });
        }
        return next();
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to verify fuel access.' });
    }
}

export async function listFuelVehicles(req, res) {
    try {
        const vehicles = await loadFuelFleetVehicles(req);
        return res.json({
            data: vehicles.map(serializeFuelVehicle),
            canManage: await actorCanManageFuel(req.user),
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to load vehicles.' });
    }
}

export async function listAccessFuel(req, res) {
    try {
        const monthKey = MONTH_KEY_RE.test(String(req.query.monthKey || '').trim())
            ? String(req.query.monthKey).trim()
            : currentMonthKey();

        const vehicles = await loadFuelFleetVehicles(req);

        const bills = await VehicleFuelBill.find({ monthKey }).lean();
        const billsByVehicle = new Map(bills.map((bill) => [String(bill.vehicleId), bill]));

        const added = [];
        const notAdded = [];
        let totalAmount = 0;
        let exceedCount = 0;

        const gpsByDevice = await getLocatorMonthStatsByDevices(
            vehicles.map((vehicle) => vehicle.locatorDeviceId),
            monthKey,
        );

        for (const vehicle of vehicles) {
            const bill = billsByVehicle.get(String(vehicle._id));
            const gpsStats = gpsByDevice[String(vehicle.locatorDeviceId || '')] || {
                kmRun: 0,
                idleTimeMinutes: 0,
            };
            if (bill) {
                const row = serializeBill(bill, vehicle, gpsStats);
                added.push(row);
                totalAmount += Number(row.amountUsed) || 0;
                if (row.limitExceeded) exceedCount += 1;
                continue;
            }
            notAdded.push({
                _id: `missing-${vehicle._id}`,
                vehicleId: vehicle._id,
                noFuel: true,
                monthKey,
                monthLabel: monthLabelFromKey(monthKey),
                vehicleName: vehicle.name || '—',
                vehicleAssetNo: vehicle.assetId || '—',
                plateNo: plateOf(vehicle) || '—',
                vehicleNumber: plateOf(vehicle) || vehicle.assetId || '—',
                vehicleOwner: ownerOf(vehicle),
                monthlyLimit: resolveVehicleMonthlyLimit(vehicle) || 0,
                amountUsed: null,
                kmRun: gpsStats.kmRun,
                idleTimeMinutes: gpsStats.idleTimeMinutes,
                idleTimeLabel: gpsStats.idleTimeLabel || formatIdleTimeHoursMinutes(gpsStats.idleTimeMinutes, gpsStats.idleTimeSeconds),
                coverageStart: gpsStats.rangeStart || gpsStats.coverageStart || null,
                coverageEnd: gpsStats.rangeEnd || gpsStats.coverageEnd || null,
                rangeStart: gpsStats.rangeStart || null,
                rangeEnd: gpsStats.rangeEnd || null,
                status: '',
                limitExceeded: false,
                limitWarning80: false,
                entries: [],
            });
        }

        return res.json({
            monthKey,
            monthLabel: monthLabelFromKey(monthKey),
            vehicles: vehicles.map(serializeFuelVehicle),
            added,
            notAdded,
            summary: {
                addedCount: added.length,
                notAddedCount: notAdded.length,
                totalAmount,
                exceedCount,
            },
            canManage: await actorCanManageFuel(req.user),
            canDelete: await actorCanDeleteFuel(req.user),
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to load access fuel.' });
    }
}

export async function listVehicleFuelBills(req, res) {
    try {
        const vehicleId = String(req.params.vehicleId || '').trim();
        if (!vehicleId) return res.status(400).json({ message: 'Vehicle is required.' });

        const asset = await loadFleetVehicle(vehicleId);
        if (!asset) return res.status(404).json({ message: 'Vehicle not found.' });

        const bills = await VehicleFuelBill.find({ vehicleId })
            .sort({ monthKey: -1, createdAt: -1 })
            .lean();

        const gpsByMonth = await getLocatorMonthStatsMap(
            asset?.locatorDeviceId,
            bills.map((bill) => bill.monthKey),
        );
        const rows = bills.map((bill) => serializeBill(bill, asset, gpsByMonth[bill.monthKey]));
        const totalAmount = rows.reduce((sum, row) => sum + (Number(row.amountUsed) || 0), 0);

        return res.json({
            data: rows,
            totalAmount,
            canManage: await actorCanManageFuel(req.user),
            canDelete: await actorCanDeleteFuel(req.user),
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to load fuel bills.' });
    }
}

export async function lookupVehicleFuel(req, res) {
    try {
        const vehicleId = String(req.query.vehicleId || '').trim();
        const monthKey = String(req.query.monthKey || '').trim();
        if (!vehicleId || !MONTH_KEY_RE.test(monthKey)) {
            return res.json({ data: null });
        }
        const asset = await loadFleetVehicle(vehicleId);
        if (!asset) return res.status(404).json({ message: 'Vehicle not found.' });
        const bill = await VehicleFuelBill.findOne({ vehicleId, monthKey }).lean();
        const gpsStats = await locatorStatsForVehicle(asset, monthKey);
        return res.json({
            data: bill ? serializeBill(bill, asset, gpsStats) : null,
            gps: {
                kmRun: Number(gpsStats?.kmRun) || 0,
                idleTimeMinutes: Number(gpsStats?.idleTimeMinutes) || 0,
                idleTimeLabel:
                    gpsStats?.idleTimeLabel ||
                    formatIdleTimeHoursMinutes(gpsStats?.idleTimeMinutes, gpsStats?.idleTimeSeconds),
                coverageStart: gpsStats?.rangeStart || gpsStats?.coverageStart || null,
                coverageEnd: gpsStats?.rangeEnd || gpsStats?.coverageEnd || null,
                rangeStart: gpsStats?.rangeStart || null,
                rangeEnd: gpsStats?.rangeEnd || null,
            },
            canManage: await actorCanManageFuel(req.user),
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to look up fuel bill.' });
    }
}

export async function addVehicleFuel(req, res) {
    try {
        const vehicleId = String(req.body?.vehicleId || '').trim();
        const monthKey = String(req.body?.monthKey || '').trim();
        const amount = parseAmount(req.body?.amount);
        const attachment = parseAttachment(req.body?.attachment);

        if (!vehicleId) return res.status(400).json({ message: 'Select a vehicle.' });
        if (!MONTH_KEY_RE.test(monthKey)) return res.status(400).json({ message: 'Select a valid month.' });
        if (amount == null || amount <= 0) return res.status(400).json({ message: 'Enter a valid amount.' });

        const asset = await loadFleetVehicle(vehicleId);
        if (!asset) return res.status(404).json({ message: 'Vehicle not found.' });

        const monthlyLimit = resolveVehicleMonthlyLimit(asset, parseAmount(req.body?.monthlyLimit));
        if (monthlyLimit == null || monthlyLimit <= 0) {
            return res.status(400).json({
                message: 'Set a monthly limit on the vehicle first, or enter one here.',
            });
        }

        const existing = await VehicleFuelBill.findOne({ vehicleId, monthKey }).select('_id status').lean();
        if (existing) {
            return res.status(400).json({
                message:
                    existing.status === 'closed'
                        ? 'This month’s fuel bill is closed. Fuel cannot be added again for the selected month.'
                        : 'Fuel is already added for this vehicle and month. Use Update instead.',
            });
        }

        const stats = await locatorStatsForVehicle(asset, monthKey);
        const bill = await VehicleFuelBill.create({
            vehicleId,
            monthKey,
            status: 'open',
            amountUsed: amount,
            monthlyLimit,
            kmRun: stats.kmRun,
            idleTimeMinutes: stats.idleTimeMinutes,
            entries: [
                {
                    amount,
                    attachment,
                    createdBy: req.user?._id || null,
                    createdAt: new Date(),
                },
            ],
            createdBy: req.user?._id || null,
            updatedBy: req.user?._id || null,
        });

        const lean = bill.toObject();
        notifyFuelBill(asset, lean, 'added').catch((err) => {
            console.error('[VehicleFuel] add email failed:', err?.message || err);
        });
        maybeNotifyFuelLimitThresholds(asset, lean).catch((err) => {
            console.error('[VehicleFuel] limit email failed:', err?.message || err);
        });

        return res.status(201).json({
            message: `Fuel created for ${monthLabelFromKey(monthKey)}.`,
            data: serializeBill(lean, asset, stats),
        });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(400).json({ message: 'Fuel is already added for this vehicle and month. Use Update instead.' });
        }
        return res.status(500).json({ message: error.message || 'Failed to save fuel.' });
    }
}

export async function updateVehicleFuel(req, res) {
    try {
        const bill = await VehicleFuelBill.findById(req.params.id);
        if (!bill) return res.status(404).json({ message: 'Fuel bill not found.' });

        const amount = parseAmount(req.body?.amount);
        if (amount == null || amount <= 0) return res.status(400).json({ message: 'Enter a valid amount.' });

        const asset = await loadFleetVehicle(bill.vehicleId);
        if (!asset) return res.status(404).json({ message: 'Vehicle not found.' });

        const canEditMonthlyLimit = await actorCanEditFuelMonthlyLimit(req.user);
        const requestedLimit = parseAmount(req.body?.monthlyLimit);
        if (canEditMonthlyLimit && req.body?.monthlyLimit != null && req.body?.monthlyLimit !== '') {
            if (requestedLimit == null || requestedLimit <= 0) {
                return res.status(400).json({ message: 'Enter a valid monthly limit.' });
            }
            bill.monthlyLimit = requestedLimit;
        }

        const stats = await locatorStatsForVehicle(asset, bill.monthKey);
        const attachment = parseAttachment(req.body?.attachment);

        bill.amountUsed = amount;
        bill.kmRun = stats.kmRun;
        bill.idleTimeMinutes = stats.idleTimeMinutes;
        bill.updatedBy = req.user?._id || null;
        bill.entries.push({
            amount,
            attachment: attachment || null,
            createdBy: req.user?._id || null,
            createdAt: new Date(),
        });

        await bill.save();
        const lean = bill.toObject();
        maybeNotifyFuelLimitThresholds(asset, lean).catch((err) => {
            console.error('[VehicleFuel] limit email failed:', err?.message || err);
        });

        return res.json({
            message: 'Fuel bill updated.',
            data: serializeBill(lean, asset, stats),
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to update fuel.' });
    }
}

export async function closeVehicleFuel(req, res) {
    try {
        let bill = null;
        if (req.params.id) {
            bill = await VehicleFuelBill.findById(req.params.id);
        } else {
            const vehicleId = String(req.body?.vehicleId || '').trim();
            const monthKey = String(req.body?.monthKey || '').trim();
            if (!vehicleId || !MONTH_KEY_RE.test(monthKey)) {
                return res.status(400).json({ message: 'Select a vehicle and month to close.' });
            }
            bill = await VehicleFuelBill.findOne({ vehicleId, monthKey });
        }
        if (!bill) return res.status(404).json({ message: 'Fuel bill not found for the selected month.' });
        if (bill.status === 'closed') {
            return res.status(400).json({ message: 'This month’s fuel bill is already closed.' });
        }

        const asset = await loadFleetVehicle(bill.vehicleId);
        if (!asset) return res.status(404).json({ message: 'Vehicle not found.' });

        const stats = await locatorStatsForVehicle(asset, bill.monthKey);
        bill.status = 'closed';
        bill.closedAt = new Date();
        bill.closedBy = req.user?._id || null;
        bill.kmRun = stats.kmRun;
        bill.idleTimeMinutes = stats.idleTimeMinutes;
        bill.updatedBy = req.user?._id || null;
        await bill.save();

        const lean = bill.toObject();
        notifyFuelBill(asset, lean, 'closed').catch((err) => {
            console.error('[VehicleFuel] close email failed:', err?.message || err);
        });

        return res.json({
            message: `Fuel bill closed for ${monthLabelFromKey(bill.monthKey)}.`,
            data: serializeBill(lean, asset, stats),
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to close fuel bill.' });
    }
}

export async function deleteVehicleFuel(req, res) {
    try {
        const allowed = await actorCanDeleteFuel(req.user);
        if (!allowed) {
            return res.status(403).json({ message: 'Delete allowed only for Super User (Admin).' });
        }

        const bill = await VehicleFuelBill.findById(req.params.id);
        if (!bill) return res.status(404).json({ message: 'Fuel bill not found.' });

        const asset = await loadFleetVehicle(bill.vehicleId);
        const snapshot = typeof bill.toObject === 'function' ? bill.toObject() : { ...bill };
        const plate = plateOf(asset) || asset?.assetId || '—';
        const monthLabel = monthLabelFromKey(bill.monthKey);
        const amountLabel = `AED ${Number(bill.amountUsed || 0).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })}`;

        await awaitAdminDeletionArchive(req, {
            moduleName: 'Vehicle Fuel',
            recordId: String(bill._id),
            details: `${plate} — ${monthLabel} (${amountLabel})`,
            deletedPayload: {
                ...snapshot,
                vehicleNumber: plate,
                vehicleName: asset?.name || '',
                vehicleAssetNo: asset?.assetId || '',
                monthLabel,
                name: `${plate} ${monthLabel}`.trim(),
            },
        });

        await VehicleFuelBill.deleteOne({ _id: bill._id });
        return res.json({ message: `Fuel bill deleted for ${monthLabel}. Management has been notified.` });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to delete fuel bill.' });
    }
}

export async function getVehicleFuelAttachment(req, res) {
    try {
        const bill = await VehicleFuelBill.findById(req.params.id).select('entries').lean();
        if (!bill) return res.status(404).json({ message: 'Fuel bill not found.' });

        const entryId = String(req.query.entryId || '').trim();
        const entry = entryId
            ? (bill.entries || []).find((row) => String(row._id) === entryId)
            : [...(bill.entries || [])].reverse().find((row) => row.attachment?.data);

        if (!entry?.attachment?.data) {
            return res.status(404).json({ message: 'No attachment on this fuel bill.' });
        }

        return res.json({
            data: {
                name: entry.attachment.name || 'Fuel attachment',
                mimeType: entry.attachment.mimeType || 'application/pdf',
                data: entry.attachment.data,
            },
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to load attachment.' });
    }
}
