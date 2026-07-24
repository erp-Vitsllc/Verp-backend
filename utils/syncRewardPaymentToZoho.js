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
    // Prefer Zoho Expense already posted at Accounts approve
    if (clean(reward?.zohoExpenseId)) {
        return {
            ok: true,
            skipped: true,
            expenseId: clean(reward.zohoExpenseId),
            message: 'Zoho Expense already posted at Accounts approval.',
        };
    }

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

/**
 * Cash/Gift Accounts approve → Zoho Books Expense.
 * Reference# + Notes = reward description (same pattern as Loan).
 */
export async function syncRewardApprovalToZohoExpense({ reward, employee } = {}) {
    if (!reward?._id) return { ok: false, message: 'Reward is required.' };

    const description = clean(
        reward.description ||
            reward.title ||
            reward.remarks ||
            `Reward ${clean(reward.rewardId)} · ${clean(reward.employeeId)}`,
    ).slice(0, 500);

    const { syncLoanPaymentToZohoExpense } = await import('./syncLoanPaymentToZohoExpense.js');
    return syncLoanPaymentToZohoExpense({
        payment: {
            amount: reward.amount,
            paymentDate: reward.awardedDate || reward.approvedDate || new Date(),
            notes: description,
        },
        loan: {
            _id: reward._id,
            loanId: reward.rewardId,
            employeeId: reward.employeeId,
            reason: description,
            description,
            amount: reward.amount,
            expenseAccountId: reward.expenseAccountId,
            expenseAccountName: reward.expenseAccountName,
            paidThroughAccountId: reward.paidThroughAccountId,
            paidThroughAccountName: reward.paidThroughAccountName,
            zohoOrganizationId: reward.zohoOrganizationId,
            zohoExpenseId: reward.zohoExpenseId,
            appliedDate: reward.awardedDate || reward.createdAt,
            attachment: reward.attachment,
            type: 'Reward',
        },
        employee: employee || reward.employeeId,
        organizationId: reward.zohoOrganizationId,
        expenseAccountId: reward.expenseAccountId,
        expenseAccountName: reward.expenseAccountName,
        paidThroughAccountId: reward.paidThroughAccountId,
        paidThroughAccountName: reward.paidThroughAccountName,
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
    // Accounts Paid → Zoho Books Expense (not journal)
    const { syncLoanPaymentToZohoExpense } = await import('./syncLoanPaymentToZohoExpense.js');
    return syncLoanPaymentToZohoExpense({
        payment,
        loan,
        employee,
        organizationId,
        expenseAccountId,
        expenseAccountName,
        paidThroughAccountId,
        paidThroughAccountName,
    });
}

/**
 * Utility employee over-contract balance payout → Zoho journal
 * (Debit expense · Credit Paid Through) on VEGA or NNIT.
 */
export async function syncUtilityEmployeePaymentToZoho({
    payment,
    employee,
    utilityBill = null,
    organizationId = '',
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
} = {}) {
    const accountNo = clean(utilityBill?.accountNo);
    const billMonth = clean(utilityBill?.billMonth);
    return syncStaffPayoutToZoho({
        payment,
        employee,
        organizationId,
        expenseAccountId,
        expenseAccountName,
        paidThroughAccountId,
        paidThroughAccountName,
        reference: clean(utilityBill?.billNumber || utilityBill?._id || payment?.referenceId),
        notes: `Utility balance · Acc ${accountNo} · ${billMonth}`.trim(),
        debitDescription: 'Utility balance expense',
    });
}
