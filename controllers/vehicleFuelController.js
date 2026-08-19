import VehicleFuelBill from '../models/VehicleFuelBill.js';
import AssetItem from '../models/AssetItem.js';
import Company from '../models/Company.js';
import {
    getLocatorMonthStatsForDevice,
    getLocatorMonthStatsMap,
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
    getFallbackEmailNote,
} from '../utils/resolveEmployeeEmail.js';
import { sendVehicleFuelBillEmail } from '../utils/sendVehicleFuelBillEmail.js';

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthLabelFromKey(monthKey) {
    const [year, month] = String(monthKey || '').split('-').map(Number);
    if (!year || !month) return String(monthKey || '');
    return new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function formatIdleTime(minutes) {
    const n = Number(minutes) || 0;
    if (n <= 0) return '0 min';
    const hours = Math.floor(n / 60);
    const mins = n % 60;
    if (hours <= 0) return `${mins} min`;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
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

function isLimitExceeded(amount, limit) {
    const used = Number(amount);
    const cap = Number(limit);
    return Number.isFinite(used) && Number.isFinite(cap) && cap > 0 && used >= cap;
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
        limitExceeded: isLimitExceeded(amountUsed, monthlyLimit),
        kmRun,
        idleTimeMinutes,
        idleTimeLabel: formatIdleTime(idleTimeMinutes),
        vehicleNumber: plateOf(asset) || asset?.assetId || '—',
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

async function collectFuelEmailTargets(asset) {
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
        const emp =
            typeof assignee === 'object' && assignee.employeeId
                ? assignee
                : null;
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
                    fallbackNoteHtml = getFallbackEmailNote(
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

    const hr = await resolveHrEmployee().catch(() => null);
    add(pickEffectiveEmail(hr));
    if (!greetingName && hr) greetingName = hr.firstName || employeeDisplayName(hr);

    return {
        to: emails[0] || null,
        cc: emails.slice(1),
        greetingName: greetingName || 'there',
        fallbackNoteHtml,
    };
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

async function notifyFuelLimitExceeded(asset, bill) {
    const hr = await resolveHrEmployee().catch(() => null);
    const adminOfficer = await resolveAdminOfficerEmployee().catch(() => null);
    const emails = [];
    const add = (addr) => {
        const mail = String(addr || '').trim();
        if (mail && !emails.some((e) => e.toLowerCase() === mail.toLowerCase())) emails.push(mail);
    };
    add(pickEffectiveEmail(hr));
    add(pickEffectiveEmail(adminOfficer));
    if (!emails.length) return;
    await sendVehicleFuelBillEmail({
        to: emails[0],
        cc: emails.slice(1),
        asset,
        monthLabel: monthLabelFromKey(bill.monthKey),
        amountUsed: bill.amountUsed,
        monthlyLimit: bill.monthlyLimit,
        kmRun: bill.kmRun,
        idleTimeLabel: formatIdleTime(bill.idleTimeMinutes),
        action: 'limitExceeded',
        greetingName: hr?.firstName || adminOfficer?.firstName || 'there',
    });
}

async function notifyFuelBill(asset, bill, action) {
    const targets = await collectFuelEmailTargets(asset);
    if (!targets.to) return;
    await sendVehicleFuelBillEmail({
        to: targets.to,
        cc: targets.cc,
        asset,
        monthLabel: monthLabelFromKey(bill.monthKey),
        amountUsed: bill.amountUsed,
        monthlyLimit: bill.monthlyLimit,
        kmRun: bill.kmRun,
        idleTimeLabel: formatIdleTime(bill.idleTimeMinutes),
        action,
        fallbackNoteHtml: targets.fallbackNoteHtml,
        greetingName: targets.greetingName,
    });
}

export async function requireFlowchartHr(req, res, next) {
    try {
        const ok = await actorIsFlowchartHr(req.user);
        if (!ok) {
            return res.status(403).json({ message: 'Only flowchart HR can manage vehicle fuel bills.' });
        }
        return next();
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to verify HR access.' });
    }
}

export async function listFuelVehicles(req, res) {
    try {
        const vehicles = await AssetItem.find({
            plateNumber: { $exists: true, $nin: [null, ''] },
        })
            .select('assetId name plateEmirate plateNumber assignedTo assignedToType assignedCompany status fuelMonthlyLimit')
            .populate('assignedTo', 'firstName lastName employeeId')
            .populate('assignedCompany', 'name nickName')
            .sort({ plateNumber: 1 })
            .lean();

        return res.json({
            data: vehicles.map((v) => ({
                _id: v._id,
                assetId: v.assetId,
                name: v.name,
                plate: plateOf(v) || v.assetId,
                owner: ownerOf(v),
                fuelMonthlyLimit: Number(v.fuelMonthlyLimit) || 0,
            })),
            canManage: await actorIsFlowchartHr(req.user),
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to load vehicles.' });
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
            canManage: await actorIsFlowchartHr(req.user),
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
            canManage: await actorIsFlowchartHr(req.user),
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

        const fromBody = parseAmount(req.body?.monthlyLimit);
        const monthlyLimit =
            fromBody != null && fromBody > 0 ? fromBody : parseAmount(asset.fuelMonthlyLimit);
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
        if (isLimitExceeded(lean.amountUsed, lean.monthlyLimit)) {
            notifyFuelLimitExceeded(asset, lean).catch((err) => {
                console.error('[VehicleFuel] limit email failed:', err?.message || err);
            });
        }

        return res.status(201).json({
            message: `Fuel created for ${monthLabelFromKey(monthKey)}.`,
            data: serializeBill(lean, asset),
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

        const stats = await locatorStatsForVehicle(asset, bill.monthKey);
        const attachment = parseAttachment(req.body?.attachment);

        const previousAttachment = [...(bill.entries || [])].reverse().find((row) => row.attachment?.data)?.attachment || null;
        bill.amountUsed = amount;
        bill.kmRun = stats.kmRun;
        bill.idleTimeMinutes = stats.idleTimeMinutes;
        bill.updatedBy = req.user?._id || null;
        bill.entries = [
            {
                amount,
                attachment: attachment || previousAttachment,
                createdBy: req.user?._id || null,
                createdAt: new Date(),
            },
        ];

        await bill.save();
        const lean = bill.toObject();
        notifyFuelBill(asset, lean, 'added').catch((err) => {
            console.error('[VehicleFuel] edit email failed:', err?.message || err);
        });
        if (isLimitExceeded(lean.amountUsed, lean.monthlyLimit)) {
            notifyFuelLimitExceeded(asset, lean).catch((err) => {
                console.error('[VehicleFuel] limit email failed:', err?.message || err);
            });
        }

        return res.json({
            message: 'Fuel bill updated.',
            data: serializeBill(lean, asset),
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
            data: serializeBill(lean, asset),
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to close fuel bill.' });
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
