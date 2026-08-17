import mongoose from 'mongoose';

const utilityBillPaymentSchema = new mongoose.Schema(
    {
        entryId: { type: String, required: true, index: true },
        utilityType: { type: String, required: true, trim: true },
        amount: { type: Number, required: true, min: 0 },
        monthlyRental: { type: Number, default: 0, min: 0 },
        billMonth: { type: String, default: '' },
        notes: { type: String, default: '' },
        accountNo: { type: String, default: '' },
        differenceAmount: { type: Number, default: 0 },
        attachment: {
            name: { type: String, default: '' },
            mime: { type: String, default: '' },
            dataUrl: { type: String, default: '' },
        },
        /** Groups rows submitted together in one Add Bills Submit. */
        batchId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
            index: true,
        },
        /** Display: pending {name} accounts | pending {name} hr */
        pendingWithName: { type: String, default: '' },
        pendingWithRole: {
            type: String,
            enum: ['accounts', 'hr', ''],
            default: '',
        },
        /** company | employee | employee_and_company | employee_balance (legacy) */
        paymentBy: {
            type: String,
            enum: ['company', 'employee', 'employee_and_company', 'employee_balance'],
            default: undefined,
        },
        /** Selected party names for Pay By (UI dropdowns) */
        payByCompanyId: { type: String, default: '' },
        payByCompanyName: { type: String, default: '' },
        payByEmployeeId: { type: String, default: '' },
        payByEmployeeName: { type: String, default: '' },
        /** Totals owed (match TOTAL bar): company / employee pay */
        companyPayAmount: { type: Number, default: 0 },
        employeePayAmount: { type: Number, default: 0 },
        /** Pay-by difference shares (under/split UI); not the totals */
        companyDiffAmount: { type: Number, default: null },
        employeeDiffAmount: { type: Number, default: null },
        status: {
            type: String,
            enum: [
                'Pending Accounts',
                'Pending HR',
                'Approved',
                'Paid',
                'Rejected',
            ],
            default: 'Pending Accounts',
            index: true,
        },
        requestedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            default: null,
        },
        requestedByName: { type: String, default: '' },
        accountsApprovedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            default: null,
        },
        accountsApprovedAt: { type: Date, default: null },
        hrApprovedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            default: null,
        },
        hrApprovedAt: { type: Date, default: null },
        paidBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            default: null,
        },
        paidAt: { type: Date, default: null },
        actionedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            default: null,
        },
        actionedAt: { type: Date, default: null },
        comment: { type: String, default: '' },
        /** Zoho Books mapping (filled on add; bill created in Zoho when HR approves). */
        provider: { type: String, default: '' },
        billNumber: { type: String, default: '' },
        billDate: { type: String, default: '' },
        paymentDay: { type: Number, default: null },
        expenseAccountId: { type: String, default: '' },
        expenseAccountName: { type: String, default: '' },
        /**
         * Optional Zoho bill line items from Add more (Items · Account · Qty · Amount).
         * Sum of amounts must equal Actual; used on HR Approve → Zoho Bill.
         */
        zohoLineItems: {
            type: [
                {
                    item: { type: String, default: '' },
                    description: { type: String, default: '' },
                    accountId: { type: String, default: '' },
                    accountName: { type: String, default: '' },
                    quantity: { type: Number, default: 1 },
                    amount: { type: Number, default: 0 },
                    rate: { type: Number, default: 0 },
                    /** Payable to — employee on this item line (Acc2 / difference party). */
                    payBy: {
                        type: String,
                        enum: ['', 'company', 'employee'],
                        default: '',
                    },
                    payByEmployeeId: { type: String, default: '' },
                    payByEmployeeName: { type: String, default: '' },
                    payByCompanyId: { type: String, default: '' },
                    payByCompanyName: { type: String, default: '' },
                    /** Each item row creates its own Zoho bill. */
                    zohoBillId: { type: String, default: '' },
                },
            ],
            default: [],
        },
        /** Salary Payable / party COA matched by account_code to employeeId or companyId. */
        partyAccountId: { type: String, default: '' },
        partyAccountName: { type: String, default: '' },
        partyAccountCode: { type: String, default: '' },
        zohoVendorId: { type: String, default: '' },
        zohoBillId: { type: String, default: '', index: true },
        /** Zoho Books bill_number returned after the vendor bill is created. */
        zohoBillNumber: { type: String, default: '' },
        /** All Zoho bill ids when Add more created multiple item rows (1 row → 1 Zoho bill). */
        zohoBillIds: { type: [String], default: [] },
        /** draft = created in Zoho but not payable; open = Accounts can pay in Payments Made */
        zohoBillStatus: {
            type: String,
            enum: ['', 'draft', 'open'],
            default: '',
        },
        /** Which Zoho Books org this bill was synced to (multi-Zoho). */
        zohoOrganizationId: { type: String, default: '', index: true },
        zohoSyncedAt: { type: Date, default: null },
        zohoSyncError: { type: String, default: '' },
        /** Set when the ERP bill PDF/image was uploaded to the Zoho bill. */
        zohoAttachmentSyncedAt: { type: Date, default: null },
        zohoAttachmentName: { type: String, default: '' },
        /**
         * Zoho manual journal posted on HR approve when Difference ≠ 0:
         * Debit partyAccount (difference pay) · Credit expenseAccount (to vendor).
         */
        zohoDifferenceJournalId: { type: String, default: '' },
    },
    { timestamps: true },
);

utilityBillPaymentSchema.index({ entryId: 1, createdAt: -1 });
utilityBillPaymentSchema.index({ batchId: 1, status: 1 });

export default mongoose.model('UtilityBillPayment', utilityBillPaymentSchema);
