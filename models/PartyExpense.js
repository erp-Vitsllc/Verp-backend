import mongoose from 'mongoose';

/**
 * Extra payments owed by an employee or company (e.g. utility difference).
 * Permanent rows are written after Payments Made (Save as Paid).
 * Ledger debit = Paid Through COA; credit row is append-only (no delete).
 */
const ledgerEntrySchema = new mongoose.Schema(
    {
        side: { type: String, enum: ['debit', 'credit'], required: true },
        accountId: { type: String, default: '' },
        accountName: { type: String, default: '' },
        amount: { type: Number, required: true, min: 0 },
        notes: { type: String, default: '' },
        locked: { type: Boolean, default: true },
        createdAt: { type: Date, default: Date.now },
    },
    { _id: true },
);

const partyExpenseSchema = new mongoose.Schema(
    {
        partyType: {
            type: String,
            enum: ['employee', 'company'],
            required: true,
            index: true,
        },
        /** Business employeeId (e.g. VEGA-HR-0123) or company party placeholder */
        employeeId: { type: String, default: '', index: true },
        employeeName: { type: String, default: '' },
        /** Company mongo id or business companyId */
        companyId: { type: String, default: '', index: true },
        companyName: { type: String, default: '' },

        status: {
            type: String,
            enum: ['Not Paid', 'Paid'],
            default: 'Not Paid',
            index: true,
        },
        /**
         * balance = over-contract amount owed by Pay By party (employee/company profile).
         * Independent of vendor bill Paid status.
         */
        kind: {
            type: String,
            enum: ['balance', 'other', 'fine', 'loan', 'advance'],
            default: 'balance',
            index: true,
        },
        amount: { type: Number, required: true, min: 0 },
        currencyCode: { type: String, default: 'AED' },
        description: { type: String, default: '' },

        utilityBillId: { type: String, default: '', index: true },
        fineMongoId: { type: String, default: '', index: true },
        fineId: { type: String, default: '', index: true },
        loanMongoId: { type: String, default: '', index: true },
        loanId: { type: String, default: '', index: true },
        duration: { type: Number, default: null },
        monthStart: { type: String, default: '' },
        installments: [
            {
                index: { type: Number, default: 1 },
                monthKey: { type: String, default: '' },
                monthLabel: { type: String, default: '' },
                amount: { type: Number, default: 0 },
                status: {
                    type: String,
                    enum: ['Not Paid', 'Paid'],
                    default: 'Not Paid',
                },
            },
        ],
        utilityBatchId: { type: String, default: '' },
        accountNo: { type: String, default: '' },
        utilityType: { type: String, default: '' },
        billMonth: { type: String, default: '' },
        entryId: { type: String, default: '' },

        zohoBillId: { type: String, default: '' },
        zohoPaymentId: { type: String, default: '' },
        zohoPaymentNumber: { type: String, default: '' },
        zohoOrganizationId: { type: String, default: '' },
        zohoJournalId: { type: String, default: '' },

        paidThroughAccountId: { type: String, default: '' },
        paidThroughAccountName: { type: String, default: '' },
        /** Party Salary Payable COA selected by employee/company account code. */
        partyAccountId: { type: String, default: '' },
        partyAccountName: { type: String, default: '' },
        partyAccountCode: { type: String, default: '' },
        paymentMode: { type: String, default: '' },
        paidAt: { type: Date, default: null },

        /** ERP Accounts Payment _id when posted */
        erpPaymentId: { type: String, default: '' },

        ledger: { type: [ledgerEntrySchema], default: [] },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true },
);

partyExpenseSchema.index({ partyType: 1, employeeId: 1, status: 1 });
partyExpenseSchema.index({ partyType: 1, companyId: 1, status: 1 });
partyExpenseSchema.index(
    { utilityBillId: 1, partyType: 1, employeeId: 1, kind: 1 },
    { unique: true, partialFilterExpression: { utilityBillId: { $gt: '' } } },
);
partyExpenseSchema.index(
    { fineMongoId: 1, partyType: 1, employeeId: 1, kind: 1 },
    { unique: true, partialFilterExpression: { fineMongoId: { $gt: '' }, kind: 'fine' } },
);
partyExpenseSchema.index(
    { loanMongoId: 1, partyType: 1, employeeId: 1, kind: 1 },
    {
        unique: true,
        partialFilterExpression: {
            loanMongoId: { $gt: '' },
            kind: { $in: ['loan', 'advance'] },
        },
    },
);

export default mongoose.model('PartyExpense', partyExpenseSchema);
