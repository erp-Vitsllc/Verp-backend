import PartyExpense from '../models/PartyExpense.js';

function clean(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function parseMonthStart(monthStart) {
    const raw = clean(monthStart);
    if (/^\d{4}-\d{2}$/.test(raw)) {
        const [y, m] = raw.split('-').map(Number);
        return new Date(y, m - 1, 1);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const d = new Date(raw);
        if (!Number.isNaN(d.getTime())) return new Date(d.getFullYear(), d.getMonth(), 1);
    }
    return null;
}

/**
 * Build equal monthly installment parts for a loan/advance (last month gets remainder).
 */
export function buildLoanInstallments(loan) {
    const total = money(loan?.amount);
    const duration = Math.max(1, Number(loan?.duration) || 1);
    if (total <= 0) return [];

    const start = parseMonthStart(loan?.monthStart || loan?.originalMonthStart);
    const base = Number((total / duration).toFixed(2));
    const rows = [];
    let allocated = 0;

    for (let i = 0; i < duration; i += 1) {
        let amount = i === duration - 1 ? money(total - allocated) : base;
        allocated = money(allocated + amount);

        let monthKey = '';
        let monthLabel = `Part ${i + 1}`;
        if (start) {
            const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
            monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            monthLabel = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        }

        rows.push({
            index: i + 1,
            monthKey,
            monthLabel,
            amount,
            status: 'Not Paid',
        });
    }

    return rows;
}

/**
 * After Accounts pays a loan/advance (Zoho COA credit): store employee expense with duration parts.
 */
export async function upsertLoanPartyExpenseFromPayment({
    loan,
    payment,
    employee,
    zohoResult = {},
    userId = null,
} = {}) {
    if (!loan?._id) throw new Error('Loan is required.');

    const kind = loan.type === 'Advance' ? 'advance' : 'loan';
    const loanMongoId = String(loan._id);
    const employeeId = clean(loan.employeeId || employee?.employeeId);
    const employeeName = clean(
        employee
            ? `${employee.firstName || ''} ${employee.lastName || ''}`.trim()
            : '',
    );
    const installments = buildLoanInstallments(loan);
    const total = money(loan.amount);

    let doc = await PartyExpense.findOne({
        loanMongoId,
        kind,
        partyType: 'employee',
        employeeId,
    });

    if (!doc) {
        doc = new PartyExpense({
            partyType: 'employee',
            kind,
            employeeId,
            employeeName,
            loanMongoId,
            loanId: clean(loan.loanId),
            createdBy: userId || null,
            ledger: [],
        });
    }

    doc.amount = total;
    doc.duration = Math.max(1, Number(loan.duration) || 1);
    doc.monthStart = clean(loan.monthStart || loan.originalMonthStart);
    doc.installments = installments;
    doc.description =
        doc.description ||
        `${kind === 'advance' ? 'Advance' : 'Loan'} ${clean(loan.loanId)} · ${doc.duration} month(s) · AED ${total.toFixed(2)}`;
    doc.zohoOrganizationId = clean(zohoResult.organizationId || payment?.zohoOrganizationId);
    doc.zohoJournalId = clean(zohoResult.journalId || payment?.zohoJournalId);
    doc.paidThroughAccountId = clean(payment?.paidThroughAccountId);
    doc.paidThroughAccountName = clean(payment?.paidThroughAccountName);
    doc.paymentMode = clean(payment?.paymentSource);
    doc.erpPaymentId = clean(payment?._id?.toString?.() || payment?._id);
    doc.currencyCode = 'AED';

    // Company disbursement posted — employee schedule remains Not Paid until recovered.
    const remaining = Math.max(0, total - money(loan.paidAmount));
    doc.status = remaining <= 0.01 ? 'Paid' : 'Not Paid';
    if (doc.status === 'Paid') {
        doc.paidAt = new Date();
        doc.installments = installments.map((row) => ({ ...row, status: 'Paid' }));
    }

    await doc.save();
    return doc;
}
