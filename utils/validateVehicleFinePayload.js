/** Server-side validation for Violation → Vehicle Fine */

const LIMITS = {
    maxFineAmount: 999999.99,
    minFineAmount: 0.01,
    maxServiceCharge: 999999.99,
    minDescriptionLength: 10,
    maxDescriptionLength: 2000,
    minCompanyDescriptionLength: 10,
    maxCompanyDescriptionLength: 1000,
    payableDurationMin: 1,
    payableDurationMax: 6,
};

const PLACEHOLDER_VEHICLE = /^test-v\d*$/i;

function parseMoney(value) {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function hasAtMostTwoDecimals(value) {
    const s = String(value).trim();
    if (!s.includes('.')) return true;
    return s.split('.')[1].length <= 2;
}

function isMeaningfulText(value, minLen) {
    const t = String(value || '').trim();
    if (t.length < minLen) return false;
    return /[a-zA-Z0-9\u0600-\u06FF]/.test(t);
}

function validateMonthStart(yyyyMM, { required }) {
    const raw = String(yyyyMM || '').trim();
    if (!raw) return required ? 'Month start is required' : null;
    if (!/^\d{4}-\d{2}$/.test(raw)) return 'Month start must be YYYY-MM';
    const [y, m] = raw.split('-').map(Number);
    if (m < 1 || m > 12) return 'Invalid month';
    const start = new Date(y, m - 1, 1);
    const now = new Date();
    const earliest = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    const latest = new Date(now.getFullYear(), now.getMonth() + 3, 1);
    if (start < earliest) return 'Month start cannot be more than 12 months in the past';
    if (start > latest) return 'Month start cannot be more than 3 months in the future';
    return null;
}

/**
 * @param {object} body - req.body (common fine fields)
 * @param {{ mode?: 'draft'|'strict', hasExistingAttachment?: boolean }} options
 * @returns {{ valid: boolean, message?: string, errors?: Record<string,string> }}
 */
export function validateVehicleFinePayload(body, options = {}) {
    const { mode = 'strict', hasExistingAttachment = false } = options;
    const isDraft = mode === 'draft';
    const errors = {};

    const vehicleId = String(body.vehicleId || '').trim();
    const responsibleFor = String(body.responsibleFor || 'Employee').trim();
    const companyId = String(body.company || body.companyId || '').trim();

    const employeeId =
        String(body.employeeId || '').trim() ||
        (Array.isArray(body.employees) && body.employees.find((e) => e?.employeeId && e.employeeId !== 'VEGA-HR-0000')?.employeeId) ||
        '';

    if (!vehicleId) errors.vehicleId = 'Vehicle is required';
    else if (PLACEHOLDER_VEHICLE.test(vehicleId)) errors.vehicleId = 'Invalid vehicle';

    if (!employeeId && !isDraft) errors.employeeId = 'Employee is required';

    const total = parseMoney(body.fineAmount);
    const serviceCharge = parseMoney(body.serviceCharge) ?? 0;

    if (!isDraft && (body.fineAmount === '' || body.fineAmount == null)) {
        errors.fineAmount = 'Total fine amount is required';
    } else if (body.fineAmount != null && body.fineAmount !== '' && !hasAtMostTwoDecimals(body.fineAmount)) {
        errors.fineAmount = 'Amount can have at most 2 decimal places';
    } else if (total !== null && total < LIMITS.minFineAmount) {
        errors.fineAmount = `Total fine amount must be at least AED ${LIMITS.minFineAmount}`;
    } else if (total !== null && total > LIMITS.maxFineAmount) {
        errors.fineAmount = 'Total fine amount exceeds maximum allowed';
    }

    if (body.serviceCharge != null && body.serviceCharge !== '') {
        if (!hasAtMostTwoDecimals(body.serviceCharge)) errors.serviceCharge = 'Invalid service charge';
        else if (serviceCharge < 0) errors.serviceCharge = 'Service charge cannot be negative';
        else if (total !== null && serviceCharge > total) errors.serviceCharge = 'Service charge cannot exceed total fine amount';
    }

    if (responsibleFor === 'Employee & Company') {
        let empAmt = parseMoney(body.employeeAmount);
        let compAmt = parseMoney(body.companyAmount);

        // Recover from party rows when top-level amounts are missing/zero (common on group siblings)
        const employees = Array.isArray(body.employees) ? body.employees : [];
        const companyRow = employees.find((e) => e?.employeeId === 'VEGA-HR-0000');
        const empRows = employees.filter(
            (e) => e?.employeeId && e.employeeId !== 'VEGA-HR-0000' && e.employeeId !== 'VEGA_INTERNAL',
        );
        if ((compAmt === null || compAmt < LIMITS.minFineAmount) && companyRow) {
            const fromBase = parseMoney(companyRow.employeeAmount);
            const fromPayable = parseMoney(companyRow.individualAmount ?? companyRow.fineAmount);
            if (fromBase !== null && fromBase >= LIMITS.minFineAmount) compAmt = fromBase;
            else if (fromPayable !== null && serviceCharge > 0 && fromPayable > serviceCharge) {
                // Payable stored — approximate base by stripping an equal SC share
                const parties = Math.max(2, empRows.length + 1);
                compAmt = Math.max(0, fromPayable - serviceCharge / parties);
            } else if (fromPayable !== null) {
                compAmt = fromPayable;
            }
        }
        if ((empAmt === null || empAmt < LIMITS.minFineAmount) && empRows.length > 0) {
            const sumBase = empRows.reduce((s, e) => s + (parseMoney(e.employeeAmount) || 0), 0);
            if (sumBase >= LIMITS.minFineAmount) empAmt = sumBase;
        }

        if (!isDraft) {
            if (empAmt === null || empAmt < LIMITS.minFineAmount) errors.employeeAmount = 'Invalid employee amount';
            if (compAmt === null || compAmt < LIMITS.minFineAmount) errors.companyAmount = 'Invalid company amount';
            if (total !== null && empAmt !== null && compAmt !== null) {
                const asBasesPlusSc = Math.abs(empAmt + compAmt + serviceCharge - total) <= 0.02;
                const asBasesOnly = Math.abs(empAmt + compAmt - Math.max(0, total - serviceCharge)) <= 0.02;
                const asPayables = Math.abs(empAmt + compAmt - total) <= 0.02;
                if (!asBasesPlusSc && !asBasesOnly && !asPayables) {
                    errors.amountMismatch = 'Split amounts must equal total fine amount';
                }
            }
        }
    }

    const desc = String(body.description || '');
    if (!isDraft) {
        if (!isMeaningfulText(desc, LIMITS.minDescriptionLength)) {
            errors.description = 'Description is required';
        } else if (desc.trim().length > LIMITS.maxDescriptionLength) {
            errors.description = 'Description is too long';
        }
    }

    const needsCompany = responsibleFor === 'Company' || responsibleFor === 'Employee & Company';
    if (needsCompany && !isDraft && !companyId) errors.company = 'Company is required';
    if (needsCompany && !isDraft) {
        const compDesc = String(body.companyDescription || '');
        if (!isMeaningfulText(compDesc, LIMITS.minCompanyDescriptionLength)) {
            errors.companyDescription = 'Company description is required';
        }
    }

    if (responsibleFor !== 'Company' && !isDraft) {
        const duration = parseInt(String(body.payableDuration || ''), 10);
        if (!Number.isFinite(duration) || duration < LIMITS.payableDurationMin || duration > LIMITS.payableDurationMax) {
            errors.payableDuration = 'Invalid payable duration';
        }
    }

    const monthErr = validateMonthStart(body.monthStart, {
        required: !isDraft && responsibleFor !== 'Company',
    });
    if (monthErr) errors.monthStart = monthErr;

    const hasAttachment =
        hasExistingAttachment ||
        (body.attachment && (body.attachment.data || body.attachment.url)) ||
        (Array.isArray(body.attachments) &&
            body.attachments.some((item) => item?.data || item?.url || item?.publicId));
    if (!hasAttachment) errors.attachment = 'Supporting document is required';

    if (Object.keys(errors).length === 0) return { valid: true };

    const first = Object.values(errors)[0];
    return { valid: false, message: first, errors };
}

export function isVehicleFinePayload(body) {
    const ft = String(body?.fineType || '').trim();
    const sub = String(body?.subCategory || '').trim();
    return (
        ft === 'Vehicle Fine' ||
        sub === 'Vehicle Fine' ||
        ft === 'Vehicle Damage' ||
        sub === 'Vehicle Damage'
    );
}
