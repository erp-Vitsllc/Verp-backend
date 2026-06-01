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
 * Email reminders only on exact lead times: 30, 20, and 10 days before expiry.
 * <10 days are task-only (no reminder email).
 */
export const getEmailReminderStageMarker = (daysUntilExpiry) => {
    if (daysUntilExpiry == null) return null;
    if (daysUntilExpiry === 30) return 30;
    if (daysUntilExpiry === 20) return 20;
    if (daysUntilExpiry === 10) return 10;
    return null;
};

/** Pending HR/Admin (and related) dashboard tasks while expiry is within 10 days or overdue. */
export const isExpiryTaskWindow = (daysUntilExpiry) =>
    daysUntilExpiry != null && (daysUntilExpiry === 30 || daysUntilExpiry === 20 || daysUntilExpiry <= 10);
