import EmployeeBasic from '../../models/EmployeeBasic.js';
import PayrollSettings from '../../models/PayrollSettings.js';
import SalaryEnrollment from '../../models/SalaryEnrollment.js';
import SalaryHistoricalProfile from '../../models/SalaryHistoricalProfile.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../../utils/attendanceEmployeeFilters.js';
import { normalizeStaffTypeKey } from '../../utils/workLocationHelpers.js';
import {
    buildPayrollPolicyPayload,
    serializePayrollSettings,
    resolvePolicyAttachment,
    requireMainSalaryPolicy,
    isMainSalaryPolicyConfigured,
} from './payrollSettingsController.js';

const YEAR_MONTH = /^\d{4}-\d{2}$/;

function toMonthDay(value) {
    if (value === '' || value == null) return '';
    const s = String(value).trim();
    const iso = s.match(/^\d{4}-\d{2}-(\d{2})/);
    const n = iso ? Number(iso[1]) : Number(s);
    if (!Number.isInteger(n) || n < 1) return '';
    return String(Math.min(28, n));
}

function serializeEnrollment(doc, { includePolicy = true } = {}) {
    const row = {
        employeeId: String(doc?.employeeId || '').trim(),
        fromMonth: String(doc?.fromMonth || '').trim(),
        salaryDate: toMonthDay(doc?.salaryDate),
        processDate: toMonthDay(doc?.processDate),
    };
    if (!includePolicy) return row;
    return { ...row, policy: serializePayrollSettings(doc?.policy) };
}

async function policyCopyForEmployee(employee, salaryDay) {
    const staffType = normalizeStaffTypeKey(employee?.staffType);
    const group = staffType
        ? await PayrollSettings.findOne({ key: `group:${staffType}` }).lean()
        : null;
    const base = group || (await PayrollSettings.findOne({ key: 'default' }).lean());
    const policy = serializePayrollSettings(base);
    if (salaryDay) policy.salaryProcessingDate = salaryDay;
    return policy;
}

export async function getSalaryEnrollOptions(req, res) {
    try {
        const [employeeRows, enrollmentDocs, profileDocs, mainPolicy] = await Promise.all([
            EmployeeBasic.find({
                employeeId: { $nin: ['', 'VEGA-HR-0000'] },
                status: { $ne: 'Left User' },
                ...REAL_EMPLOYEE_MONGO_FILTER,
            })
                .select('employeeId firstName lastName staffType')
                .sort({ firstName: 1, lastName: 1 })
                .lean()
                .maxTimeMS(12000),
            SalaryEnrollment.find({}).select('employeeId fromMonth salaryDate processDate').lean().maxTimeMS(8000),
            SalaryHistoricalProfile.find({})
                .select('employeeId verpStartDate companyMolCode workflowStatus')
                .lean()
                .maxTimeMS(8000),
            PayrollSettings.findOne({ key: 'default' }).select('_id').lean().maxTimeMS(8000),
        ]);

        const enrollmentByKey = new Map();
        const molByKey = new Map();
        for (const row of enrollmentDocs || []) {
            const key = String(row.employeeId || '').trim().replace(/\s+/g, '').toUpperCase();
            if (!key) continue;
            enrollmentByKey.set(key, {
                ...row,
                fromMonth: String(row.fromMonth || '').trim(),
            });
        }
        for (const row of profileDocs || []) {
            const key = String(row.employeeId || '').trim().replace(/\s+/g, '').toUpperCase();
            if (!key) continue;
            const mol = String(row.companyMolCode || '').trim();
            if (mol && !molByKey.has(key)) molByKey.set(key, mol);
            const verpMonth = String(row.verpStartDate || '').slice(0, 7);
            const prev = enrollmentByKey.get(key);
            if (prev && /^\d{4}-\d{2}$/.test(verpMonth)) {
                enrollmentByKey.set(key, { ...prev, fromMonth: verpMonth });
                continue;
            }
            if (String(row.workflowStatus || '') === 'locked' && !prev) {
                enrollmentByKey.set(key, {
                    ...row,
                    fromMonth: verpMonth,
                });
            }
        }

        const employees = (employeeRows || [])
            .filter((emp) => emp?.employeeId && !isCompanyShellEmployee(emp))
            .map((emp) => {
                const employeeId = String(emp.employeeId).trim();
                const key = employeeId.replace(/\s+/g, '').toUpperCase();
                const enrollment = enrollmentByKey.get(key);
                const enrolled = Boolean(enrollment);
                const companyMolCode = enrolled ? molByKey.get(key) || '' : '';
                return {
                    employeeId,
                    firstName: emp.firstName || '',
                    lastName: emp.lastName || '',
                    name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || employeeId,
                    staffType: normalizeStaffTypeKey(emp.staffType),
                    enrolled,
                    fromMonth: String(enrollment?.fromMonth || '').trim(),
                    salaryDate: toMonthDay(enrollment?.salaryDate),
                    salaryType: enrolled ? (companyMolCode ? 'WPS' : 'Cash') : '',
                };
            });

        const enrollments = (enrollmentDocs || []).map((row) =>
            serializeEnrollment(row, { includePolicy: false }),
        );
        const enrolledIds = employees.filter((row) => row.enrolled).map((row) => row.employeeId);

        return res.status(200).json({
            employees,
            enrolledIds,
            enrollments,
            mainPolicyConfigured: isMainSalaryPolicyConfigured(mainPolicy),
        });
    } catch (error) {
        console.error('[getSalaryEnrollOptions]', error);
        return res.status(500).json({ message: error.message || 'Failed to load enroll options.' });
    }
}

