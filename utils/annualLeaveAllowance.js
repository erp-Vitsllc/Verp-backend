import Attendance from '../models/Attendance.js';
import {
    addDays,
    isDateKey,
    policyLeaveWorkingDays,
    twelveMonthPeriodEnd,
} from './salaryHistoricalCalculations.js';
import { calcWorkingDays, dubaiDateKey, toDateKey } from './loadLeaveTicketEntitlement.js';

export const ANNUAL_LEAVE_ALLOWED_DAYS = 30;

const DEDUCTION_STATUS = new Set([
    'authorized_leave',
    'unauthorized_leave',
    'sick_leave',
    'on_leave',
    'compoff_leave',
    'not_marked',
    'absent',
]);

function eachDate(from, to) {
    if (!isDateKey(from) || !isDateKey(to) || to < from) return [];
    const dates = [];
    let cursor = from;
    while (cursor <= to && dates.length < 4000) {
        dates.push(cursor);
        cursor = addDays(cursor, 1);
    }
    return dates;
}

function leaveRange(row) {
    const from = toDateKey(row?.startDate || row?.fromDate);
    const to = toDateKey(row?.endDate || row?.toDate) || from;
    if (!isDateKey(from) || !isDateKey(to) || to < from) return null;
    return { from, to };
}

function isAnnualRow(row) {
    const type = String(row?.leaveType || row?.type || 'annual').toLowerCase();
    return !row?.leaveType || type === 'annual' || type === 'on_leave';
}

function collectHistorical(profile) {
    const deductionDates = [];
    const annual = [];
    let undatedDeduction = 0;
    const rows = [
        ...(Array.isArray(profile?.leaveRecords) ? profile.leaveRecords : []),
        ...(Array.isArray(profile?.annualLeaveRecords) ? profile.annualLeaveRecords : []),
    ];
    for (const row of rows) {
        const status = String(row?.status || '').toLowerCase();
        if (['cancelled', 'rejected', 'draft'].includes(status)) continue;
        const type = String(row?.leaveType || row?.type || '').toLowerCase();
        if (type === 'holiday') continue;
        const range = leaveRange(row);
        if (!range) {
            const days = Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays ?? row?.deductionDays) || 0);
            if (days) undatedDeduction += days;
            continue;
        }
        const dates = eachDate(range.from, range.to);
        deductionDates.push(...dates);
        if (isAnnualRow(row)) {
            const storedDays = Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays ?? row?.deductionDays) || 0);
            const source = String(row?.source || 'manual').trim().toLowerCase();
            annual.push({
                id: String(row?._id || row?.id || ''),
                dates,
                days: storedDays || dates.length,
                startDate: range.from,
                endDate: range.to,
                status: status === 'pending' ? 'pending' : 'approved',
                source: source === 'system' || source === 'erp' ? 'system' : 'manual',
                multiplier: Math.max(0, Number(row?.multiplier ?? row?.rule) || 1) || 1,
                remarks: String(row?.remarks || ''),
            });
        }
    }
    return { deductionDates, annual, undatedDeduction };
}

function spreadAcrossDates(dates, dayCount) {
    const list = (dates || []).filter((date) => isDateKey(date));
    const total = Math.max(0, Number(dayCount) || 0);
    if (!total || !list.length) return [];
    const base = Math.floor(total / list.length);
    let extra = total - base * list.length;
    const out = [];
    for (const date of list) {
        const days = base + (extra > 0 ? 1 : 0);
        if (extra > 0) extra -= 1;
        if (days > 0) out.push({ date, days });
    }
    return out;
}

/**
 * Fill the earliest row whose window contains the date, up to `allowed`.
 * A later row receives the rest only when that same date is inside its window
 * (row start through the following leave eligible date). Days that no later
 * row can take stay on the earliest row, even past `allowed`.
 */
