import PayrollSettings from '../../models/PayrollSettings.js';

const DEFAULT_RULES = {
    allAttendanceMarked: false,
    allPendingApprovalsCompleted: false,
    overtimeApprovedByHr: false,
    overtimeApprovedByHod: false,
    allSickLeaveApproval: false,
    allAuthorizedLeaves: false,
    allUnauthorizedLeave: false,
    fine: false,
    reward: false,
    ncr: false,
    loan: false,
    advance: false,
    utilityBillExcess: false,
    salaryProcessReminderToAccounts: false,
    otherDeptHodsPendingApproval: false,
};

function toDays(value) {
    if (value === '' || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function serialize(doc) {
    const rules = { ...DEFAULT_RULES, ...(doc?.processingRules?.toObject?.() || doc?.processingRules || {}) };
    return {
        salaryProcessingDate: doc?.salaryProcessingDate || '',
        salaryProcessStartMonth: doc?.salaryProcessStartMonth || '',
        salaryCutoffDate: doc?.salaryCutoffDate || '',
        processingRules: rules,
        workingDaysRequiredToEligible: doc?.workingDaysRequiredToEligible ?? null,
        leaveSalaryWorkingDays: doc?.leaveSalaryWorkingDays ?? null,
        workingDaysRequiredForAirTicket: doc?.workingDaysRequiredForAirTicket ?? null,
    };
}

export async function getPayrollSettings(req, res) {
    try {
        const doc = await PayrollSettings.findOne({ key: 'default' }).lean();
        return res.status(200).json(serialize(doc));
    } catch (error) {
        console.error('[getPayrollSettings]', error);
        return res.status(500).json({ message: error.message || 'Failed to load payroll settings.' });
    }
}

export async function savePayrollSettings(req, res) {
    try {
        const body = req.body || {};
        const processingRules = { ...DEFAULT_RULES };
        const incoming = body.processingRules && typeof body.processingRules === 'object' ? body.processingRules : {};
        Object.keys(DEFAULT_RULES).forEach((key) => {
            processingRules[key] = Boolean(incoming[key]);
        });

        const payload = {
            key: 'default',
            salaryProcessingDate: String(body.salaryProcessingDate || '').trim(),
            salaryProcessStartMonth: String(body.salaryProcessStartMonth || '').trim(),
            salaryCutoffDate: String(body.salaryCutoffDate || '').trim(),
            processingRules,
            workingDaysRequiredToEligible: toDays(body.workingDaysRequiredToEligible),
            leaveSalaryWorkingDays: toDays(body.leaveSalaryWorkingDays),
            workingDaysRequiredForAirTicket: toDays(body.workingDaysRequiredForAirTicket),
            updatedBy: req.user?.id || null,
        };

        const doc = await PayrollSettings.findOneAndUpdate(
            { key: 'default' },
            { $set: payload },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        return res.status(200).json({
            message: 'Payroll settings saved.',
            ...serialize(doc),
        });
    } catch (error) {
        console.error('[savePayrollSettings]', error);
        return res.status(500).json({ message: error.message || 'Failed to save payroll settings.' });
    }
}
