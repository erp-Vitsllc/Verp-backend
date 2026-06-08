export function validateEmployeeLabourCardNoticePeriod(value) {
    if (value === "" || value === null || value === undefined) {
        return "Notice period is required";
    }
    const months = Number(value);
    if (!Number.isFinite(months) || months < 1 || months > 24) {
        return "Notice period must be between 1 and 24 months";
    }
    return null;
}

export function calculateExitDateFromNoticePeriod(resignationDate, noticePeriodMonths) {
    if (!resignationDate || !noticePeriodMonths) return null;
    const start = new Date(resignationDate);
    if (Number.isNaN(start.getTime())) return null;
    const exit = new Date(start);
    exit.setDate(exit.getDate() + Number(noticePeriodMonths) * 30);
    return exit;
}

export function formatNoticeDurationLabel(months) {
    const n = Number(months);
    if (!Number.isFinite(n) || n < 1) return "";
    return `${n} Month${n === 1 ? "" : "s"}`;
}
