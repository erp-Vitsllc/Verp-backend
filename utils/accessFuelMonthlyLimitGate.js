import { getCalendarPartsInTz } from './scheduleDailyAtMidnight.js';

const MONTH_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAYS_BEFORE_MONTH_END = 5;

function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseMonthKey(monthKey) {
    const match = String(monthKey || '').match(MONTH_KEY_RE);
    if (!match) return null;
    return { year: Number(match[1]), month: Number(match[2]) };
}

function monthKeyFromParts(year, month) {
    return `${year}-${String(month).padStart(2, '0')}`;
}

function shiftMonth(year, month, delta) {
    const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

function isLastDaysOfMonth(year, month, day) {
    const lastDay = daysInMonth(year, month);
    return day >= lastDay - (DAYS_BEFORE_MONTH_END - 1) && day <= lastDay;
}

/**
 * Current month: open from day 1 (set this month's limits).
 * Next month: open only in the last 5 days of the current month.
 * Past months: closed — Monthly Limit is only for current / future months.
 * Later than next month: closed until that month becomes current/next.
 */
export function isAccessFuelMonthlyLimitWindowOpen(monthKey, now = new Date()) {
    const selected = parseMonthKey(monthKey);
    if (!selected) return false;

    const { year: currentYear, month: currentMonth, day } = getCalendarPartsInTz(now);
    const currentKey = monthKeyFromParts(currentYear, currentMonth);
    const next = shiftMonth(currentYear, currentMonth, 1);
    const nextKey = monthKeyFromParts(next.year, next.month);

    if (monthKey === currentKey) return true;
    if (monthKey === nextKey) return isLastDaysOfMonth(currentYear, currentMonth, day);

    // Past or farther-future months stay closed.
    return false;
}

export function limitedVehicleIdsFromLog(log, assignedVehicles = []) {
    if (!log) return [];
    const fromLog = (Array.isArray(log.vehicleIds) ? log.vehicleIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);
    if (fromLog.length) return fromLog;
    // Legacy month batch stored no vehicle ids — hide assigned vehicles that already have a limit.
    return (assignedVehicles || [])
        .filter((vehicle) => Number(vehicle?.fuelMonthlyLimit) > 0)
        .map((vehicle) => String(vehicle._id || '').trim())
        .filter(Boolean);
}

export function assignedVehiclesMissingMonthlyLimit({
    assignedVehicles = [],
    limitLog = null,
} = {}) {
    const limited = new Set(limitedVehicleIdsFromLog(limitLog, assignedVehicles));
    return (assignedVehicles || []).filter((vehicle) => {
        const id = String(vehicle?._id || '').trim();
        return id && !limited.has(id);
    });
}

export function pendingAccessFuelLimitVehicles({
    assignedVehicles = [],
    billedVehicleIds = [],
    limitLog = null,
} = {}) {
    const billed = new Set((billedVehicleIds || []).map((id) => String(id || '').trim()).filter(Boolean));
    return assignedVehiclesMissingMonthlyLimit({ assignedVehicles, limitLog }).filter((vehicle) => {
        const id = String(vehicle?._id || '').trim();
        return id && !billed.has(id);
    });
}

export function accessFuelMonthlyLimitGate({
    monthKey,
    assignedCount = 0,
    pendingLimitCount = 0,
    now = new Date(),
} = {}) {
    const assigned = Math.max(0, Number(assignedCount) || 0);
    const pending = Math.max(0, Number(pendingLimitCount) || 0);

    if (assigned <= 0) {
        return { canCreate: false, reason: 'No assigned vehicles.' };
    }
    if (pending <= 0) {
        return {
            canCreate: false,
            reason: 'Monthly limits already created for all assigned vehicles.',
        };
    }
    if (!isAccessFuelMonthlyLimitWindowOpen(monthKey, now)) {
        const selected = parseMonthKey(monthKey);
        const { year: currentYear, month: currentMonth } = getCalendarPartsInTz(now);
        const selectedIndex = selected ? selected.year * 12 + selected.month : 0;
        const currentIndex = currentYear * 12 + currentMonth;
        if (selected && selectedIndex < currentIndex) {
            return {
                canCreate: false,
                reason: 'Monthly Limit is only available for the current or future month.',
            };
        }
        return {
            canCreate: false,
            reason: 'Next month limits are available only in the last 5 days of this month.',
        };
    }
    return { canCreate: true, reason: '' };
}

/**
 * Close selected month from the 2nd of the following month onward.
 * Example: August closes from 2 Sep onward (not only on 2 Sep).
 */
export function isAccessFuelMonthlyCloseWindowOpen(monthKey, now = new Date()) {
    const selected = parseMonthKey(monthKey);
    if (!selected) return false;
    const next = shiftMonth(selected.year, selected.month, 1);
    const { year, month, day } = getCalendarPartsInTz(now);
    const todayIndex = year * 12 + month;
    const nextIndex = next.year * 12 + next.month;
    if (todayIndex > nextIndex) return true;
    if (todayIndex === nextIndex && day >= 2) return true;
    return false;
}

export function accessFuelMonthlyCloseGate({
    monthKey,
    openAddedCount = 0,
    now = new Date(),
} = {}) {
    if (!isAccessFuelMonthlyCloseWindowOpen(monthKey, now)) {
        return {
            canClose: false,
            reason: 'Available from the 2nd of the next month onward.',
        };
    }
    if (Math.max(0, Number(openAddedCount) || 0) <= 0) {
        return {
            canClose: false,
            reason: 'No open fuel-added vehicles this month.',
        };
    }
    return { canClose: true, reason: '' };
}
