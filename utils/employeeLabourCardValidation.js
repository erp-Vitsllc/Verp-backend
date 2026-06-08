export const NOTICE_PERIOD_DAY_OPTIONS = [30, 60, 90, 120, 150, 180];

export function noticePeriodToDays(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (NOTICE_PERIOD_DAY_OPTIONS.includes(n)) return n;
    if (n >= 1 && n <= 24) return n * 30;
    return null;
}

export function validateEmployeeLabourCardNoticePeriod(value) {
    if (value === "" || value === null || value === undefined) {
        return "Notice period is required";
    }
    if (!noticePeriodToDays(value)) {
        return "Please select a valid notice period";
    }
    return null;
}

export function calculateExitDateFromNoticePeriod(approvalDate, noticePeriodValue) {
    const days = noticePeriodToDays(noticePeriodValue);
    if (!approvalDate || !days) return null;
    const start = new Date(approvalDate);
    if (Number.isNaN(start.getTime())) return null;
    const exit = new Date(start);
    exit.setDate(exit.getDate() + days);
    return exit;
}

export function formatNoticeDurationLabel(value) {
    const days = noticePeriodToDays(value);
    if (!days) return "";
    return `${days} days`;
}