function allocateAnnualLeave(periods, leaves, allowed) {
    const usedDaysByRow = periods.map(() => 0);
    const pendingDaysByRow = periods.map(() => 0);
    const leaveDatesByRow = periods.map(() => []);
    const entriesByRow = periods.map(() => []);
    const rowIndexForDate = (date) => {
        const inside = periods.findIndex((period) => date >= period.startDate && date <= period.takeUntil);
        if (inside >= 0) return inside;
        const later = periods.findIndex((period) => date <= period.takeUntil);
        return later >= 0 ? later : 0;
    };
    const ordered = [...(leaves || [])].sort((a, b) => {
        const left = String(a?.startDate || a?.dates?.[0] || '');
        const right = String(b?.startDate || b?.dates?.[0] || '');
        if (left === right) return 0;
        return left < right ? -1 : 1;
    });

    for (const leave of ordered) {
        const dates = [...new Set((leave?.dates || []).filter((date) => isDateKey(date)))].sort();
        const storedDays = Math.max(0, Number(leave?.days) || 0);
        const dayCount = storedDays || dates.length;
        if (!dayCount || !periods.length) continue;
        const anchor = isDateKey(leave?.startDate) ? leave.startDate : dates[0] || '';
        const endAnchor = isDateKey(leave?.endDate) ? leave.endDate : dates[dates.length - 1] || anchor;
        const units = spreadAcrossDates(dates.length ? dates : anchor ? [anchor] : [], dayCount);
        if (!units.length) continue;
        const pending = leave?.status === 'pending';
        const placed = periods.map(() => ({ days: 0, dates: [] }));

        for (const unit of units) {
            const covering = [];
            periods.forEach((period, index) => {
                if (unit.date >= period.startDate && unit.date <= period.takeUntil) covering.push(index);
            });
            const targets = covering.length ? covering : [rowIndexForDate(unit.date)];
            let left = unit.days;
            for (const index of targets) {
                if (left <= 0) break;
                const room = allowed - usedDaysByRow[index];
                if (room <= 0) continue;
                const take = Math.min(room, left);
                usedDaysByRow[index] += take;
                if (pending) pendingDaysByRow[index] += take;
                placed[index].days += take;
                placed[index].dates.push(unit.date);
                left -= take;
            }
            if (left > 0) {
                const index = targets[0];
                usedDaysByRow[index] += left;
                if (pending) pendingDaysByRow[index] += left;
                placed[index].days += left;
                placed[index].dates.push(unit.date);
            }
        }

        const touched = placed
            .map((bucket, index) => ({ bucket, index }))
            .filter((item) => item.bucket.days > 0);
        touched.forEach((item, position) => {
            const earlier = new Set();
            for (let prev = 0; prev < position; prev += 1) {
                touched[prev].bucket.dates.forEach((date) => earlier.add(date));
            }
            const sorted = [...new Set(item.bucket.dates)].sort();
            let from = sorted[0] || anchor;
            let to = sorted[sorted.length - 1] || endAnchor || from;
            if (from && earlier.has(from)) {
                const next = addDays(from, 1);
                if (next && next <= to) from = next;
            }
            leaveDatesByRow[item.index].push(...sorted);
            const multiplier = Math.max(0, Number(leave?.multiplier) || 1) || 1;
            const days = item.bucket.days;
            entriesByRow[item.index].push({
                id: String(leave?.id || ''),
                fromDate: from,
                toDate: to,
                recordFrom: anchor,
                recordTo: endAnchor,
                actualDays: days,
                multiplier,
                source: leave?.source === 'system' ? 'system' : 'manual',
                status: pending ? 'pending' : 'approved',
                remarks: String(leave?.remarks || ''),
            });
        });
    }

    entriesByRow.forEach((entries) => {
        entries.sort((a, b) => String(a.fromDate || '').localeCompare(String(b.fromDate || '')));
    });
    return { usedDaysByRow, pendingDaysByRow, leaveDatesByRow, entriesByRow };
}

function periodByIndex(joiningDate, index) {
    let startDate = joiningDate;
    for (let step = 1; step < index; step += 1) {
        const endDate = twelveMonthPeriodEnd(startDate);
        if (!isDateKey(endDate)) return null;
        startDate = addDays(endDate, 1);
    }
    const endDate = twelveMonthPeriodEnd(startDate);
    if (!isDateKey(startDate) || !isDateKey(endDate)) return null;
    return { startDate, endDate };
}

