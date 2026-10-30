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

function noticeTitle(row) {
    return String(row?.extra1 || row?.subjectName || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

/**
 * A close attempt on the enrolment task uses the same title as the enrolment row.
 * The salary bell already shows the enrolment, so that task notice is not a second item.
 */
export function omitEnrollmentTaskDuplicates(enrollmentItems = [], taskItems = []) {
    const titles = new Set();
    for (const row of enrollmentItems || []) {
        const title = noticeTitle(row);
        const name = String(row?.subjectName || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (title) titles.add(title);
        if (name) titles.add(`${name} is pending for enrollment`);
    }
    return (taskItems || []).filter((row) => {
        const title = noticeTitle(row);
        return !title || !titles.has(title);
    });
}
