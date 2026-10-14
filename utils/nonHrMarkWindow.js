function shiftDateKey(dateKey, deltaDays) {
    const [year, month, day] = String(dateKey).split('-').map(Number);
    const dt = new Date(Date.UTC(year, month - 1, day + deltaDays, 12, 0, 0));
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Today plus the previous `extraDays` calendar days.
 * Holidays are included and count as one of those days.
 * Today is always included.
 */
export function nonHrMarkableDateKeys(todayKey, _holidayDates, extraDays = 7) {
    const today = String(todayKey || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return new Set();

    const days = Number.isFinite(Number(extraDays)) ? Math.max(0, Number(extraDays)) : 7;
    const allowed = new Set([today]);
    for (let offset = 1; offset <= days; offset += 1) {
        allowed.add(shiftDateKey(today, -offset));
    }
    return allowed;
}
