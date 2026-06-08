const SALARY_AMOUNT_REGEX = /^\d+(\.\d{1,2})?$/;
export const SALARY_PDF_MAX_BYTES = 10 * 1024 * 1024;

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function monthKeyFromDate(value) {
    const d = parseDate(value);
    if (!d) return null;
    return `${d.getFullYear()}-${d.getMonth()}`;
}

function validateSalaryAmount(value, { required = false, label = "Amount", companySalaryLimit } = {}) {
    const str = String(value ?? "").trim();
    if (!str) return required ? `${label} is required` : null;
    if (!SALARY_AMOUNT_REGEX.test(str)) {
        return `${label} must be a positive number with up to 2 decimal places`;
    }
    const num = parseFloat(str);
    if (num < 0) return `${label} cannot be negative`;
    if (required && num <= 0) return `${label} must be greater than 0`;
    if (Number.isFinite(companySalaryLimit) && companySalaryLimit > 0 && num > companySalaryLimit) {
        return "Basic salary must be less than or equal to company salary limit";
    }
    return null;
}

function validateOfferLetterAttachment(attachment) {
    if (!attachment) return "Salary letter is required";
    const hasDoc = Boolean(
        attachment?.url ||
        attachment?.data ||
        (typeof attachment === "string" && attachment.trim()),
    );
    if (!hasDoc) return "Salary letter is required";
    return null;
}

export function validateEmployeeSalaryHistoryEntry(entry = {}, { companySalaryLimit, requireOfferLetter = true } = {}) {
    const errors = [];
    if (!parseDate(entry.fromDate)) errors.push("For Month is required and must be a valid date");
    const basicErr = validateSalaryAmount(entry.basic ?? entry.monthlySalary, {
        required: true,
        label: "Basic salary",
        companySalaryLimit,
    });
    if (basicErr) errors.push(basicErr);

    for (const [field, label] of [
        ["houseRentAllowance", "Home rent allowance"],
        ["vehicleAllowance", "Vehicle allowance"],
        ["fuelAllowance", "Fuel allowance"],
        ["otherAllowance", "Other allowance"],
    ]) {
        const err = validateSalaryAmount(entry[field], { required: false, label });
        if (err) errors.push(err);
    }

    const total = [
        entry.basic ?? entry.monthlySalary,
        entry.houseRentAllowance,
        entry.vehicleAllowance,
        entry.fuelAllowance,
        entry.otherAllowance,
    ].reduce((sum, part) => {
        const num = parseFloat(String(part ?? "").trim());
        return sum + (Number.isFinite(num) ? num : 0);
    }, 0);
    if (!Number.isFinite(total) || total <= 0) errors.push("Total salary must be greater than 0");

    if (requireOfferLetter) {
        const letterErr = validateOfferLetterAttachment(entry.offerLetter);
        if (letterErr) errors.push(letterErr);
    }

    return errors;
}

export function findDuplicateSalaryMonth(salaryHistory = [], fromDate, excludeId = null) {
    const key = monthKeyFromDate(fromDate);
    if (!key) return false;
    return salaryHistory.some((entry) => {
        if (excludeId && entry?._id && String(entry._id) === String(excludeId)) return false;
        return monthKeyFromDate(entry?.fromDate) === key;
    });
}

export function validateSalaryHistoryNotEmpty(salaryHistory) {
    if (!Array.isArray(salaryHistory) || salaryHistory.length === 0) {
        return "At least one salary record is required";
    }
    return null;
}
