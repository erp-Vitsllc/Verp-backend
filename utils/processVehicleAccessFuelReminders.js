import nodemailer from 'nodemailer';
import AssetItem from '../models/AssetItem.js';
import AssetType from '../models/AssetType.js';
import DashboardAction from '../models/DashboardAction.js';
import VehicleAccessFuelReminderLog from '../models/VehicleAccessFuelReminderLog.js';
import VehicleFuelBill from '../models/VehicleFuelBill.js';
import { isFleetVehicleAsset } from './assetApprovalHelpers.js';
import { buildFleetVehicleMongoScope } from './fleetVehicleAssetId.js';
import { pickEffectiveEmail } from './resolveEmployeeEmail.js';
import { withFrontendPath } from './resolveFrontendBaseUrl.js';
import {
    getCalendarPartsInTz,
    getScheduledEmailTimeZone,
} from './scheduleDailyAtMidnight.js';
import { resolveAdminOfficerEmployee } from './vehicleHandoverApprovalFlow.js';

export const ACCESS_FUEL_REMINDER_REQUEST_TYPE = 'Vehicle Access Fuel Reminder';
export const ACCESS_FUEL_PANEL_PATH = '/HRM/Asset/Vehicle?access=fuel';

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

export function accessFuelMonthLabel(monthKey, style = 'long') {
    const match = String(monthKey || '').match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (!match) return String(monthKey || '');
    const monthIndex = Number(match[2]) - 1;
    if (style === 'short') return MONTH_SHORT[monthIndex];
    return `${MONTH_LONG[monthIndex]} ${match[1]}`;
}

export function accessFuelMonthKeyFromDate(now = new Date(), timeZone = getScheduledEmailTimeZone()) {
    const { year, month } = getCalendarPartsInTz(now, timeZone);
    return `${year}-${String(month).padStart(2, '0')}`;
}

export function accessFuelEmailSubject(monthKey) {
    return `${accessFuelMonthLabel(monthKey, 'short')} vehicle fuel add`;
}

export function accessFuelInboxMessage(count, monthKey) {
    const n = Math.max(0, Number(count) || 0);
    const month = accessFuelMonthLabel(monthKey, 'long');
    const vehicleWord = n === 1 ? 'vehicle has' : 'vehicles have';
    return `${n} ${vehicleWord} to add ${month} bill to be added`;
}

export function isAssignedVehicleForAccessFuel(vehicle) {
    return String(vehicle?.status || '').trim().toLowerCase() === 'assigned';
}

async function loadAssignedFleetVehicles() {
    const vehicleTypeDocs = await AssetType.find({
        isActive: true,
        name: { $regex: /vehicle|car|fleet|truck/i },
    })
        .select('_id')
        .lean();
    const vehicleTypeIds = vehicleTypeDocs.map((row) => row._id);
    const items = await AssetItem.find({
        status: 'Assigned',
        $and: [buildFleetVehicleMongoScope({ vehicleTypeIds })],
    })
        .select(
            '_id assetId name plateNumber plateEmirate vehicleBrand vehicleCode typeId status locatorDeviceId',
        )
        .populate('typeId', 'name')
        .lean();
    return items.filter(isFleetVehicleAsset);
}

export async function listAssignedVehiclesMissingFuel(monthKey) {
    const vehicles = await loadAssignedFleetVehicles();
    if (!vehicles.length) return [];
    const ids = vehicles.map((row) => row._id);
    const bills = await VehicleFuelBill.find({
        monthKey,
        vehicleId: { $in: ids },
    })
        .select('vehicleId')
        .lean();
    const added = new Set(bills.map((row) => String(row.vehicleId)));
    return vehicles.filter((row) => !added.has(String(row._id)));
}

function reminderMeta(monthKey, missingCount) {
    return JSON.stringify({
        monthKey,
        missingCount,
        detailsPath: ACCESS_FUEL_PANEL_PATH,
        accessFuelReminder: true,
    });
}

async function closePendingReminders(filter, comment) {
    await DashboardAction.updateMany(
        {
            requestType: ACCESS_FUEL_REMINDER_REQUEST_TYPE,
            status: 'Pending',
            ...filter,
        },
        {
            $set: {
                status: 'Approved',
                actionedDate: new Date(),
                comment,
            },
        },
    );
}

