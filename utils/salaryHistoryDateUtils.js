function parseCalendarDate(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return {
            year: value.getFullYear(),
            month: value.getMonth() + 1,
            day: value.getDate(),
        };
    }
    const raw = String(value).trim();
    if (raw.includes("T")) {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return null;
        return {
            year: d.getFullYear(),
            month: d.getMonth() + 1,
            day: d.getDate(),
        };
    }
    const parts = raw.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!parts) return null;
    return {
        year: parseInt(parts[1], 10),
        month: parseInt(parts[2], 10),
        day: parseInt(parts[3], 10),
    };
}

function calendarDateToLocalDate(parts) {
    if (!parts) return null;
    return new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
}

export function startOfSalaryMonth(value) {
    const cal = parseCalendarDate(value);
    if (!cal) return null;
    return calendarDateToLocalDate({ year: cal.year, month: cal.month, day: 1 });
}

/** Last day of the month before the salary period start month. */
export function endOfPreviousSalaryMonth(value) {
    const start = startOfSalaryMonth(value);
    if (!start) return null;
    return new Date(start.getFullYear(), start.getMonth(), 0, 0, 0, 0, 0);
}

export function serializeSalaryCalendarDate(value) {
    const cal = parseCalendarDate(value);
    if (!cal) return null;
    const month = String(cal.month).padStart(2, "0");
    const day = String(cal.day).padStart(2, "0");
    return `${cal.year}-${month}-${day}`;
}

export function serializeSalaryFromDate(value) {
    const start = startOfSalaryMonth(value);
    return start ? serializeSalaryCalendarDate(start) : null;
}

export function serializeSalaryToDate(nextPeriodStart) {
    const end = endOfPreviousSalaryMonth(nextPeriodStart);
    return end ? serializeSalaryCalendarDate(end) : null;
}

export function salaryMonthKeyFromDate(value) {
    const cal = parseCalendarDate(value);
    if (!cal) return null;
    return `${cal.year}-${cal.month - 1}`;
}

export function normalizeSalaryHistoryDates(history = []) {
    return history.map((entry) => ({
        ...entry,
        fromDate: entry?.fromDate ? serializeSalaryFromDate(entry.fromDate) : entry?.fromDate,
        toDate: entry?.toDate ? serializeSalaryCalendarDate(entry.toDate) : entry?.toDate,
    }));
}

/** Close extra active rows so prior period ends the month before the next start month. */
export function closeSupersededSalaryHistoryEntries(history = []) {
    const rows = Array.isArray(history) ? history.map((entry) => ({ ...entry })) : [];
    const activeRows = rows
        .map((entry, idx) => ({ entry, idx }))
        .filter(({ entry }) => !entry?.toDate);

    if (activeRows.length <= 1) return rows;

    const sortKey = (entry) => startOfSalaryMonth(entry?.fromDate)?.getTime() ?? 0;
    const sortedActive = [...activeRows].sort((a, b) => sortKey(b.entry) - sortKey(a.entry));
    const newest = sortedActive[0];

    sortedActive.slice(1).forEach(({ idx }) => {
        rows[idx] = {
            ...rows[idx],
            toDate: serializeSalaryToDate(newest.entry.fromDate),
        };
    });

    return normalizeSalaryHistoryDates(rows);
}