/**
 * Row 1 starts on the contract joining date. Each later row starts the day
 * after the previous leave eligible date. A row counts annual leave from its
 * joining date through the next row's leave eligible date. Each row holds
 * 30 days. Once that is full, later days count on the next row only when
 * the leave date is inside that next row (its joining date through the
 * following leave eligible date). Days the next row cannot take stay on
 * the earlier row, and balance stays 0 once used passes 30. The row stays
 * Inactive until that
 * 300-day cycle is complete, then Active. It becomes Lapsed once the next
 * row's leave eligible date is today or earlier.
 */
export function buildAnnualLeaveWindows({
    joiningDate = '',
    workingDateKeys = [],
    deductionDates = [],
    undatedDeduction = 0,
    annualLeaves = [],
    cycleDays = 300,
    allowedDays = ANNUAL_LEAVE_ALLOWED_DAYS,
    today = '',
} = {}) {
    const step = Math.max(1, Number(cycleDays) || 300);
    const allowed = Math.max(0, Number(allowedDays) || ANNUAL_LEAVE_ALLOWED_DAYS);
    const deduct = new Set((deductionDates || []).filter((date) => isDateKey(date)));
    let counted = (workingDateKeys || []).filter((date) => isDateKey(date) && !deduct.has(date));
    const drop = Math.max(0, Math.floor(Number(undatedDeduction) || 0));
    if (drop) counted = counted.slice(drop);
    const completed = Math.floor(counted.length / step);
    const remainderDays = counted.length % step;
    const todayKey = isDateKey(today) ? today : '';
    const joining = isDateKey(joiningDate) ? joiningDate : '';

    const periods = [];
    if (joining && (!todayKey || joining <= todayKey)) {
        for (let index = 1; index < 80; index += 1) {
            const period = periodByIndex(joining, index);
            if (!period) break;
            if (todayKey && period.startDate > todayKey) break;
            const next = periodByIndex(joining, index + 1);
            periods.push({
                index,
                startDate: period.startDate,
                endDate: period.endDate,
                takeUntil: next?.endDate || period.endDate,
            });
        }
    }

    const { usedDaysByRow, pendingDaysByRow, leaveDatesByRow, entriesByRow } = allocateAnnualLeave(
        periods,
        annualLeaves,
        allowed,
    );

    const windows = periods.map((period, index) => {
        const pendingDays = pendingDaysByRow[index];
        const usedDays = usedDaysByRow[index];
        const approvedDays = Math.max(0, usedDays - pendingDays);
        const cycleReady = counted.length >= (index + 1) * step;
        const lapsed = Boolean(todayKey && period.takeUntil <= todayKey);
        const status = lapsed ? 'Lapsed' : cycleReady ? 'Active' : 'Inactive';
        const eligible = status !== 'Inactive';
        const balance = eligible ? Math.max(0, allowed - usedDays) : 0;
        const dates = leaveDatesByRow[index].sort();
        return {
            index: period.index,
            startDate: period.startDate,
            endDate: period.endDate,
            takeUntil: period.takeUntil,
            allowedDays: eligible ? allowed : 0,
            approvedDays,
            pendingDays,
            takenDays: usedDays,
            balance,
            remainingDays: status === 'Active' ? balance : 0,
            leaveDates: dates,
            entries: entriesByRow[index] || [],
            status,
            canTake: status === 'Active' && balance > 0,
        };
    });

    const active = windows.find((row) => row.canTake)
        || windows.find((row) => row.status === 'Active')
        || null;
    return {
        cycleDays: step,
        allowedDays: allowed,
        countedDays: counted.length,
        completedCycles: completed,
        remainderDays,
        entitledPeriods: windows.filter((row) => row.status !== 'Inactive').length,
        windows,
        active,
        remainingDays: active ? active.remainingDays : 0,
        startDate: active?.startDate || '',
        endDate: active?.endDate || '',
    };
}

