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
 * Email reminders on ranges:
 * - 30 to 21 days remaining: Stage 30 email
 * - 20 to 11 days remaining: Stage 20 email
 * - 10 to 1 days remaining: Stage 10 email
 * - 0 days or less (expired): Stage 0 email
 */
export const getEmailReminderStageMarker = (daysUntilExpiry) => {
    if (daysUntilExpiry == null) return null;
    if (daysUntilExpiry <= 30 && daysUntilExpiry >= 21) return 30;
    if (daysUntilExpiry <= 20 && daysUntilExpiry >= 11) return 20;
    if (daysUntilExpiry <= 10 && daysUntilExpiry >= 1) return 10;
    if (daysUntilExpiry <= 0) return 0;
    return null;
};

/** Pending HR dashboard tasks within 10 days of expiry (incl. 0), or overdue. */
export const isExpiryTaskWindow = (daysUntilExpiry) =>
    daysUntilExpiry != null && daysUntilExpiry <= 10;

/** True when a certificate is past expiry (strictly before today). */
export const isCertificateExpired = (daysUntilExpiry) =>
    daysUntilExpiry != null && daysUntilExpiry < 0;

/**
 * HR notification tasks for certificates: milestone window (<=10 incl. expiry day)
 * or any overdue certificate.
 */
export const isCertificateExpiryHrTaskDue = (daysUntilExpiry) =>
    daysUntilExpiry != null &&
    (isCertificateExpired(daysUntilExpiry) || isExpiryTaskWindow(daysUntilExpiry));

/** Pick HR task window for a scanned expiry row (certificates always notify when expired). */
export const isExpiryHrTaskDueForDoc = (daysUntilExpiry, { isCertificate = false } = {}) =>
    isCertificate ? isCertificateExpiryHrTaskDue(daysUntilExpiry) : isExpiryTaskWindow(daysUntilExpiry);
