import Attendance from '../models/Attendance.js';
import {
    addDays,
    isDateKey,
    policyLeaveWorkingDays,
    twelveMonthPeriodEnd,
} from './salaryHistoricalCalculations.js';
import { calcWorkingDays, dubaiDateKey, projectWorkingDateKeys, toDateKey } from './loadLeaveTicketEntitlement.js';

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
            const source = String(row?.source || 'manual').trim().toLowerCase();
            const multiplier = Math.max(0, Number(row?.multiplier ?? row?.rule) || 1) || 1;
            const deductionDays = deductionDayCount(row, dates);
            annual.push({
                id: String(row?._id || row?.id || ''),
                dates,
                days: deductionDays,
                deductionDays,
                startDate: range.from,
                endDate: range.to,
                status: status === 'pending' ? 'pending' : 'approved',
                source: source === 'system' || source === 'erp' ? 'system' : 'manual',
                multiplier,
                remarks: String(row?.remarks || ''),
            });
        }
    }
    return { deductionDates, annual, undatedDeduction };
}

function deductionDayCount(row, dates) {
    const stored = Number(row?.deductionDays ?? row?.deduction);
    if (Number.isFinite(stored) && stored > 0) return stored;
    const eligible = Math.max(0, Number(row?.eligibleWorkingDays ?? row?.actualDays ?? row?.days) || 0);
    const multiplier = Math.max(0, Number(row?.multiplier ?? row?.rule) || 1) || 1;
    const span = Array.isArray(dates) ? dates.length : 0;
    return (eligible || span) * multiplier;
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
        const dayCount = deductionDayCount(leave, dates);
        if (!dayCount || !periods.length) continue;
        const anchor = isDateKey(leave?.startDate) ? leave.startDate : dates[0] || '';
        const endAnchor = isDateKey(leave?.endDate) ? leave.endDate : dates[dates.length - 1] || anchor;
        // Deduction days stay as one total. They are not divided back onto the dates.
        const pooled = Boolean(dates.length) && dayCount !== dates.length;
        const units = pooled
            ? []
            : (dates.length ? dates : anchor ? [anchor] : []).slice(0, dates.length ? dayCount : 1).map((date) => ({
                  date,
                  days: 1,
              }));
        if (!pooled && !units.length) continue;
        const pending = leave?.status === 'pending';
        const placed = periods.map(() => ({ days: 0, dates: [] }));
        let cappedSpill = false;
        const give = (index, take, date) => {
            if (take <= 0) return;
            usedDaysByRow[index] += take;
            if (pending) pendingDaysByRow[index] += take;
            placed[index].days += take;
            if (date) placed[index].dates.push(date);
        };

        if (pooled) {
            const covering = [];
            periods.forEach((period, index) => {
                if (dates.some((date) => date >= period.startDate && date <= period.takeUntil)) covering.push(index);
            });
            const targets = covering.length ? covering : [rowIndexForDate(anchor || dates[0])];
            let left = dayCount;
            for (const index of targets) {
                if (left <= 0) break;
                const room = allowed - usedDaysByRow[index];
                if (room <= 0) {
                    cappedSpill = true;
                    continue;
                }
                const take = Math.min(room, left);
                give(index, take);
                left -= take;
                if (left > 0) cappedSpill = true;
            }
            if (left > 0) give(targets[0], left);
        }

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
                if (room <= 0) {
                    cappedSpill = true;
                    continue;
                }
                const take = Math.min(room, left);
                give(index, take, unit.date);
                left -= take;
            }
            if (left > 0) give(targets[0], left, unit.date);
        }

        const touched = placed
            .map((bucket, index) => ({ bucket, index }))
            .filter((item) => item.bucket.days > 0);
        const split = cappedSpill && touched.length > 1;
        touched.forEach((item, position) => {
            const earlier = new Set();
            for (let prev = 0; prev < position; prev += 1) {
                touched[prev].bucket.dates.forEach((date) => earlier.add(date));
            }
            const sorted = [...new Set(item.bucket.dates.length ? item.bucket.dates : dates)].sort();
            let from = pooled ? anchor : sorted[0] || anchor;
            let to = pooled ? endAnchor || from : sorted[sorted.length - 1] || endAnchor || from;
            if (!pooled && from && earlier.has(from)) {
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
                split,
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
        const needed = (index + 1) * step;
        const cycleReady = counted.length >= needed;
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
            eligibleOn: counted.length >= needed ? counted[needed - 1] : '',
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
        countedDateKeys: counted,
    };
}

const MAX_PROJECTED_WORKING_DAYS = 900;

async function attachEligibleDates(allowance, staffType) {
    try {
        const keys = Array.isArray(allowance?.countedDateKeys) ? allowance.countedDateKeys : [];
        const step = Math.max(1, Number(allowance?.cycleDays) || 300);
        const pending = (allowance?.windows || []).filter(
            (window) => !window.eligibleOn && window.status !== 'Lapsed',
        );
        if (!pending.length) return allowance;
        const maxNeed = Math.max(...pending.map((window) => window.index * step));
        const left = Math.min(MAX_PROJECTED_WORKING_DAYS, maxNeed - keys.length);
        const from = keys.length ? addDays(keys[keys.length - 1], 1) : pending[0].startDate;
        const future = left > 0 ? await projectWorkingDateKeys({ from, count: left, staffType }) : [];
        for (const window of pending) {
            const index = window.index * step - keys.length - 1;
            window.eligibleOn = index >= 0 ? future[index] || '' : '';
        }
        return allowance;
    } finally {
        if (allowance) delete allowance.countedDateKeys;
    }
}

function windowOpensOnEligibleDate(item, start, end) {
    return (
        item?.status === 'Inactive' &&
        isDateKey(item.eligibleOn) &&
        isDateKey(start) &&
        isDateKey(end) &&
        start >= item.eligibleOn &&
        end <= item.takeUntil
    );
}

export function annualLeaveRequestBlock(allowance, { from = '', to = '', requestedDates = [] } = {}) {
    const windows = allowance?.windows || [];
    const start = String(from || '').trim();
    const end = String(to || '').trim();
    const dated = isDateKey(start) && isDateKey(end);
    const datedRow = dated
        ? windows.find((item) => start >= item.startDate && end <= item.takeUntil && item.remainingDays > 0 && item.status === 'Active')
            || windows.find((item) => windowOpensOnEligibleDate(item, start, end))
            || windows.find((item) => start >= item.startDate && end <= item.takeUntil)
        : null;
    const row = datedRow || allowance?.active || windows.find((item) => item.status === 'Active') || null;
    if (!row) {
        if (!dated && windows.some((item) => item.status === 'Inactive')) {
            const cycle = allowance?.cycleDays || 300;
            return {
                ok: false,
                message: `Annual leave opens when counted working days complete the next ${cycle}-day cycle.`,
            };
        }
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
    const laterOpen = windowOpensOnEligibleDate(row, start, end);
    if (row.status !== 'Active' && !laterOpen) {
        const cycle = allowance?.cycleDays || 300;
        return {
            ok: false,
            message: `Annual leave for ${row.startDate} to ${row.endDate} opens when counted working days complete the next ${cycle}-day cycle.`,
        };
    }
    const days = Array.isArray(requestedDates) ? requestedDates.length : 0;
    const allowed = Math.max(0, Number(allowance?.allowedDays) || ANNUAL_LEAVE_ALLOWED_DAYS);
    let capacity = 0;
    let started = false;
    for (const item of windows) {
        if (item.index === row.index) started = true;
        if (!started) continue;
        if (dated && end > item.takeUntil) break;
        if (item.status === 'Active') {
            capacity += item.remainingDays;
            continue;
        }
        if (
            item.status === 'Inactive' &&
            isDateKey(item.eligibleOn) &&
            dated &&
            end >= item.eligibleOn &&
            start <= item.takeUntil
        ) {
            capacity += Math.max(0, allowed - (Number(item.takenDays) || 0));
            continue;
        }
        break;
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
        return attachEligibleDates(buildAnnualLeaveWindows({ cycleDays, today }), employee?.staffType);
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

    return attachEligibleDates(
        buildAnnualLeaveWindows({
            joiningDate,
            workingDateKeys: working.workingDateKeys || [],
            deductionDates,
            undatedDeduction: historical.undatedDeduction,
            annualLeaves,
            cycleDays,
            today,
        }),
        employee.staffType,
    );
}