export function annualLeaveRequestBlock(allowance, { from = '', to = '', requestedDates = [] } = {}) {
    const windows = allowance?.windows || [];
    const start = String(from || '').trim();
    const end = String(to || '').trim();
    const dated = isDateKey(start) && isDateKey(end);
    const datedRow = dated
        ? windows.find((item) => start >= item.startDate && end <= item.takeUntil && item.remainingDays > 0 && item.status === 'Active')
            || windows.find((item) => start >= item.startDate && end <= item.takeUntil)
        : null;
    const row = datedRow || allowance?.active || windows.find((item) => item.status === 'Active') || null;
    if (!row) {
        return {
            ok: false,
            message: 'Annual leave follows 12-month periods from the contract joining date. These dates are outside every period.',
        };
    }
    if (row.status === 'Lapsed') {
        return {
            ok: false,
            message: `Annual leave for ${row.startDate} to ${row.endDate} has lapsed and those days cannot be taken.`,
        };
    }
    if (row.status !== 'Active') {
        const cycle = allowance?.cycleDays || 300;
        return {
            ok: false,
            message: `Annual leave for ${row.startDate} to ${row.endDate} opens when counted working days complete the next ${cycle}-day cycle.`,
        };
    }
    const days = Array.isArray(requestedDates) ? requestedDates.length : 0;
    let capacity = 0;
    let started = false;
    for (const item of windows) {
        if (item.index === row.index) started = true;
        if (!started) continue;
        if (dated && end > item.takeUntil) break;
        if (item.status !== 'Active') break;
        capacity += item.remainingDays;
    }
    if (days > capacity) {
        return {
            ok: false,
            message: `Only ${capacity} annual leave day${capacity === 1 ? '' : 's'} remain in ${row.startDate} to ${row.takeUntil}.`,
        };
    }
    return { ok: true, message: '' };
}

export async function loadAnnualLeaveAllowance({ employee, profile, policy } = {}) {
    const joiningDate = toDateKey(
        profile?.contractJoiningDate || employee?.contractJoiningDate || employee?.dateOfJoining,
    );
    const today = dubaiDateKey();
    const cycleDays = policyLeaveWorkingDays(policy);
    if (!employee?._id || !isDateKey(joiningDate) || joiningDate > today) {
        return buildAnnualLeaveWindows({ cycleDays, today });
    }

    const [working, attendanceRows] = await Promise.all([
        calcWorkingDays({ from: joiningDate, to: today, staffType: employee.staffType }),
        Attendance.find({
            $or: [
                { employeeMongoId: String(employee._id) },
                ...(employee.employeeId ? [{ employeeId: employee.employeeId }] : []),
            ],
            date: { $gte: joiningDate, $lte: today },
        })
            .select('date statusKey requestedStatusKey leaveRequestStatus')
            .lean()
            .maxTimeMS(8000),
    ]);

    const historical = collectHistorical(profile);
    const deductionDates = [...historical.deductionDates];
    const annualLeaves = [...historical.annual];

    for (const row of attendanceRows || []) {
        const date = toDateKey(row?.date);
        if (!isDateKey(date)) continue;
        const statusKey = String(row?.statusKey || '').trim();
        const requested = String(row?.requestedStatusKey || '').trim();
        const requestStatus = String(row?.leaveRequestStatus || '').trim();
        if (DEDUCTION_STATUS.has(statusKey) || (DEDUCTION_STATUS.has(requested) && requestStatus !== 'rejected')) {
            deductionDates.push(date);
        }
        const annualTaken = statusKey === 'on_leave';
        const annualPending = requested === 'on_leave' && requestStatus === 'pending';
        const annualApproved = requested === 'on_leave' && requestStatus === 'approved' && !annualTaken;
        if (annualTaken || annualApproved) {
            annualLeaves.push({
                dates: [date],
                days: 1,
                startDate: date,
                endDate: date,
                status: 'approved',
                source: 'system',
            });
        } else if (annualPending) {
            annualLeaves.push({
                dates: [date],
                days: 1,
                startDate: date,
                endDate: date,
                status: 'pending',
                source: 'system',
            });
        }
    }

    return buildAnnualLeaveWindows({
        joiningDate,
        workingDateKeys: working.workingDateKeys || [],
        deductionDates,
        undatedDeduction: historical.undatedDeduction,
        annualLeaves,
        cycleDays,
        today,
    });
}
