import EmployeeSalary from '../../models/EmployeeSalary.js';
import SalaryEnrollment from '../../models/SalaryEnrollment.js';
import SalaryMonthDmf from '../../models/SalaryMonthDmf.js';
import {
    approveCurrentDmfStep,
    buildDmfViewerContext,
    buildInitialDmf,
    dmfError,
    MONTH_SALARY_DMF_STEP_DEFS,
    rejectDmf,
    resolveDmfAssignees,
    serializeDmf,
    viewerCanActOnDmf,
} from '../../utils/salaryDmfApproval.js';
import { closeSalaryDmfInbox, notifySalaryDmfStep } from '../../utils/salaryDmfNotify.js';
import { syncSalaryDmfToZoho } from '../../utils/syncSalaryDmfToZoho.js';
import { notifySalaryMonthApprovedEmployees } from '../../utils/notifySalaryMonthApprovedEmployees.js';
import { monthPayrollIsClear } from './getSalaryRegister.js';

function actor(req) {
    return {
        id: req.user?.id || req.user?._id || null,
        name: req.user?.username || req.user?.name || req.user?.email || '',
        employeeId: req.user?.employeeId || '',
    };
}

function monthKeyOf(value) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    const iso = raw.match(/^(\d{4}-\d{2})/);
    return iso ? iso[1] : '';
}

function toYearMonth(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
    }
    return monthKeyOf(value);
}

function assertCanStart(dmf) {
    const status = String(dmf?.status || 'idle');
    if (status === 'pending') {
        throw dmfError(400, 'A DMF approval is already in progress.');
    }
    if (status === 'approved') {
        throw dmfError(400, 'This DMF is already approved.');
    }
}

async function persistAndNotify({
    req,
    doc,
    field,
    requestId,
    kind,
    employeeId,
    monthKey,
    subjectEmployee,
    who,
    nextStep,
    completed,
    zohoCompany,
    zohoBillNumber,
    zohoNotes,
}) {
    const dmf = doc[field];
    if (completed) {
        await syncSalaryDmfToZoho(dmf, {
            company: zohoCompany,
            billNumber: zohoBillNumber,
            notes: zohoNotes,
        });
        doc.markModified(field);
        await doc.save();
        await closeSalaryDmfInbox({
            requestId,
            status: 'Approved',
            actionedBy: who.id,
            comment: 'DMF approved — sent to Zoho Books',
        });
        if (kind === 'month' && monthKey) {
            void notifySalaryMonthApprovedEmployees({ monthKey }).catch((err) => {
                console.error('[notifySalaryMonthApprovedEmployees]', err?.message || err);
            });
        }
        return;
    }

    doc.markModified(field);
    await doc.save();
    await closeSalaryDmfInbox({
        requestId,
        status: 'Approved',
        actionedBy: who.id,
        comment: `Approved ${dmf.currentStepKey || ''}`.trim(),
    });
    if (nextStep) {
        await notifySalaryDmfStep({
            req,
            requestId,
            dmf,
            subjectEmployee,
            kind,
            employeeId,
            monthKey,
            requestedByName: who.name,
        });
    }
}

export async function startHistoricalSalaryDmf(req, res) {
    return res.status(400).json({
        message: 'Historical salary uses HR approval only.',
    });
}

export async function approveHistoricalSalaryDmf(req, res) {
    return res.status(400).json({
        message: 'Historical salary uses HR approval only.',
    });
}

export async function rejectHistoricalSalaryDmf(req, res) {
    return res.status(400).json({
        message: 'Historical salary uses HR approval only.',
    });
}

async function monthPayrollAmount(monthKey) {
    const enrollments = await SalaryEnrollment.find({})
        .select('employeeId fromMonth monthKey createdAt')
        .lean();
    const codes = [
        ...new Set(
            (enrollments || [])
                .filter((row) => {
                    const from =
                        toYearMonth(row.fromMonth) ||
                        toYearMonth(row.monthKey) ||
                        toYearMonth(row.createdAt);
                    return Boolean(from && from <= monthKey);
                })
                .map((row) => String(row.employeeId || '').trim())
                .filter(Boolean),
        ),
    ];
    if (!codes.length) return 0;
    const docs = await EmployeeSalary.find({ employeeId: { $in: codes } })
        .select('monthlySalary basic basicSalary')
        .lean();
    const total = (docs || []).reduce((sum, row) => {
        return sum + (Number(row.monthlySalary ?? row.basic ?? row.basicSalary) || 0);
    }, 0);
    return Number(total.toFixed(2));
}

async function serializeMonthDmfRow(req, doc, monthKey) {
    const ctx = await buildDmfViewerContext(req);
    return serializeDmf(doc?.dmfApproval, { ready: true, ctx: { ...ctx, monthKey } });
}

