import EmployeeBasic from '../models/EmployeeBasic.js';
import Company from '../models/Company.js';
import { createZohoJournal, getZohoOrganizationId } from '../services/zohoService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForCompany } from './resolveZohoOrganization.js';

function clean(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

/**
 * Infer VEGA vs NNIT Zoho org from employee id / company name when Company.zohoOrganizationId is unset.
 */
export async function resolveZohoOrganizationIdForRewardEmployee(employeeOrId) {
    let employee = employeeOrId;
    if (typeof employeeOrId === 'string') {
        employee = await EmployeeBasic.findOne({
            $or: [
                { employeeId: employeeOrId },
                ...( /^[0-9a-fA-F]{24}$/.test(employeeOrId) ? [{ _id: employeeOrId }] : []),
            ],
        })
            .select('employeeId company')
            .lean();
    }

    if (!employee) return getZohoOrganizationId();

    if (employee.company) {
        const fromCompany = await resolveZohoOrganizationIdForCompany(employee.company);
        if (fromCompany) return fromCompany;
    }

    const empId = clean(employee.employeeId).toUpperCase();
    const nnitEnv = clean(process.env.ZOHO_ORGANIZATION_ID_NNIT);
    if (nnitEnv && (/^NNIT[-_]/i.test(empId) || empId.includes('NNIT'))) {
        return nnitEnv;
    }

    if (employee.company) {
        const company = await Company.findById(employee.company).select('name nickName').lean();
        const hay = `${company?.name || ''} ${company?.nickName || ''}`.toLowerCase();
        if (nnitEnv && /nnit|neuron|nexus/.test(hay)) return nnitEnv;
    }

    return getZohoOrganizationId();
}

/**
 * Post staff payout (reward / loan / advance) to Zoho Books Chart of Accounts:
 * Debit expense account · Credit paid-through account.
 */
export async function syncStaffPayoutToZoho({
    payment,
    employee,
    organizationId = '',
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
    reference = '',
    notes = '',
    debitDescription = 'Expense',
} = {}) {
    const amount = money(payment?.amount);
    const debitId = clean(expenseAccountId);
    const creditId = clean(paidThroughAccountId);

    if (!payment || amount <= 0) {
        return { ok: false, message: 'Payment amount is required for Zoho.' };
    }
    if (!debitId || !creditId) {
        return {
            ok: false,
            message: 'Expense account and Paid Through (Chart of Accounts) are required for Zoho.',
        };
    }
    if (debitId === creditId) {
        return { ok: false, message: 'Expense account and Paid Through must be different accounts.' };
    }

    const orgId =
        clean(organizationId) ||
        (await resolveZohoOrganizationIdForRewardEmployee(employee));

    const date =
        payment.paymentDate instanceof Date
            ? payment.paymentDate.toISOString().slice(0, 10)
            : clean(payment.paymentDate) || new Date().toISOString().slice(0, 10);

    const ref = clean(reference || payment.referenceId || payment.paymentId);
    const journalNotes = clean(notes || payment.description || 'Staff payout');

    try {
        const journal = await withZohoOrganization(orgId, () =>
            createZohoJournal({
                journal_date: date,
                reference_number: ref || undefined,
                notes: journalNotes,
                line_items: [
                    {
                        account_id: debitId,
                        amount,
                        debit_or_credit: 'debit',
                        description: clean(expenseAccountName, debitDescription),
                    },
                    {
                        account_id: creditId,
                        amount,
                        debit_or_credit: 'credit',
                        description: clean(paidThroughAccountName, 'Paid Through'),
                    },
                ],
            }),
        );

        const journalId = clean(journal?.journal_id || journal?.journalId || journal?.id);
        return {
            ok: true,
            journalId,
            organizationId: orgId,
        };
    } catch (err) {
        const message = err?.message || 'Failed to post Zoho journal for payout';
        console.error('[StaffPayoutZoho]', message);
        return { ok: false, message, organizationId: orgId };
    }
}

/**
 * Post cash reward payout to Zoho Books Chart of Accounts:
 * Debit expense account · Credit paid-through account.
 */
export async function syncRewardPaymentToZoho({
    payment,
    reward,
    employee,
    organizationId = '',
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
} = {}) {
    return syncStaffPayoutToZoho({
        payment,
        employee: employee || reward?.employeeId,
        organizationId,
        expenseAccountId,
        expenseAccountName,
        paidThroughAccountId,
        paidThroughAccountName,
        reference: reward?.rewardId,
        notes: `Cash reward payment · ${reward?.title || ''} · ${reward?.employeeName || ''}`.trim(),
        debitDescription: 'Reward expense',
    });
}

export async function syncLoanPaymentToZoho({
    payment,
    loan,
    employee,
    organizationId = '',
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
} = {}) {
    const typeLabel = loan?.type === 'Advance' ? 'Advance' : 'Loan';
    return syncStaffPayoutToZoho({
        payment,
        employee: employee || loan?.employeeId,
        organizationId,
        expenseAccountId,
        expenseAccountName,
        paidThroughAccountId,
        paidThroughAccountName,
        reference: loan?.loanId,
        notes: `${typeLabel} payment · ${loan?.loanId || ''} · ${loan?.employeeId || ''}`.trim(),
        debitDescription: `${typeLabel} expense`,
    });
}
