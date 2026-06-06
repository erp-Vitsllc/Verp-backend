const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

/** Calendar days from today (start of day) to expiry (start of day). Negative = expired. */
export const getDaysUntil = (expiryDate) => {
    if (!expiryDate) return null;
    const today = startOfDay(new Date());
    const exp = startOfDay(expiryDate);
    return Math.round((exp - today) / (1000 * 60 * 60 * 24));
};

/**
 * Email reminders on exact lead times: 30, 20, 10, and 0 (expiry day).
 * Days 9–1 are task-only (no email).
 */
export const getEmailReminderStageMarker = (daysUntilExpiry) => {
    if (daysUntilExpiry == null) return null;
    if (daysUntilExpiry === 30) return 30;
    if (daysUntilExpiry === 20) return 20;
    if (daysUntilExpiry === 10) return 10;
    if (daysUntilExpiry === 0) return 0;
    return null;
};

/** Pending HR dashboard tasks at 30, 20, within 10 days of expiry (incl. 0), or overdue. */
export const isExpiryTaskWindow = (daysUntilExpiry) =>
    daysUntilExpiry != null &&
    (daysUntilExpiry === 30 || daysUntilExpiry === 20 || daysUntilExpiry <= 10);

/** True when a certificate is past expiry (strictly before today). */
export const isCertificateExpired = (daysUntilExpiry) =>
    daysUntilExpiry != null && daysUntilExpiry < 0;

/**
 * HR notification tasks for certificates: milestone window (30/20/≤10 incl. expiry day)
 * or any overdue certificate.
 */
export const isCertificateExpiryHrTaskDue = (daysUntilExpiry) =>
    daysUntilExpiry != null &&
    (isCertificateExpired(daysUntilExpiry) || isExpiryTaskWindow(daysUntilExpiry));

/** Pick HR task window for a scanned expiry row (certificates always notify when expired). */
export const isExpiryHrTaskDueForDoc = (daysUntilExpiry, { isCertificate = false } = {}) =>
    isCertificate ? isCertificateExpiryHrTaskDue(daysUntilExpiry) : isExpiryTaskWindow(daysUntilExpiry);
