export function readGroupLeavePercent(value) {
    if (value === '' || value == null) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(100, n);
}

/**
 * People allowed on annual leave in a group.
 * floor(headcount × % / 100), except a positive fraction below 1 still allows 1.
 * 10 staff × 1% → 1; 1.5 / 1.6 → 1; 2.0 or more → 2.
 */
export function floorGroupLeaveSlots(employeeCount, percent) {
    const count = Math.max(0, Number(employeeCount) || 0);
    const pct = Number(percent);
    if (!Number.isFinite(pct) || pct < 0 || count <= 0) return 0;
    const raw = (count * pct) / 100;
    if (raw <= 0) return 0;
    if (raw < 1) return 1;
    return Math.floor(raw);
}