export async function getMonthSalaryDmf(req, res) {
    try {
        const monthKey = monthKeyOf(req.params?.monthKey);
        if (!monthKey) return res.status(400).json({ message: 'Invalid salary month.' });
        const doc = await SalaryMonthDmf.findOne({ monthKey });
        return res.status(200).json({ monthKey, dmf: await serializeMonthDmfRow(req, doc, monthKey) });
    } catch (error) {
        console.error('[getMonthSalaryDmf]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to load month DMF.',
        });
    }
}

export async function startMonthSalaryDmf(req, res) {
    try {
        const monthKey = monthKeyOf(req.params?.monthKey);
        if (!monthKey) return res.status(400).json({ message: 'Invalid salary month.' });

        if (!(await monthPayrollIsClear(monthKey))) {
            return res.status(400).json({
                message:
                    'Validate payroll to 100% before sending for Accounts → HR → Management approval.',
            });
        }

        let doc = await SalaryMonthDmf.findOne({ monthKey });
        if (!doc) {
            doc = new SalaryMonthDmf({ monthKey });
        }
        assertCanStart(doc.dmfApproval);

        const who = actor(req);
        const assignees = await resolveDmfAssignees({ req, subjectEmployee: null });
        const amount = await monthPayrollAmount(monthKey);
        doc.dmfApproval = buildInitialDmf({
            assignees,
            amount,
            billLabel: `Salary ${monthKey}`,
            actor: who,
            stepDefs: MONTH_SALARY_DMF_STEP_DEFS,
        });
        doc.markModified('dmfApproval');
        await doc.save();

        await notifySalaryDmfStep({
            req,
            requestId: doc._id,
            dmf: doc.dmfApproval,
            subjectEmployee: {
                employeeId: monthKey,
                firstName: monthKey,
                lastName: 'payroll',
            },
            kind: 'month',
            monthKey,
            requestedByName: who.name,
        });

        return res.status(200).json({ monthKey, dmf: await serializeMonthDmfRow(req, doc, monthKey) });
    } catch (error) {
        console.error('[startMonthSalaryDmf]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to start month approval.',
        });
    }
}

export async function approveMonthSalaryDmf(req, res) {
    try {
        const monthKey = monthKeyOf(req.params?.monthKey);
        if (!monthKey) return res.status(400).json({ message: 'Invalid salary month.' });

        const doc = await SalaryMonthDmf.findOne({ monthKey });
        if (!doc?.dmfApproval) {
            return res.status(404).json({ message: 'DMF approval was not found.' });
        }

        const ctx = await buildDmfViewerContext(req);
        if (!viewerCanActOnDmf(doc.dmfApproval, ctx)) {
            return res.status(403).json({ message: 'You are not the current DMF approver.' });
        }

        const who = actor(req);
        const { completed, nextStep } = approveCurrentDmfStep(doc.dmfApproval, {
            actor: who,
            comment: String(req.body?.comment || '').trim(),
        });

        await persistAndNotify({
            req,
            doc,
            field: 'dmfApproval',
            requestId: doc._id,
            kind: 'month',
            monthKey,
            subjectEmployee: {
                employeeId: monthKey,
                firstName: monthKey,
                lastName: 'payroll',
            },
            who,
            nextStep,
            completed,
            zohoBillNumber: `SAL-DMF-${monthKey}`,
            zohoNotes: `Salary month DMF — ${monthKey}`,
        });

        return res.status(200).json({ monthKey, dmf: await serializeMonthDmfRow(req, doc, monthKey) });
    } catch (error) {
        console.error('[approveMonthSalaryDmf]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to approve month DMF.',
        });
    }
}

export async function rejectMonthSalaryDmf(req, res) {
    try {
        const monthKey = monthKeyOf(req.params?.monthKey);
        if (!monthKey) return res.status(400).json({ message: 'Invalid salary month.' });

        const doc = await SalaryMonthDmf.findOne({ monthKey });
        if (!doc?.dmfApproval) {
            return res.status(404).json({ message: 'DMF approval was not found.' });
        }

        const ctx = await buildDmfViewerContext(req);
        if (!viewerCanActOnDmf(doc.dmfApproval, ctx)) {
            return res.status(403).json({ message: 'You are not the current DMF approver.' });
        }

        const who = actor(req);
        rejectDmf(doc.dmfApproval, {
            actor: who,
            reason: String(req.body?.reason || req.body?.comment || '').trim(),
        });
        doc.markModified('dmfApproval');
        await doc.save();
        await closeSalaryDmfInbox({
            requestId: doc._id,
            status: 'Rejected',
            actionedBy: who.id,
            comment: doc.dmfApproval.rejectReason,
        });

        return res.status(200).json({ monthKey, dmf: await serializeMonthDmfRow(req, doc, monthKey) });
    } catch (error) {
        console.error('[rejectMonthSalaryDmf]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to reject month DMF.',
        });
    }
}