export async function syncVehicleAccessFuelReminder(now = new Date()) {
    const monthKey = accessFuelMonthKeyFromDate(now);
    const missing = await listAssignedVehiclesMissingFuel(monthKey);
    const missingCount = missing.length;
    const adminOfficer = await resolveAdminOfficerEmployee().catch(() => null);

    await closePendingReminders(
        {
            $or: [
                { extra2: { $ne: monthKey } },
                ...(adminOfficer?._id ? [{ assignedTo: { $ne: adminOfficer._id } }] : []),
            ],
        },
        'Access fuel reminder closed',
    );

    if (!adminOfficer?._id || missingCount <= 0) {
        await closePendingReminders({ extra2: monthKey }, 'All assigned vehicles have fuel for this month');
        return { monthKey, missingCount, adminOfficer };
    }

    const extra1 = accessFuelInboxMessage(missingCount, monthKey);
    const extra3 = reminderMeta(monthKey, missingCount);
    const existing = await DashboardAction.findOne({
        requestType: ACCESS_FUEL_REMINDER_REQUEST_TYPE,
        assignedTo: adminOfficer._id,
        extra2: monthKey,
        status: 'Pending',
    }).select('_id');

    if (existing) {
        await DashboardAction.updateOne(
            { _id: existing._id },
            {
                $set: {
                    extra1,
                    extra3,
                    subjectName: 'Access Fuel',
                    assignedToEmpId: adminOfficer.employeeId || '',
                },
            },
        );
        return { monthKey, missingCount, adminOfficer };
    }

    await DashboardAction.create({
        assignedTo: adminOfficer._id,
        assignedToEmpId: adminOfficer.employeeId || '',
        requestId: adminOfficer._id,
        requestType: ACCESS_FUEL_REMINDER_REQUEST_TYPE,
        status: 'Pending',
        requestedByName: 'System',
        subjectName: 'Access Fuel',
        extra1,
        extra2: monthKey,
        extra3,
    });
    return { monthKey, missingCount, adminOfficer };
}

function mailTransport() {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
}

function reminderEmailHtml({ name, monthLabel, missingCount, href }) {
    const countLabel =
        missingCount === 1 ? '1 assigned vehicle is' : `${missingCount} assigned vehicles are`;
    return `
        <p>Hello ${escapeHtml(name)},</p>
        <p>${escapeHtml(countLabel)} missing fuel for <strong>${escapeHtml(monthLabel)}</strong>.</p>
        <p>Add this month's fuel bill on Access Fuel. This email is sent once per month.</p>
        <p><a href="${escapeHtml(href)}">Open Access Fuel</a></p>
    `;
}

async function sendMonthlyEmailOnce({ monthKey, missingCount, adminOfficer }) {
    const email = String(pickEffectiveEmail(adminOfficer) || '').trim().toLowerCase();
    if (!email) return false;

    const already = await VehicleAccessFuelReminderLog.findOne({ monthKey, email }).select('_id').lean();
    if (already) return false;

    const transporter = mailTransport();
    if (!transporter) return false;

    const name =
        `${adminOfficer?.firstName || ''} ${adminOfficer?.lastName || ''}`.trim() ||
        adminOfficer?.employeeId ||
        'there';
    const monthLabel = accessFuelMonthLabel(monthKey, 'long');
    const href = withFrontendPath(ACCESS_FUEL_PANEL_PATH);
    const emailUser = process.env.EMAIL_USER?.trim();

    await transporter.sendMail({
        from: `"VeRP Notifications" <${emailUser}>`,
        to: email,
        subject: accessFuelEmailSubject(monthKey),
        html: reminderEmailHtml({ name, monthLabel, missingCount, href }),
    });

    await VehicleAccessFuelReminderLog.create({
        monthKey,
        email,
        employeeId: String(adminOfficer?.employeeId || ''),
        missingCount,
        sentAt: new Date(),
    });
    return true;
}

/**
 * Daily job: on the 1st (and catch-up later in the month) email Admin Officer once
 * if any assigned vehicle is missing this month's fuel. The vehicle-list bell stays
 * until every assigned vehicle has fuel for the current month.
 */
export async function processVehicleAccessFuelReminders(now = new Date()) {
    try {
        const result = await syncVehicleAccessFuelReminder(now);
        if (result.missingCount > 0) {
            await sendMonthlyEmailOnce(result);
        }
        return result;
    } catch (err) {
        console.error('[processVehicleAccessFuelReminders] Non-fatal error:', err?.message || err);
        return null;
    }
}