export async function createSalaryEnrollment(req, res) {
    try {
        const employeeId = String(req.body?.employeeId || '').trim();
        const salaryDay = toMonthDay(req.body?.salaryDate);
        const requestedMonth = String(req.body?.fromMonth || '').trim();
        const now = new Date();
        const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const fromMonth = YEAR_MONTH.test(requestedMonth) ? requestedMonth : currentYm;

        if (!employeeId) {
            return res.status(400).json({ message: 'Select an employee to enroll.' });
        }
        if (!salaryDay) {
            return res.status(400).json({ message: 'Salary day is required (1–28).' });
        }

        await requireMainSalaryPolicy();

        const employee = await EmployeeBasic.findOne({ employeeId }).select('employeeId firstName lastName status staffType').lean();
        if (!employee || isCompanyShellEmployee(employee)) {
            return res.status(404).json({ message: 'Employee not found.' });
        }
        if (String(employee.status || '') === 'Left User') {
            return res.status(400).json({ message: 'Left users cannot be enrolled to salary.' });
        }

        const existing = await SalaryEnrollment.findOne({ employeeId }).lean();
        if (existing) {
            return res.status(409).json({ message: 'This employee is already enrolled.' });
        }

        const policy = await policyCopyForEmployee(employee, salaryDay);
        const doc = await SalaryEnrollment.create({
            employeeId,
            fromMonth,
            salaryDate: salaryDay,
            processDate: salaryDay,
            policy,
            enrolledBy: req.user?.id || null,
        });

        return res.status(201).json({
            message: 'Employee enrolled to salary.',
            enrollment: serializeEnrollment(doc),
        });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ message: 'This employee is already enrolled.' });
        }
        console.error('[createSalaryEnrollment]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to enroll employee.',
        });
    }
}

export async function updateSalaryEnrollmentPolicy(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) {
            return res.status(400).json({ message: 'Employee is required.' });
        }

        const doc = await SalaryEnrollment.findOne({ employeeId });
        if (!doc) {
            return res.status(404).json({ message: 'This employee is not enrolled to salary.' });
        }

        const existingPolicy = doc.policy && typeof doc.policy === 'object' ? doc.policy : {};
        const built = buildPayrollPolicyPayload(req.body || {}, existingPolicy);
        const attachment = await resolvePolicyAttachment(
            req.body?.attachment,
            existingPolicy?.attachment,
            `salary-policy/${employeeId}`,
        );
        const policy = serializePayrollSettings({ ...built, attachment });
        const salaryDay = toMonthDay(policy.salaryProcessingDate) || toMonthDay(doc.salaryDate);

        doc.policy = policy;
        if (salaryDay) {
            doc.salaryDate = salaryDay;
            doc.processDate = salaryDay;
            policy.salaryProcessingDate = salaryDay;
            doc.policy = policy;
        }
        await doc.save();

        return res.status(200).json({
            message: 'Employee salary policy updated.',
            enrollment: serializeEnrollment(doc),
        });
    } catch (error) {
        console.error('[updateSalaryEnrollmentPolicy]', error);
        return res.status(500).json({ message: error.message || 'Failed to update employee salary policy.' });
    }
}

export async function getSalaryEnrollmentPolicy(req, res) {
    try {
        const employeeId = String(req.params?.employeeId || '').trim();
        if (!employeeId) {
            return res.status(400).json({ message: 'Employee is required.' });
        }

        const doc = await SalaryEnrollment.findOne({ employeeId }).lean();
        if (!doc) {
            return res.status(404).json({ message: 'This employee is not enrolled to salary.' });
        }

        const stored = doc.policy && typeof doc.policy === 'object' ? doc.policy : null;
        let policy = stored ? serializePayrollSettings(stored) : null;
        if (!policy) {
            const employee = await EmployeeBasic.findOne({ employeeId }).select('staffType').lean();
            policy = await policyCopyForEmployee(employee, doc.salaryDate || doc.processDate);
        }

        return res.status(200).json({
            employeeId,
            fromMonth: String(doc.fromMonth || '').trim(),
            ...policy,
        });
    } catch (error) {
        console.error('[getSalaryEnrollmentPolicy]', error);
        return res.status(500).json({ message: error.message || 'Failed to load employee salary policy.' });
    }
}
