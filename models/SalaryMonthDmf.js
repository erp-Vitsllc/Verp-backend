import mongoose from 'mongoose';
import { salaryDmfApprovalSchema } from './salaryDmfSchema.js';

const salaryMonthDmfSchema = new mongoose.Schema(
    {
        monthKey: { type: String, required: true, trim: true, unique: true },
        dmfApproval: { type: salaryDmfApprovalSchema, default: () => ({}) },
    },
    { timestamps: true },
);

export default mongoose.model('SalaryMonthDmf', salaryMonthDmfSchema);
