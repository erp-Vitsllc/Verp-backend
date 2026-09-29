export function readGroupLeavePercent(value) {
    if (value === '' || value == null) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(100, n);
}

/**
 * People allowed on annual leave in a group.
 * ceil(headcount × % / 100). A positive fraction below 1 still allows 1.
 * 12 staff × 20% → 3. 10 staff × 20% → 2. 10 staff × 1% → 1.
 */
export function floorGroupLeaveSlots(employeeCount, percent) {
    const count = Math.max(0, Number(employeeCount) || 0);
    const pct = Number(percent);
    if (!Number.isFinite(pct) || pct < 0 || count <= 0) return 0;
    const raw = (count * pct) / 100;
    if (raw <= 0) return 0;
    if (raw < 1) return 1;
    return Math.ceil(raw);
}
