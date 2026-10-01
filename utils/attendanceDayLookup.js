/** A stored punch time. Blank and dash placeholders do not count. */
export function punchTimeSet(value) {
    const text = String(value || '').trim();
    return Boolean(text && text !== '—' && text !== '-');
}

/**
 * Match attendance saved on this profile.
 * Also matches the employee code, so a punch stored against an older
 * profile id for the same employee is still found.
 */
export function employeeAttendanceMatch(employee) {
    const mongoId = String(employee?._id || employee?.employeeMongoId || '').trim();
    const code = String(employee?.employeeId || '').trim();
    const or = [];
    if (mongoId) or.push({ employeeMongoId: mongoId });
    if (code) {
        or.push({ employeeId: code });
        if (code !== mongoId) or.push({ employeeMongoId: code });
    }
    if (!or.length) return { employeeMongoId: '__none__' };
    return or.length === 1 ? or[0] : { $or: or };
}

function rowPunchRank(row) {
    const punched = punchTimeSet(row?.timeIn) ? 1 : 0;
    const live = row?.historical ? 0 : 1;
    const updated = row?.updatedAt ? new Date(row.updatedAt).getTime() : 0;
    const stamp = Number.isFinite(updated) ? updated : 0;
    return punched * 1e15 + live * 1e14 + stamp;
}

/**
 * One row per day. When the same day was saved twice, keep the row that
 * has the check-in. An empty duplicate must not hide the real punch.
 */
export function preferPunchedRows(rows) {
    const byDate = new Map();
    for (const row of rows || []) {
        const date = String(row?.date || '').trim();
        if (!date) continue;
        const prev = byDate.get(date);
        if (!prev || rowPunchRank(row) >= rowPunchRank(prev)) byDate.set(date, row);
    }
    return [...byDate.values()];
}

export function bestDayRecord(rows, dateKey) {
    const key = String(dateKey || '').trim();
    if (!key) return null;
    return preferPunchedRows(rows).find((row) => String(row?.date || '').trim() === key) || null;
}
