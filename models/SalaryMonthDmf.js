import mongoose from 'mongoose';
import { salaryDmfApprovalSchema } from './salaryDmfSchema.js';

const salaryMonthDmfSchema = new mongoose.Schema(
    {
        monthKey: { type: String, required: true, trim: true, unique: true },
        dmfApproval: { type: salaryDmfApprovalSchema, default: () => ({}) },
        zohoJournalUpdatedAt: { type: Date, default: null },
        zohoJournals: {
            type: [
                {
                    tabId: { type: String, default: '' },
                    organizationId: { type: String, default: '' },
                    organizationLabel: { type: String, default: '' },
                    status: { type: String, default: 'draft' },
                    journalId: { type: String, default: '' },
                    journalNumber: { type: String, default: '' },
                    journalDate: { type: String, default: '' },
                    reverseJournalDate: { type: String, default: '' },
                    publishReverseOnly: { type: Boolean, default: false },
                    referenceNumber: { type: String, default: '' },
                    notes: { type: String, default: '' },
                    reportingMethod: { type: String, default: 'both' },
                    currencyId: { type: String, default: '' },
                    locationId: { type: String, default: '' },
                    lineItems: { type: [mongoose.Schema.Types.Mixed], default: [] },
                },
            ],
            default: () => [],
        },
    },
    { timestamps: true },
);

export default mongoose.model('SalaryMonthDmf', salaryMonthDmfSchema);
