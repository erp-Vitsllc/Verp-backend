export const PENDING_ENROLLMENT_REQUEST_TYPE = 'Salary Enrollment';
export const PENDING_ENROLLMENT_EXTRA = 'Pending for enrollment';

function parseExtra3(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export function isPendingEnrollmentReminder(row) {
    const extra2 = String(row?.extra2 || '').trim().toLowerCase();
    if (extra2 === PENDING_ENROLLMENT_EXTRA.toLowerCase()) return true;
    return parseExtra3(row?.extra3).pendingEnrollment === true;
}
