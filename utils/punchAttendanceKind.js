/**
 * Kept with weeklySalaryAddition.js. Same file as
 * VERP_frontend/src/app/HRM/Leave/utils/punchAttendanceKind.js.
 *
 * Late arrival, early go, and missed punch stay those types.
 * Approved or not, they are never unauthorized leave.
 */
export function punchAttendanceKind(row) {
    if (!row) return '';
    const key = String(row.statusKey || '');
    const text = `${row.statusLabel || ''} ${row.reason || ''}`;
    const session = String(row.leaveRequestSession || '').trim();
    if (key === 'mispunch' || /mispunch/i.test(text)) return 'mispunch';
    if (key === 'early_go') return 'early_go';
    if (key === 'late_arrived') return 'late_arrived';
    if (key !== 'unauthorized_leave') return '';
    if (session === 'pm' || /\(PM\)/i.test(text) || /early/i.test(text)) return 'early_go';
    if (session === 'am' || /\(AM\)/i.test(text) || /late/i.test(text)) return 'late_arrived';
    const punched = Boolean(String(row.timeIn || '').trim() && String(row.timeOut || '').trim());
    if (punched && /unauthorized (half|quarter) day/i.test(text)) return 'late_arrived';
    return '';
}
