import mongoose from 'mongoose';
import EmployeeBasic from '../models/EmployeeBasic.js';
import SalaryMonthDmf from '../models/SalaryMonthDmf.js';
import User from '../models/User.js';
import { resolveHandoverSignatureUrl } from './buildAssignmentHandoverEmailAttachments.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import { personDisplayName } from './salaryDmfApproval.js';
import { downloadS3ObjectBytes } from './s3Upload.js';

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

const signatureCache = new Map();
const SIGNATURE_CACHE_MS = 2 * 60 * 1000;

export function formatSalarySlipApprovalDate(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Payroll Officer uses the Accounts step date (that month's process completed).
 * HR and General Manager use the date each of them approved.
 * The employee box is filled only after the month payroll is approved, dated
 * with the General Manager's approval (the date the slip is issued).
 */
export function salarySlipApprovalRows({ steps = [], processed = false, people = {} } = {}) {
    const rows = STEP_BOXES.map((box) => {
        const step = (steps || []).find((row) => String(row?.key || '') === box.key);
        if (String(step?.status || '') !== 'approved') return { ...box };
        const person = people[box.key] || {};
        return {
            ...box,
            name: String(person.name || step.actionedByName || step.assignedTo?.name || '').trim(),
            date: formatSalarySlipApprovalDate(step.actionedAt),
            signatureUrl: String(person.signatureUrl || '').trim(),
        };
    });

    const employeeBox = { ...DEFAULT_APPROVERS[3] };
    if (!processed) return [...rows, employeeBox];

    const management = (steps || []).find((row) => String(row?.key || '') === 'management');
    const employee = people.employee || {};
    return [
        ...rows,
        {
            ...employeeBox,
            name: String(employee.name || '').trim(),
            date: formatSalarySlipApprovalDate(management?.actionedAt),
            signatureUrl: String(employee.signatureUrl || '').trim(),
        },
    ];
}

async function loadEmployee(ref) {
    if (!ref) return null;
    if (typeof ref === 'object' && ref.signature && (ref.signature.url || ref.signature.publicId || ref.signature.data)) {
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

async function employeeForStep(step) {
    if (step?.actionedByUserId && mongoose.Types.ObjectId.isValid(String(step.actionedByUserId))) {
        const user = await User.findById(step.actionedByUserId).select('employeeId').lean();
        const linked = await loadEmployee(user?.employeeId);
        if (linked) return linked;
    }
    return loadEmployee(step?.assignedTo);
}

async function signatureDataUrl(emp) {
    const sig = emp?.signature;
    if (!sig) return '';
    if (typeof sig === 'string' && sig.startsWith('data:')) return sig;
    const keyOrUrl = sig.publicId || sig.url || sig.data || sig.path;
    if (!keyOrUrl) return '';
    if (String(keyOrUrl).startsWith('data:')) return String(keyOrUrl);
    const bytes = await downloadS3ObjectBytes(keyOrUrl);
    if (bytes?.length) {
        const mime = sig.mimeType || 'image/png';
        return `data:${mime};base64,${bytes.toString('base64')}`;
    }
    const signed = await resolveHandoverSignatureUrl(sig, emailFrontendUrl());
    return signed || '';
}

async function cachedSignatureUrl(emp) {
    const key = String(emp?._id || emp?.employeeId || '').trim();
    if (!key) return signatureDataUrl(emp);
    const hit = signatureCache.get(key);
    if (hit && Date.now() - hit.at < SIGNATURE_CACHE_MS) return hit.url;
    const url = await signatureDataUrl(emp);
    signatureCache.set(key, { at: Date.now(), url });
    return url;
}

async function personFields(emp, embedSignatures) {
    return {
        name: personDisplayName(emp),
        signatureUrl: embedSignatures && emp ? await cachedSignatureUrl(emp) : '',
    };
}

/**
 * Fill salary-slip APPROVAL & ACKNOWLEDGEMENT from the month payroll
 * (Accounts → HR → General Manager) and the employee.
 */
export async function resolveSalarySlipApprovers({
    monthKey,
    employeeId,
    embedSignatures = false,
} = {}) {
    try {
        const ym = String(monthKey || '').trim();
        if (!ym) return DEFAULT_APPROVERS.map((row) => ({ ...row }));

        const doc = await SalaryMonthDmf.findOne({ monthKey: ym }).select('dmfApproval').lean();
        const dmf = doc?.dmfApproval;
        const steps = Array.isArray(dmf?.steps) ? dmf.steps : [];
        const processed = String(dmf?.status || '') === 'approved';

        const people = {};
        await Promise.all(
            STEP_BOXES.map(async (box) => {
                const step = steps.find((row) => String(row?.key || '') === box.key);
                if (String(step?.status || '') !== 'approved') return;
                const emp = await employeeForStep(step);
                people[box.key] = await personFields(emp, embedSignatures);
            }),
        );

        if (processed && employeeId) {
            const emp = await loadEmployee({ employeeId });
            people.employee = await personFields(emp, embedSignatures);
        }

        return salarySlipApprovalRows({ steps, processed, people });
    } catch (error) {
        console.error('[resolveSalarySlipApprovers]', error?.message || error);
        return DEFAULT_APPROVERS.map((row) => ({ ...row }));
    }
}
