import mongoose from 'mongoose';
import EmployeeBasic from '../models/EmployeeBasic.js';
import SalaryMonthDmf from '../models/SalaryMonthDmf.js';
import User from '../models/User.js';
import { resolveHandoverSignatureUrl } from './buildAssignmentHandoverEmailAttachments.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { personDisplayName } from './salaryDmfApproval.js';

const DEFAULT_APPROVERS = [
    { role: 'CREATED BY', title: 'Payroll Officer' },
    { role: 'APPROVED BY', title: 'HR Manager' },
    { role: 'AUTHORIZED BY', title: 'General Manager' },
    { role: 'RECEIVED BY', title: 'Employee' },
];

const STEP_BOXES = [
    { key: 'accounts', role: 'CREATED BY', title: 'Payroll Officer' },
    { key: 'hr', role: 'APPROVED BY', title: 'HR Manager' },
    { key: 'management', role: 'AUTHORIZED BY', title: 'General Manager' },
];

function formatSlipDate(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function loadEmployee(ref) {
    if (!ref) return null;
    if (typeof ref === 'object' && ref.signature && (ref.signature.url || ref.signature.data)) {
        return ref;
    }
    const objectId = typeof ref === 'object' ? ref._id || ref.employeeObjectId : null;
    if (objectId && mongoose.Types.ObjectId.isValid(String(objectId))) {
        const byId = await EmployeeBasic.findById(objectId)
            .select('firstName lastName employeeId signature')
            .lean();
        if (byId) return byId;
    }
    const code = String(typeof ref === 'object' ? ref.employeeId : ref || '').trim();
    if (!code) return null;
    return EmployeeBasic.findOne({ employeeId: code })
        .select('firstName lastName employeeId signature')
        .lean();
}

async function loadSigner(step) {
    if (step?.actionedByUserId) {
        const user = await User.findById(step.actionedByUserId)
            .select('employeeId employeeObjectId empObjectId')
            .lean();
        const emp = await loadEmployee({
            _id: user?.employeeObjectId || user?.empObjectId || null,
            employeeId: user?.employeeId || '',
        });
        if (emp) return emp;
    }
    return loadEmployee(step?.assignedTo);
}

async function withSignature(box, emp, date, fallbackName = '') {
    const fe = emailFrontendUrl();
    const signatureUrl = emp?.signature ? await resolveHandoverSignatureUrl(emp.signature, fe) : '';
    return {
        ...box,
        name: personDisplayName(emp) || fallbackName,
        date: formatSlipDate(date),
        signatureUrl: signatureUrl || '',
    };
}

/**
 * Fill salary-slip APPROVAL & ACKNOWLEDGEMENT boxes from Process salary
 * (Accounts → HR → Management) plus the employee when the month is Processed.
 */
export async function resolveSalarySlipApprovers({ monthKey, employeeId } = {}) {
    try {
        const ym = String(monthKey || '').trim();
        if (!ym) return DEFAULT_APPROVERS.map((row) => ({ ...row }));

        const doc = await SalaryMonthDmf.findOne({ monthKey: ym }).select('dmfApproval').lean();
        const dmf = doc?.dmfApproval;
        const steps = Array.isArray(dmf?.steps) ? dmf.steps : [];
        const processed = String(dmf?.status || '') === 'approved';

        const signed = await Promise.all(
            STEP_BOXES.map(async (box) => {
                const step = steps.find((row) => String(row.key || '') === box.key);
                if (String(step?.status || '') !== 'approved') {
                    return { ...box };
                }
                const emp = await loadSigner(step);
                return withSignature(
                    box,
                    emp,
                    step.actionedAt,
                    step.actionedByName || step.assignedTo?.name || '',
                );
            }),
        );

        let employeeBox = { ...DEFAULT_APPROVERS[3] };
        if (processed && employeeId) {
            const emp = await loadEmployee({ employeeId });
            const management = steps.find((row) => row.key === 'management');
            employeeBox = await withSignature(
                employeeBox,
                emp,
                management?.actionedAt || dmf?.submittedAt,
                personDisplayName(emp),
            );
        }

        return [...signed, employeeBox];
    } catch (error) {
        console.error('[resolveSalarySlipApprovers]', error?.message || error);
        return DEFAULT_APPROVERS.map((row) => ({ ...row }));
    }
}
